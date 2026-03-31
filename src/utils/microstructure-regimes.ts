export type Regime =
  | "flow_dominance"
  | "momentum"
  | "breakout"
  | "reversal"
  | "liquidity_vacuum"
  | "expiry"
  | "chop";

export interface MarketSnapshot {
  bestBid: number;
  bestAsk: number;
  bestBidSize: number;
  bestAskSize: number;
  bidDepthTop3?: number;
  askDepthTop3?: number;
  timestamp: number;
  lastTradeSide?: "buy" | "sell";
  recentBuyVolume?: number;
  recentSellVolume?: number;
  recentEventCount?: number;
  roundEndTimestamp?: number;
  // Backward-compatible context used by existing decision path.
  downAsk?: number;
  roundStartTime?: number;
}

export interface RawFeatureSet {
  mid: number;
  spread: number;
  spreadPct: number;
  queueImbalance: number;
  depthImbalanceTop3: number;
  microprice: number;
  micropriceEdge: number;
  ofiRaw: number;
  ofiNorm: number;
  return1: number;
  realizedVol: number;
  eventRate: number;
  impactSensitivity: number;
  timeToExpiryMs: number;
  totalDepth: number;
  localRangeHigh: number;
  localRangeLow: number;
  breaksRangeUp: number;
  breaksRangeDown: number;
}

export interface NormalizedFeatureSet {
  raw: RawFeatureSet;
  zQueueImbalance: number;
  zDepthImbalanceTop3: number;
  zMicropriceEdge: number;
  zOfiNorm: number;
  zReturn1: number;
  zRealizedVol: number;
  zSpreadPct: number;
  zEventRate: number;
  zImpactSensitivity: number;
  pctSpreadPct: number;
  pctRealizedVol: number;
  pctEventRate: number;
  pctTotalDepth: number;
  pctImpactSensitivity: number;
}

export interface RegimeScoreSet {
  flow_dominance: number;
  momentum: number;
  breakout: number;
  reversal: number;
  liquidity_vacuum: number;
  expiry: number;
  chop: number;
}

export interface RegimeDetectorConfig {
  // ── Rolling windows (event-time) ──
  normalizationWindowEvents: number; // adaptive normalization base window
  localRangeWindowEvents: number; // local range high/low window
  persistenceWindowEvents: number; // directional persistence window
  signFlipWindowEvents: number; // sign flip window
  compressionLookbackEvents: number; // compression lookback window

  // ── Adaptive detection thresholds (score competition) ──
  minDirectionalRegimeScore: number;
  minBreakoutScore: number;
  minReversalScore: number;
  liquidityVacuumOverrideScore: number;
  expiryOverrideScore: number;
  minimumScoreMargin: number;
  regimeSwitchMargin: number;

  // ── Persistence guards (directional) ──
  minDirectionalPersistence: number;
  minFlowDominancePersistence: number;
  minMomentumPersistence: number;
  minBreakoutPersistence: number;
  minReversalPersistence: number;
  reversalConfirmationRequired: boolean;

  // ── Feature guidance thresholds (adaptive / z / ranks) ──
  flowDominanceOfiZ: number;
  flowDominanceQueueZ: number;
  flowDominanceMaxSpreadRank: number;
  momentumVolRankLo: number;
  momentumVolRankHi: number;
  momentumMaxSpreadRank: number;
  breakoutMinVolRank: number;
  breakoutMinEventRank: number;
  breakoutRangeBreakRequired: boolean;
  liquidityVacuumMinSpreadRank: number;
  liquidityVacuumMinSpreadZ: number;
  liquidityVacuumMaxDepthRank: number;
  liquidityVacuumMinImpactRank: number;
  expiryThresholdMs: number;
  expiryExtraCautionSpreadRank: number;

  // ── Hard trading safety gates (absolute-ish) ──
  // These are NOT used to pick regimes. They are used to restrict/disable
  // directional trading even if a directional regime is detected.
  maxSpreadPctForAggressiveEntry: number;
  minDepthRankForAggressiveEntry: number;
  minRegimeConfidenceForDirectionalTrade: number;
  minScoreMarginForDirectionalTrade: number;
  disableDirectionalTradingInLiquidityVacuum: boolean;
  restrictExpiryTrading: boolean;

  // ── Live tuning parameters ──
  signDeadband: number;
  targetFlipRate: number;
  rangeBreakMarginBps: number;
}

export interface RegimeDetectionResult {
  regime: Regime;
  scores: RegimeScoreSet;
  bestScore: number;
  scoreMargin: number;
  previousRegime: Regime | null;
  selectionMethod: "override" | "competition" | "fallback" | "hysteresis_hold";

  // Diagnostics: explicit reasons so logs are calibratable.
  overrideReason?: string;
  blockedByThresholdReason?: string;
  insufficientMarginReason?: string;
  insufficientPersistenceReason?: string;
  confirmationPendingReason?: string;
}

const EPS = 1e-9;

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function signOrZero(x: number, deadband: number): -1 | 0 | 1 {
  if (Math.abs(x) <= deadband) return 0;
  return x > 0 ? 1 : -1;
}

function normalizedBandScore(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  if (value < low || value > high) return 0;
  const center = (low + high) / 2;
  const half = (high - low) / 2;
  return clamp01(1 - Math.abs(value - center) / Math.max(half, EPS));
}

function alignmentScore(ofiNormZ: number, queueImbalanceZ: number, micropriceEdgeZ: number, deadband: number): number {
  const so = signOrZero(ofiNormZ, deadband);
  const sq = signOrZero(queueImbalanceZ, deadband);
  const sm = signOrZero(micropriceEdgeZ, deadband);
  if (so === 0 || sq === 0 || sm === 0) return 0;
  return so === sq && sq === sm ? 1 : 0;
}

function rangeBreakScore(raw: RawFeatureSet): number {
  const broke = Math.max(raw.breaksRangeUp, raw.breaksRangeDown);
  return broke > 0 ? 1 : 0;
}

function persistenceRatio(signs: readonly number[], lookback: number, direction: -1 | 0 | 1): number {
  if (direction === 0 || lookback <= 0 || signs.length === 0) return 0;
  const slice = signs.slice(-lookback);
  if (slice.length === 0) return 0;
  let aligned = 0;
  for (const s of slice) if (s === direction) aligned++;
  return aligned / slice.length;
}

function signFlipRate(signs: readonly number[], lookback: number): number {
  if (lookback <= 1 || signs.length < 2) return 0;
  const slice = signs.slice(-(lookback + 1));
  let flips = 0;
  let comps = 0;
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1];
    const b = slice[i];
    if (a === 0 || b === 0) continue;
    comps++;
    if (a !== b) flips++;
  }
  return comps > 0 ? flips / comps : 0;
}

/**
 * MicrostructureFeatureEngine (lightweight)
 * Produces rolling-normalized features for adaptive regime detection.
 *
 * Why these matter (vs price-only signals):
 * - OFI: captures aggressive flow imbalance; often leads mid changes at short horizon.
 * - Queue/depth imbalance: reveals which side is thin or absorbing; impacts next-tick drift.
 * - Spread state: proxy for liquidity + execution risk; wide spread regimes are toxic.
 * - Event intensity: distinguishes real moves from quiet drift; helps detect breakouts/vacuums.
 */
export class MicrostructureFeatureEngine {
  private readonly mids: number[] = [];
  private readonly returns: number[] = [];
  private readonly spreadPct: number[] = [];
  private readonly eventCounts: number[] = [];
  private readonly eventRateSeries: number[] = [];
  private readonly ofiNorm: number[] = [];
  private readonly queueImb: number[] = [];
  private readonly depthImb: number[] = [];
  private readonly microEdge: number[] = [];
  private readonly realizedVol: number[] = [];
  private readonly impact: number[] = [];
  private readonly totalDepth: number[] = [];
  private lastMid: number | null = null;

  constructor(private readonly cfg: Pick<RegimeDetectorConfig, "normalizationWindowEvents" | "localRangeWindowEvents">) {}

  update(snapshot: MarketSnapshot): NormalizedFeatureSet {
    const bidDepthTop3 = Math.max(snapshot.bidDepthTop3 ?? snapshot.bestBidSize, 0);
    const askDepthTop3 = Math.max(snapshot.askDepthTop3 ?? snapshot.bestAskSize, 0);
    const buyVol = Math.max(snapshot.recentBuyVolume ?? 0, 0);
    const sellVol = Math.max(snapshot.recentSellVolume ?? 0, 0);
    const eventCount = Math.max(snapshot.recentEventCount ?? 1, 0);

    const mid = (snapshot.bestBid + snapshot.bestAsk) / 2;
    const spread = Math.max(snapshot.bestAsk - snapshot.bestBid, 0);
    const spreadPctNow = spread / Math.max(mid, EPS);
    const queueImbalance = (snapshot.bestBidSize - snapshot.bestAskSize) / Math.max(snapshot.bestBidSize + snapshot.bestAskSize, EPS);
    const depthImbalanceTop3 = (bidDepthTop3 - askDepthTop3) / Math.max(bidDepthTop3 + askDepthTop3, EPS);
    const topSize = snapshot.bestBidSize + snapshot.bestAskSize;
    const microprice =
      topSize > 0
        ? (snapshot.bestAsk * snapshot.bestBidSize + snapshot.bestBid * snapshot.bestAskSize) / topSize
        : mid;
    const micropriceEdge = (microprice - mid) / Math.max(mid, EPS);
    const ofiRaw = buyVol - sellVol;
    const ofiNormNow = ofiRaw / Math.max(buyVol + sellVol, EPS);

    const ret1 = this.lastMid !== null ? (mid - this.lastMid) / Math.max(this.lastMid, EPS) : 0;
    this.lastMid = mid;

    const range = this.localRangeFromHistory();

    this.push(this.mids, mid);
    this.push(this.returns, ret1);
    const vol = this.std(this.returns);
    this.push(this.realizedVol, vol);
    this.push(this.spreadPct, spreadPctNow);
    this.push(this.eventCounts, eventCount);
    this.push(this.ofiNorm, ofiNormNow);
    this.push(this.queueImb, queueImbalance);
    this.push(this.depthImb, depthImbalanceTop3);
    this.push(this.microEdge, micropriceEdge);
    const impactSensitivity = Math.abs(this.deltaMid()) / Math.max(Math.abs(ofiRaw), EPS);
    this.push(this.impact, impactSensitivity);
    const depth = bidDepthTop3 + askDepthTop3;
    this.push(this.totalDepth, depth);
    const eventRateNow = this.avg(this.eventCounts);
    this.push(this.eventRateSeries, eventRateNow);

    const raw: RawFeatureSet = {
      mid,
      spread,
      spreadPct: spreadPctNow,
      queueImbalance,
      depthImbalanceTop3,
      microprice,
      micropriceEdge,
      ofiRaw,
      ofiNorm: ofiNormNow,
      return1: ret1,
      realizedVol: vol,
      eventRate: eventRateNow,
      impactSensitivity,
      timeToExpiryMs: Math.max((snapshot.roundEndTimestamp ?? snapshot.timestamp) - snapshot.timestamp, 0),
      totalDepth: depth,
      localRangeHigh: range.high,
      localRangeLow: range.low,
      breaksRangeUp: range.hasWindow && mid > range.high ? 1 : 0,
      breaksRangeDown: range.hasWindow && mid < range.low ? 1 : 0,
    };

    return {
      raw,
      zQueueImbalance: this.z(this.queueImb, queueImbalance),
      zDepthImbalanceTop3: this.z(this.depthImb, depthImbalanceTop3),
      zMicropriceEdge: this.z(this.microEdge, micropriceEdge),
      zOfiNorm: this.z(this.ofiNorm, ofiNormNow),
      zReturn1: this.z(this.returns, ret1),
      zRealizedVol: this.z(this.realizedVol, vol),
      zSpreadPct: this.z(this.spreadPct, spreadPctNow),
      zEventRate: this.z(this.eventRateSeries, eventRateNow),
      zImpactSensitivity: this.z(this.impact, impactSensitivity),
      pctSpreadPct: this.pct(this.spreadPct, spreadPctNow),
      pctRealizedVol: this.pct(this.realizedVol, vol),
      pctEventRate: this.pct(this.eventRateSeries, eventRateNow),
      pctTotalDepth: this.pct(this.totalDepth, depth),
      pctImpactSensitivity: this.pct(this.impact, impactSensitivity),
    };
  }

  private push(arr: number[], x: number): void {
    arr.push(x);
    if (arr.length > this.cfg.normalizationWindowEvents) arr.shift();
  }

  private localRangeFromHistory(): { high: number; low: number; hasWindow: boolean } {
    const look = this.mids.slice(-this.cfg.localRangeWindowEvents);
    if (look.length === 0) return { high: 0, low: 0, hasWindow: false };
    let high = look[0];
    let low = look[0];
    for (const v of look) {
      if (v > high) high = v;
      if (v < low) low = v;
    }
    return { high, low, hasWindow: true };
  }

  private deltaMid(): number {
    if (this.mids.length < 2) return 0;
    return this.mids[this.mids.length - 1] - this.mids[this.mids.length - 2];
  }

  private avg(arr: readonly number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private std(arr: readonly number[]): number {
    if (arr.length < 2) return 0;
    const m = this.avg(arr);
    const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
    return Math.sqrt(v);
  }

  private z(arr: readonly number[], x: number): number {
    if (arr.length < 2) return 0;
    const m = this.avg(arr);
    const sd = Math.max(this.std(arr), EPS);
    return (x - m) / sd;
  }

  private pct(arr: readonly number[], x: number): number {
    if (arr.length === 0) return 0.5;
    let c = 0;
    for (const v of arr) if (v <= x) c++;
    return c / arr.length;
  }

  reset(): void {
    this.mids.length = 0;
    this.returns.length = 0;
    this.spreadPct.length = 0;
    this.eventCounts.length = 0;
    this.eventRateSeries.length = 0;
    this.ofiNorm.length = 0;
    this.queueImb.length = 0;
    this.depthImb.length = 0;
    this.microEdge.length = 0;
    this.realizedVol.length = 0;
    this.impact.length = 0;
    this.totalDepth.length = 0;
    this.lastMid = null;
  }
}

export class RegimeDetector {
  readonly config: RegimeDetectorConfig;

  private prevRegime: Regime | null = null;
  private pendingReversalConfirm = false;

  private spreadRankHist: number[] = [];
  private volRankHist: number[] = [];
  private signHistory: number[] = [];

  constructor(cfg?: Partial<RegimeDetectorConfig>) {
    this.config = {
      // Rolling windows
      normalizationWindowEvents: 200,
      localRangeWindowEvents: 50,
      persistenceWindowEvents: 5,
      signFlipWindowEvents: 8,
      compressionLookbackEvents: 30,

      // Selection thresholds
      minDirectionalRegimeScore: 0.65,
      minBreakoutScore: 0.68,
      minReversalScore: 0.67,
      liquidityVacuumOverrideScore: 0.70,
      expiryOverrideScore: 0.75,
      minimumScoreMargin: 0.10,
      regimeSwitchMargin: 0.08,

      // Directional persistence
      minDirectionalPersistence: 0.60,
      minFlowDominancePersistence: 0.60,
      minMomentumPersistence: 0.60,
      minBreakoutPersistence: 0.50,
      minReversalPersistence: 0.40,
      reversalConfirmationRequired: true,

      // Suggested feature guidance
      flowDominanceOfiZ: 1.2,
      flowDominanceQueueZ: 0.8,
      flowDominanceMaxSpreadRank: 0.80,
      momentumVolRankLo: 0.30,
      momentumVolRankHi: 0.85,
      momentumMaxSpreadRank: 0.75,
      breakoutMinVolRank: 0.80,
      breakoutMinEventRank: 0.75,
      breakoutRangeBreakRequired: true,
      liquidityVacuumMinSpreadRank: 0.90,
      liquidityVacuumMinSpreadZ: 1.5,
      liquidityVacuumMaxDepthRank: 0.20,
      liquidityVacuumMinImpactRank: 0.80,
      expiryThresholdMs: 20_000,
      expiryExtraCautionSpreadRank: 0.80,

      // Hard safety gates for trading
      maxSpreadPctForAggressiveEntry: 0.08,
      minDepthRankForAggressiveEntry: 0.25,
      minRegimeConfidenceForDirectionalTrade: 0.70,
      minScoreMarginForDirectionalTrade: 0.10,
      disableDirectionalTradingInLiquidityVacuum: true,
      restrictExpiryTrading: true,

      // Live tuning
      signDeadband: 0.05,
      targetFlipRate: 0.50,
      rangeBreakMarginBps: 2,

      ...cfg,
    };
  }

  detect(f: NormalizedFeatureSet): RegimeDetectionResult {
    const cfg = this.config;

    this.pushHist(this.spreadRankHist, f.pctSpreadPct);
    this.pushHist(this.volRankHist, f.pctRealizedVol);
    const compressionLook = Math.min(cfg.compressionLookbackEvents, this.spreadRankHist.length, this.volRankHist.length);
    let compressionScore = 0;
    if (compressionLook > 0) {
      for (let i = 0; i < compressionLook; i++) {
        const idx = this.spreadRankHist.length - 1 - i;
        compressionScore += clamp01((1 - this.spreadRankHist[idx]) * (1 - this.volRankHist[idx]));
      }
      compressionScore /= compressionLook;
    }

    const align = alignmentScore(f.zOfiNorm, f.zQueueImbalance, f.zMicropriceEdge, cfg.signDeadband);
    const dominantSign = signOrZero(f.zOfiNorm + f.zQueueImbalance + f.zMicropriceEdge, cfg.signDeadband);
    this.pushHist(this.signHistory, dominantSign);
    const persistenceScore = persistenceRatio(this.signHistory, cfg.persistenceWindowEvents, dominantSign);
    const flipRate = signFlipRate(this.signHistory, cfg.signFlipWindowEvents);

    // NOTE: The score formulas are intentionally adaptive (z/rank) and conservative.
    // Absolute gates live in config.safety* and are not used for regime selection.

    const flowDominanceScore =
      0.45 * clamp01(Math.abs(f.zOfiNorm) / 2.0) +
      0.25 * clamp01(Math.abs(f.zQueueImbalance) / 1.5) +
      0.10 * clamp01(Math.abs(f.zMicropriceEdge) / 1.5) +
      0.10 * persistenceScore +
      0.10 * align;

    const momentumScore =
      0.25 * clamp01(Math.abs(f.zOfiNorm) / 1.6) +
      0.20 * clamp01(Math.abs(f.zQueueImbalance) / 1.4) +
      0.15 * clamp01(Math.abs(f.zReturn1) / 1.5) +
      0.10 * clamp01(Math.abs(f.zMicropriceEdge) / 1.4) +
      0.15 * persistenceScore +
      0.15 * normalizedBandScore(f.pctRealizedVol, 0.30, 0.85);

    const breakoutScore =
      0.25 * clamp01(compressionScore) +
      0.20 * clamp01(f.zRealizedVol / 2.0) +
      0.15 * clamp01(f.zEventRate / 2.0) +
      0.15 * clamp01(Math.abs(f.zOfiNorm) / 1.5) +
      0.10 * clamp01(Math.abs(f.zQueueImbalance) / 1.3) +
      0.15 * rangeBreakScore(f.raw);

    const reversalScore =
      0.30 * clamp01(1 - clamp01(Math.abs(f.zOfiNorm) / 1.2)) +
      0.25 * (align === 1 ? 0 : 1) +
      0.15 * clamp01(f.pctRealizedVol) +
      0.10 * 0 +
      0.10 * clamp01(f.pctEventRate) +
      0.10 * clamp01(1 - persistenceScore);

    const liquidityVacuumScore =
      0.40 * clamp01(f.pctSpreadPct) +
      0.30 * clamp01(1 - f.pctTotalDepth) +
      0.20 * clamp01(f.pctImpactSensitivity) +
      0.10 * clamp01(f.pctRealizedVol);

    const expiryUrgency = clamp01(1 - f.raw.timeToExpiryMs / cfg.expiryThresholdMs);
    const expiryScore =
      0.65 * expiryUrgency +
      0.15 * clamp01(f.pctSpreadPct) +
      0.10 * clamp01(f.pctEventRate) +
      0.10 * clamp01(Math.abs(f.zQueueImbalance) / 1.5);

    const lowPressureScore =
      ((1 - clamp01(Math.abs(f.zOfiNorm) / 1.0)) +
        (1 - clamp01(Math.abs(f.zQueueImbalance) / 1.0)) +
        (1 - clamp01(Math.abs(f.zMicropriceEdge) / 1.0))) /
      3;
    const chopScore =
      0.35 * lowPressureScore +
      0.25 * clamp01(flipRate / Math.max(cfg.targetFlipRate, EPS)) +
      0.20 * clamp01(1 - persistenceScore) +
      0.10 * normalizedBandScore(f.pctRealizedVol, 0.25, 0.75) +
      0.10 * clamp01(1 - Math.abs(f.zReturn1) / 1.0);

    const scores: RegimeScoreSet = {
      flow_dominance: flowDominanceScore,
      momentum: momentumScore,
      breakout: breakoutScore,
      reversal: reversalScore,
      liquidity_vacuum: liquidityVacuumScore,
      expiry: expiryScore,
      chop: chopScore,
    };

    // Overrides first (safety regimes)
    if (scores.liquidity_vacuum >= cfg.liquidityVacuumOverrideScore) {
      const res: RegimeDetectionResult = {
        regime: "liquidity_vacuum",
        scores,
        bestScore: scores.liquidity_vacuum,
        scoreMargin: 1,
        previousRegime: this.prevRegime,
        selectionMethod: "override",
        overrideReason: "liquidityVacuumOverrideScore",
      };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }

    if (scores.expiry >= cfg.expiryOverrideScore) {
      const res: RegimeDetectionResult = {
        regime: "expiry",
        scores,
        bestScore: scores.expiry,
        scoreMargin: 1,
        previousRegime: this.prevRegime,
        selectionMethod: "override",
        overrideReason: "expiryOverrideScore",
      };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }

    // Competition
    const ranked = (Object.entries(scores) as Array<[Regime, number]>).sort((a, b) => b[1] - a[1]);
    const [bestRegime, bestScore] = ranked[0];
    const secondScore = ranked[1]?.[1] ?? 0;
    const margin = bestScore - secondScore;

    let chosen: Regime = "chop";
    let method: RegimeDetectionResult["selectionMethod"] = "fallback";
    const base: Omit<RegimeDetectionResult, "regime" | "selectionMethod"> = {
      scores,
      bestScore,
      scoreMargin: margin,
      previousRegime: this.prevRegime,
    };

    if (margin < cfg.minimumScoreMargin) {
      const res: RegimeDetectionResult = {
        ...base,
        regime: "chop",
        selectionMethod: "fallback",
        insufficientMarginReason: `margin ${margin.toFixed(3)} < ${cfg.minimumScoreMargin.toFixed(2)}`,
      };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }

    // Directional persistence guardrails (detection layer)
    if (bestRegime === "breakout" && bestScore < cfg.minBreakoutScore) {
      const res: RegimeDetectionResult = { ...base, regime: "chop", selectionMethod: "fallback", blockedByThresholdReason: "minBreakoutScore" };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }
    if (bestRegime === "reversal" && bestScore < cfg.minReversalScore) {
      const res: RegimeDetectionResult = { ...base, regime: "chop", selectionMethod: "fallback", blockedByThresholdReason: "minReversalScore" };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }
    if (bestRegime !== "chop" && bestRegime !== "expiry" && bestRegime !== "liquidity_vacuum" && bestScore < cfg.minDirectionalRegimeScore) {
      const res: RegimeDetectionResult = { ...base, regime: "chop", selectionMethod: "fallback", blockedByThresholdReason: "minDirectionalRegimeScore" };
      this.prevRegime = res.regime;
      this.pendingReversalConfirm = false;
      return res;
    }

    // Feature guidance checks (lightweight, configurable)
    if (bestRegime === "flow_dominance") {
      if (
        Math.abs(f.zOfiNorm) < cfg.flowDominanceOfiZ ||
        Math.abs(f.zQueueImbalance) < cfg.flowDominanceQueueZ ||
        f.pctSpreadPct > cfg.flowDominanceMaxSpreadRank
      ) {
        const res: RegimeDetectionResult = {
          ...base,
          regime: "chop",
          selectionMethod: "fallback",
          blockedByThresholdReason: "flow_dominance guidance failed",
        };
        this.prevRegime = res.regime;
        this.pendingReversalConfirm = false;
        return res;
      }
    }
    if (bestRegime === "momentum") {
      if (
        f.pctRealizedVol < cfg.momentumVolRankLo ||
        f.pctRealizedVol > cfg.momentumVolRankHi ||
        f.pctSpreadPct > cfg.momentumMaxSpreadRank
      ) {
        const res: RegimeDetectionResult = {
          ...base,
          regime: "chop",
          selectionMethod: "fallback",
          blockedByThresholdReason: "momentum guidance failed",
        };
        this.prevRegime = res.regime;
        this.pendingReversalConfirm = false;
        return res;
      }
    }
    if (bestRegime === "breakout") {
      if (
        f.pctRealizedVol < cfg.breakoutMinVolRank ||
        f.pctEventRate < cfg.breakoutMinEventRank ||
        (cfg.breakoutRangeBreakRequired && rangeBreakScore(f.raw) < 1)
      ) {
        const res: RegimeDetectionResult = {
          ...base,
          regime: "chop",
          selectionMethod: "fallback",
          blockedByThresholdReason: "breakout guidance failed",
        };
        this.prevRegime = res.regime;
        this.pendingReversalConfirm = false;
        return res;
      }
    }

    // Directional persistence guardrails (explicit reason for diagnostics)
    if (this.isDirectional(bestRegime)) {
      const required = bestRegime === "flow_dominance"
        ? cfg.minFlowDominancePersistence
        : bestRegime === "momentum"
          ? cfg.minMomentumPersistence
          : bestRegime === "breakout"
            ? cfg.minBreakoutPersistence
            : cfg.minReversalPersistence;
      const needed = Math.max(required, cfg.minDirectionalPersistence);
      if (persistenceScore < needed) {
        const res: RegimeDetectionResult = {
          ...base,
          regime: "chop",
          selectionMethod: "fallback",
          insufficientPersistenceReason: `persistence ${persistenceScore.toFixed(3)} < ${needed.toFixed(2)}`,
        };
        this.prevRegime = res.regime;
        this.pendingReversalConfirm = false;
        return res;
      }
    }

    // Reversal confirmation: require one confirmation event (conservative)
    if (bestRegime === "reversal" && cfg.reversalConfirmationRequired) {
      if (!this.pendingReversalConfirm) {
        this.pendingReversalConfirm = true;
        const res: RegimeDetectionResult = {
          ...base,
          regime: "chop",
          selectionMethod: "fallback",
          confirmationPendingReason: "reversal confirmation required",
        };
        this.prevRegime = res.regime;
        return res;
      }
      this.pendingReversalConfirm = false;
    } else {
      this.pendingReversalConfirm = false;
    }

    chosen = bestRegime;
    method = "competition";

    // Hysteresis between directional regimes
    if (this.prevRegime && this.prevRegime !== chosen && this.isDirectional(this.prevRegime) && this.isDirectional(chosen)) {
      const prevScore = scores[this.prevRegime];
      if (bestScore < prevScore + cfg.regimeSwitchMargin) {
        const res: RegimeDetectionResult = {
          ...base,
          regime: this.prevRegime,
          selectionMethod: "hysteresis_hold",
        };
        return res;
      }
    }

    const res: RegimeDetectionResult = { ...base, regime: chosen, selectionMethod: method };
    this.prevRegime = res.regime;
    return res;
  }

  private isDirectional(r: Regime): boolean {
    return r === "flow_dominance" || r === "momentum" || r === "breakout" || r === "reversal";
  }

  private pushHist(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length > this.config.normalizationWindowEvents) arr.shift();
  }

  reset(): void {
    this.prevRegime = null;
    this.pendingReversalConfirm = false;
    this.spreadRankHist.length = 0;
    this.volRankHist.length = 0;
    this.signHistory.length = 0;
  }
}

