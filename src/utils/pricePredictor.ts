import { logger } from "./logger";
import { EXECUTION_RISK_SMALL_TRADE_FLOW_DOM_SCORE } from "./execution-risk-gate";
import { PredictionDiagnostics } from "./diagnostics";
import { RegimeDiagnostics } from "./regime-diagnostics";
import {
    MicrostructureFeatureEngine,
    RegimeDetector as MicroRegimeDetector,
} from "./microstructure-regimes";
import type {
    Regime,
    MarketSnapshot,
    NormalizedFeatureSet,
    RegimeDetectionResult,
} from "./microstructure-regimes";

export type { MarketSnapshot } from "./microstructure-regimes";
export type MarketRegime = Regime;

export interface PricePrediction {
    predictedPrice: number;
    confidence: number;
    direction: "up" | "down";
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    features: {
        momentum: number;
        volatility: number;
        trend: number;
    };
    isPoleValue?: boolean;
    pUp: number;
    pDown: number;
    edgeBuyUp: number;
    edgeBuyDown: number;
    rawScore: number;
    regime: MarketRegime;
    regimeConfidence: number;
    regimeScoreMargin: number;
    blockedBySafetyGate?: boolean;
    safetyBlockReason?: string;
}

function snapshotSpread(s: MarketSnapshot): number {
    return Math.max(0, s.bestAsk - s.bestBid);
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════════════════

interface FeatureVector {
    // ── Legacy features (price-derived) ──
    priceLag1: number;
    priceLag2: number;
    priceLag3: number;
        momentum: number;
        volatility: number;
        trend: number;

    // ── Microstructure features (orderbook-derived) ──
    // Spread: wider spread = less liquidity, higher uncertainty. [0, 1]
    spread: number;
    // Microprice: size-weighted fair value. Better than mid when book is asymmetric. [0, 1]
    microprice: number;
    // Book imbalance: (bidSize - askSize) / (bidSize + askSize). Buy pressure indicator. [-1, 1]
    bookImbalance: number;
    // Down-ask delta: upAsk - (1 - downAsk). Non-zero = cross-leg mispricing. [-1, 1]
    downAskDelta: number;
    // Time remaining: fraction of 5-min round elapsed. Near 1 = expiry imminent. [0, 1]
    timeRemaining: number;
    // Quote intensity: EMA-smoothed rate of quote updates per second. [0, 1]
    quoteIntensity: number;
}

interface ModelWeights {
    intercept: number;
    // Legacy
    priceLag1: number;
    priceLag2: number;
    priceLag3: number;
    momentum: number;
    volatility: number;
    trend: number;
    // Microstructure (initialized to zero — no behavior change on deploy)
    spread: number;
    microprice: number;
    bookImbalance: number;
    downAskDelta: number;
    timeRemaining: number;
    quoteIntensity: number;
}

interface AccuracyRecord {
    correct: boolean;
    confidence: number;
}

/**
 * Stores a prediction that has been made but not yet evaluated.
 * The prediction is scored against the next observed pole price (the "outcome").
 * This is the mechanism that prevents label leakage: features and predicted
 * values are frozen at prediction time, and only evaluated once the future
 * outcome actually arrives.
 */
interface PendingPrediction {
    features: FeatureVector;
    predictedPrice: number;
    basePrice: number;          // smoothed price at prediction time (for direction evaluation)
    confidence: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ═══════════════════════════════════════════════════════════════════════════
// PoleDetector
// Identifies local peaks and troughs in the smoothed price history.
// A prediction is only emitted when a new pole is detected.
// ═══════════════════════════════════════════════════════════════════════════

class PoleDetector {
    private history: Array<{ price: number; type: "peak" | "trough"; timestamp: number }> = [];
    private _lastPrice: number | null = null;
    private _lastType: "peak" | "trough" | null = null;

    private static readonly MAX_HISTORY = 10;

    get lastPoleType(): "peak" | "trough" | null {
        return this._lastType;
    }

    /**
     * Returns true if the latest entry in `priceHistory` is a local
     * peak or trough that qualifies as a new pole.
     * TODO: this checks the latest point as the extremum (aggressive). A confirmatory
     *       approach would wait one more point to verify the reversal.
     */
    detect(priceHistory: readonly number[], timestamp: number, noiseThreshold: number): boolean {
        if (priceHistory.length < 3) return false;

        const n = priceHistory.length;
        const idx = n - 1;
        const price = priceHistory[idx];
        if (idx < 2) return false;

        let isPeak = true;
        let isTrough = true;
        const lookback = Math.min(3, idx);
        for (let i = idx - lookback; i < idx; i++) {
            if (priceHistory[i] >= price) isPeak = false;
            if (priceHistory[i] <= price) isTrough = false;
        }

        if (!isPeak && !isTrough) return false;

        const type: "peak" | "trough" = isPeak ? "peak" : "trough";

        if (this._lastPrice === null) {
            this.record(price, type, timestamp);
            return true;
        }

        const changeFromLast = Math.abs(price - this._lastPrice);
        const isDifferentType = type !== this._lastType;

        if (changeFromLast >= noiseThreshold || isDifferentType) {
            this.record(price, type, timestamp);
            return true;
        }

        return false;
    }

    private record(price: number, type: "peak" | "trough", timestamp: number): void {
        this._lastPrice = price;
        this._lastType = type;
        this.history.push({ price, type, timestamp });
        if (this.history.length > PoleDetector.MAX_HISTORY) this.history.shift();
    }

    reset(): void {
        this.history = [];
        this._lastPrice = null;
        this._lastType = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FeatureExtractor
// Owns EMA state and normalization statistics.
// Extracts a 12-dimensional feature vector from price history + snapshot.
// ═══════════════════════════════════════════════════════════════════════════

class FeatureExtractor {
    private priceMean = 0.5;
    private priceStd = 0.1;
    private emaShort = 0.5;
    private emaLong = 0.5;

    // EMA-smoothed quote update rate (updates per second)
    private quoteEma = 0;
    private lastQuoteTimestamp: number | null = null;
    private static readonly QUOTE_EMA_ALPHA = 0.3;

    private static readonly ALPHA_SHORT = 2 / (2 + 1);
    private static readonly ALPHA_LONG = 2 / (5 + 1);
    private static readonly VOL_WINDOW = 5;
    private static readonly ROUND_DURATION_MS = 5 * 60 * 1000;

    /**
     * Legacy extraction path: price-only, microstructure features set to neutral.
     */
    extract(priceHistory: readonly number[]): FeatureVector {
        return this.extractWithSnapshot(priceHistory, null);
    }

    /**
     * Full extraction: legacy price features + microstructure features from snapshot.
     * When snapshot is null, microstructure features default to neutral values
     * (0 or 0.5) so the model output is unchanged from legacy behavior.
     */
    extractWithSnapshot(priceHistory: readonly number[], snapshot: MarketSnapshot | null): FeatureVector {
        const n = priceHistory.length;
        const cur = priceHistory[n - 1];
        const lag1 = n >= 2 ? priceHistory[n - 2] : cur;
        const lag2 = n >= 3 ? priceHistory[n - 3] : lag1;
        const lag3 = n >= 4 ? priceHistory[n - 4] : lag2;

        const momentum = this.computeMomentum(cur, lag1, lag2, n);
        // TODO: trend component weights (0.4 / 0.4 / 0.2) should be configurable
        const trend = this.computeTrend(cur, lag2, momentum, n);
        const volatility = this.computeVolatility(priceHistory);

        return {
            // ── Legacy features ──
            priceLag1: this.normalizePrice(lag1),
            priceLag2: this.normalizePrice(lag2),
            priceLag3: this.normalizePrice(lag3),
            // TODO: normalization scaling constants (5x, 10x) should be derived from data
            momentum: clamp(momentum, -1, 1),
            volatility: Math.min(1, volatility * 5),
            trend: clamp(trend * 10, -1, 1),

            // ── Microstructure features ──
            spread: this.computeSpread(snapshot),
            microprice: this.computeMicroprice(snapshot),
            bookImbalance: this.computeBookImbalance(snapshot),
            downAskDelta: this.computeDownAskDelta(snapshot),
            timeRemaining: this.computeTimeRemaining(snapshot),
            quoteIntensity: this.computeQuoteIntensity(),
        };
    }

    private computeMomentum(current: number, lag1: number, lag2: number, n: number): number {
        const shortMom = lag1 > 0 ? (current - lag1) / lag1 : 0;
        if (n < 4) return shortMom;

        const longMom = (current - lag2) / (lag2 + 0.0001);
        const sameSign = (shortMom > 0 && longMom > 0) || (shortMom < 0 && longMom < 0);
        return sameSign ? (shortMom + longMom) / 2 : shortMom;
    }

    private computeTrend(current: number, lag2: number, momentum: number, n: number): number {
        const emaTrend = this.emaShort - this.emaLong;
        const momTrend = momentum * 0.5;
        const priceTrend = n >= 3 ? (current - lag2) / (lag2 + 0.0001) * 0.3 : 0;
        return emaTrend * 0.4 + momTrend * 0.4 + priceTrend * 0.2;
    }

    private computeVolatility(priceHistory: readonly number[]): number {
        if (priceHistory.length < 3) return 0;
        const recent = priceHistory.slice(-FeatureExtractor.VOL_WINDOW);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((sum, p) => sum + (p - mean) ** 2, 0) / recent.length;
        return Math.sqrt(variance);
    }

    /** Must be called AFTER extract() so that the current observation's EMA is not used for its own trend. */
    updateEMA(price: number): void {
        if (this.emaShort === 0.5 && this.emaLong === 0.5) {
            this.emaShort = price;
            this.emaLong = price;
        } else {
            this.emaShort = FeatureExtractor.ALPHA_SHORT * price + (1 - FeatureExtractor.ALPHA_SHORT) * this.emaShort;
            this.emaLong = FeatureExtractor.ALPHA_LONG * price + (1 - FeatureExtractor.ALPHA_LONG) * this.emaLong;
        }
    }

    /** Must be called BEFORE extract() so that normalization uses up-to-date statistics. */
    updateStatistics(priceHistory: readonly number[]): void {
        if (priceHistory.length === 0) return;
        this.priceMean = priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length;
        const variance = priceHistory.reduce((sum, p) => sum + (p - this.priceMean) ** 2, 0) / priceHistory.length;
        this.priceStd = Math.sqrt(variance);
        if (this.priceStd < 0.001) this.priceStd = 0.1;
    }

    normalizePrice(price: number): number {
        const z = (price - this.priceMean) / this.priceStd;
        return clamp((z + 3) / 6, 0, 1);
    }

    denormalizePrice(normalized: number): number {
        return (normalized * 6 - 3) * this.priceStd + this.priceMean;
    }

    // ── Microstructure feature computations ──
    // Each returns a neutral value when the snapshot field is unavailable,
    // so the model degrades gracefully to legacy behavior.

    /**
     * Spread: ask - bid, normalized to [0, 1].
     * Wider spread = less liquidity, more uncertainty.
     * Cap at 0.5 (50 cents on a [0,1] market) — beyond that is degenerate.
     */
    private computeSpread(snap: MarketSnapshot | null): number {
        if (!snap) return 0;
        return clamp(snapshotSpread(snap) / 0.5, 0, 1);
    }

    /**
     * Microprice: size-weighted fair value.
     * microprice = (bid * askSize + ask * bidSize) / (bidSize + askSize)
     * Better than mid when the book is asymmetric. Falls back to mid, then 0.5.
     * Output is normalized to [0, 1] using the same z-score as price lags.
     */
    private computeMicroprice(snap: MarketSnapshot | null): number {
        if (!snap) return 0.5;

        let rawMicroprice: number;
        const bs = snap.bestBidSize + snap.bestAskSize;
        if (bs > 0 && snap.bestAsk > 0) {
            rawMicroprice =
                (snap.bestBid * snap.bestAskSize + snap.bestAsk * snap.bestBidSize) / bs;
        } else {
            rawMicroprice = (snap.bestBid + snap.bestAsk) / 2;
        }

        return this.normalizePrice(rawMicroprice);
    }

    /**
     * Book imbalance: (bidSize - askSize) / (bidSize + askSize).
     * Positive = buy pressure (more resting bids). [-1, 1] naturally.
     * Neutral (0) when sizes are unavailable.
     */
    private computeBookImbalance(snap: MarketSnapshot | null): number {
        if (!snap) return 0;
        const total = snap.bestBidSize + snap.bestAskSize;
        if (total <= 0) return 0;
        return clamp((snap.bestBidSize - snap.bestAskSize) / total, -1, 1);
    }

    /**
     * Down-ask delta: upAsk - (1 - downAsk).
     * In a perfect market upAsk + downAsk = 1, so delta = 0.
     * Non-zero means cross-leg mispricing / arbitrage pressure.
     * Normalized by dividing by 0.1 (typical max deviation) and clamped to [-1, 1].
     */
    private computeDownAskDelta(snap: MarketSnapshot | null): number {
        if (!snap || snap.downAsk === undefined || snap.downAsk === null) return 0;
        const fairUp = 1 - snap.downAsk;
        const delta = snap.bestAsk - fairUp;
        return clamp(delta / 0.1, -1, 1);
    }

    /**
     * Time remaining: fraction of the 5-minute round that has elapsed.
     * 0 = just started, 1 = about to expire.
     * As expiry approaches, prices converge to 0 or 1.
     */
    private computeTimeRemaining(snap: MarketSnapshot | null): number {
        if (!snap || snap.roundStartTime === undefined || snap.roundStartTime === null) return 0.5;
        const elapsed = snap.timestamp - snap.roundStartTime;
        return clamp(elapsed / FeatureExtractor.ROUND_DURATION_MS, 0, 1);
    }

    /**
     * Must be called on EVERY accepted price update (before the pole gate)
     * so the EMA tracks actual WS quote arrival rate, not pole frequency.
     */
    trackQuoteArrival(snap: MarketSnapshot): void {
        const now = snap.timestamp;
        if (this.lastQuoteTimestamp !== null) {
            const dtSec = Math.max(0.001, (now - this.lastQuoteTimestamp) / 1000);
            const instantRate = 1 / dtSec;
            this.quoteEma = FeatureExtractor.QUOTE_EMA_ALPHA * instantRate
                          + (1 - FeatureExtractor.QUOTE_EMA_ALPHA) * this.quoteEma;
        }
        this.lastQuoteTimestamp = now;
    }

    /**
     * Quote intensity: returns the pre-computed EMA of quote update rate.
     * Normalized: raw rate / 10 (cap at 10 updates/sec), clamped to [0, 1].
     */
    private computeQuoteIntensity(): number {
        return clamp(this.quoteEma / 10, 0, 1);
    }

    /**
     * Lightweight volatility estimate from price history.
     * Can be called before full feature extraction for regime detection.
     */
    getRecentVolatility(priceHistory: readonly number[]): number {
        return this.computeVolatility(priceHistory);
    }

    /**
     * Lightweight momentum estimate (short-term).
     * Can be called before full feature extraction for regime detection.
     */
    getRecentMomentum(priceHistory: readonly number[]): number {
        const n = priceHistory.length;
        if (n < 2) return 0;
        const cur = priceHistory[n - 1];
        const lag1 = priceHistory[n - 2];
        const lag2 = n >= 3 ? priceHistory[n - 3] : lag1;
        return this.computeMomentum(cur, lag1, lag2, n);
    }

    /**
     * Lightweight trend estimate (EMA-based).
     * Can be called before full feature extraction for regime detection.
     */
    getEmaTrend(): number {
        return this.emaShort - this.emaLong;
    }

    /**
     * Get recent spread from the last processed snapshot.
     */
    getLastSpread(): number | null {
        return this._lastSpread;
    }
    private _lastSpread: number | null = null;

    /**
     * Called on every accepted update to track spread for adaptive noise filter.
     */
    trackSpread(snap: MarketSnapshot): void {
        this._lastSpread = snapshotSpread(snap);
    }

    reset(): void {
        this.emaShort = 0.5;
        this.emaLong = 0.5;
        this.quoteEma = 0;
        this.lastQuoteTimestamp = null;
        this._lastSpread = null;
        // priceMean / priceStd intentionally preserved — serve as priors for the next cycle
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EdgeCalculator
// Stateless — converts model output into a tradable decision.
//
// Pipeline:
//   predictedPrice → sigmoid(delta) → pUp/pDown
//   pUp/pDown + askPrices + cost → edge per side
//   best edge vs threshold → signal
//
// Replaces the former ConfidenceScorer (~130 lines of heuristics) and
// SignalGenerator (~110 lines of cascading tiers) with ~70 lines of
// principled edge-based logic.
// ═══════════════════════════════════════════════════════════════════════════

interface EdgeDecision {
    pUp: number;
    pDown: number;
    edgeBuyUp: number;
    edgeBuyDown: number;
    direction: "up" | "down";
    confidence: number;
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    rawScore: number;
    blockedBySafetyGate?: boolean;
    safetyBlockReason?: string;
}

class EdgeCalculator {
    private static readonly SIGMOID_SENSITIVITY = 15;
    private static readonly FIXED_COST = 0.008;
    private static readonly DEFAULT_HALF_SPREAD = 0.008;
    private static readonly MAX_SPREAD_TO_TRADE = 0.06;
    private static readonly WARMUP_MIN_RESOLVED = 5;

    // Regime-conditioned edge thresholds.
    // Momentum: slightly lower — model has directional conviction and we want to capture continuations.
    // Reversal: standard — classic pole-based trade, needs clear edge.
    // Chop: never trade (forced HOLD).
    // Expiry: higher — book distortion near expiry, need stronger conviction.
    private static readonly MIN_EDGE_FLOW_DOMINANCE = 0.024;
    private static readonly MIN_EDGE_MOMENTUM = 0.025;
    private static readonly MIN_EDGE_BREAKOUT = 0.028;
    private static readonly MIN_EDGE_REVERSAL = 0.03;
    private static readonly MIN_EDGE_EXPIRY = 0.04;
    /** When liquidity_vacuum but flow_dominance score clears the execution-risk exception threshold. */
    private static readonly MIN_EDGE_LIQUIDITY_VACUUM_EXCEPTION = 0.038;

    // Volatility circuit breaker — regime-conditioned.
    // Momentum allows higher volatility (it IS the regime).
    // Expiry is stricter — chaotic near expiry is dangerous.
    private static readonly VOL_BREAKER_MOMENTUM = 0.12;
    private static readonly VOL_BREAKER_BREAKOUT = 0.10;
    private static readonly VOL_BREAKER_REVERSAL = 0.08;
    private static readonly VOL_BREAKER_EXPIRY = 0.06;

    compute(params: {
        predictedPrice: number;
        currentPrice: number;
        rawScore: number;
        features: FeatureVector;
        snapshot: MarketSnapshot | null;
        recentAccuracy: number;
        resolvedCount: number;
        regime: MarketRegime;
        regimeResult: RegimeDetectionResult | null;
    }): EdgeDecision {
        const {
            predictedPrice,
            currentPrice,
            rawScore,
            features,
            snapshot,
            recentAccuracy,
            resolvedCount,
            regime,
            regimeResult,
        } = params;

        // ── 1. Predicted move → probability via sigmoid ──
        const delta = predictedPrice - currentPrice;
        const pUp = 1 / (1 + Math.exp(-EdgeCalculator.SIGMOID_SENSITIVITY * delta));
        const pDown = 1 - pUp;

        // ── 2. Execution cost estimate ──
        const rawSpr = snapshot ? snapshotSpread(snapshot) : 0;
        const halfSpread =
            rawSpr > 0 ? rawSpr / 2 : EdgeCalculator.DEFAULT_HALF_SPREAD;
        const costPerShare = Math.max(0, halfSpread) + EdgeCalculator.FIXED_COST;

        // ── 3. Edge per side ──
        const upAsk = snapshot?.bestAsk ?? currentPrice;
        const downAsk = snapshot?.downAsk ?? (1 - currentPrice);
        const edgeBuyUp = pUp - upAsk - costPerShare;
        const edgeBuyDown = pDown - downAsk - costPerShare;

        // ── 4. Direction = side with better edge ──
        const direction: "up" | "down" = edgeBuyUp >= edgeBuyDown ? "up" : "down";
        const bestEdge = Math.max(edgeBuyUp, edgeBuyDown);

        // ── 5. Confidence = P(correct direction) ──
        const confidence = direction === "up" ? pUp : pDown;

        // ── 6. Accuracy discount ──
        const accuracyFactor = recentAccuracy >= 0.5 ? 1.0 : 0.5 + recentAccuracy;
        const adjustedEdge = bestEdge * accuracyFactor;

        // ── 7. Regime-conditioned signal gating ──
        let signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
        let blockedBySafetyGate: boolean | undefined;
        let safetyBlockReason: string | undefined;

        const volBreakerFor = (r: MarketRegime): number => {
            if (r === "flow_dominance" || r === "momentum") {
                return EdgeCalculator.VOL_BREAKER_MOMENTUM;
            }
            if (r === "breakout") return EdgeCalculator.VOL_BREAKER_BREAKOUT;
            if (r === "expiry") return EdgeCalculator.VOL_BREAKER_EXPIRY;
            return EdgeCalculator.VOL_BREAKER_REVERSAL;
        };

        const minEdgeFor = (r: MarketRegime): number => {
            if (r === "flow_dominance") return EdgeCalculator.MIN_EDGE_FLOW_DOMINANCE;
            if (r === "momentum") return EdgeCalculator.MIN_EDGE_MOMENTUM;
            if (r === "breakout") return EdgeCalculator.MIN_EDGE_BREAKOUT;
            if (r === "reversal") return EdgeCalculator.MIN_EDGE_REVERSAL;
            if (r === "expiry") return EdgeCalculator.MIN_EDGE_EXPIRY;
            return EdgeCalculator.MIN_EDGE_REVERSAL;
        };

        if (regime === "chop") {
            signal = "HOLD";
        } else if (resolvedCount < EdgeCalculator.WARMUP_MIN_RESOLVED) {
            signal = "HOLD";
        } else if (snapshot && snapshotSpread(snapshot) > EdgeCalculator.MAX_SPREAD_TO_TRADE) {
            signal = "HOLD";
        } else if (regime === "liquidity_vacuum") {
            const fd = regimeResult?.scores?.flow_dominance ?? 0;
            if (fd < EXECUTION_RISK_SMALL_TRADE_FLOW_DOM_SCORE) {
                signal = "HOLD";
                blockedBySafetyGate = true;
                safetyBlockReason = "edge: liquidity_vacuum without flow exception";
            } else {
                const volBreaker = EdgeCalculator.VOL_BREAKER_EXPIRY;
                const minEdge = EdgeCalculator.MIN_EDGE_LIQUIDITY_VACUUM_EXCEPTION;
                if (features.volatility > volBreaker) {
                    signal = "HOLD";
                } else if (adjustedEdge >= minEdge) {
                    signal = direction === "up" ? "BUY_UP" : "BUY_DOWN";
                } else {
                    signal = "HOLD";
                }
            }
        } else {
            const volBreaker = volBreakerFor(regime);
            const minEdge = minEdgeFor(regime);
            if (features.volatility > volBreaker) {
                signal = "HOLD";
            } else if (adjustedEdge >= minEdge) {
                signal = direction === "up" ? "BUY_UP" : "BUY_DOWN";
            } else {
                signal = "HOLD";
            }
        }

        return {
            pUp,
            pDown,
            edgeBuyUp,
            edgeBuyDown,
            direction,
            confidence,
            signal,
            rawScore,
            blockedBySafetyGate,
            safetyBlockReason,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// AdaptivePricePredictor (Orchestrator)
// Owns the price buffer, adaptive noise filter, model weights, and
// accuracy history. Delegates to five components:
//   PoleDetector, micro engine + regime, FeatureExtractor, EdgeCalculator, Diagnostics
//
// Prediction trigger is regime-conditioned:
//   reversal/chop → pole-only
//   flow_dominance / momentum / breakout → pole OR 2+ updates since last prediction
//   expiry / liquidity_vacuum → pole OR 1+ update since last prediction
// ═══════════════════════════════════════════════════════════════════════════

export class AdaptivePricePredictor {
    // ── Price buffer ──
    private priceHistory: number[] = [];
    private timestamps: number[] = [];
    private static readonly MAX_HISTORY = 10;

    // ── Noise filtering (adaptive) ──
    // Floor: minimum 1 tick (0.01). The actual threshold is the max of:
    //   tickFloor, 0.5 × recentSpread, 0.3 × recentVolatility
    // This preserves meaningful small changes in tight markets while
    // suppressing noise in volatile or wide-spread conditions.
    private static readonly TICK_FLOOR = 0.01;
    private static readonly NOISE_SPREAD_FACTOR = 0.5;
    private static readonly NOISE_VOL_FACTOR = 0.3;
    private static readonly NOISE_ABSOLUTE_MIN = 0.005;

    private static readonly SMOOTHING_ALPHA = 0.5;
    private static readonly MIN_PRICE = 0.003;
    private static readonly MAX_PRICE = 0.97;
    private smoothedPrice: number | null = null;
    private lastAddedPrice: number | null = null;
    private lastRawPrice: number | null = null;

    // ── Momentum bypass: minimum accepted updates since last prediction ──
    private updatesSinceLastPrediction = 0;

    // ── Model ──
    // TODO: extract into a dedicated OnlineLinearModel class
    private weights: ModelWeights = {
        intercept: 0.5,
        // Legacy
        priceLag1: 0.25,
        priceLag2: 0.08,
        priceLag3: 0.04,
        momentum: 0.35,
        volatility: -0.20,
        trend: 0.45,
        // Microstructure — zero initial weights: no behavior change until online learner discovers signal
        spread: 0,
        microprice: 0,
        bookImbalance: 0,
        downAskDelta: 0,
        timeRemaining: 0,
        quoteIntensity: 0,
    };
    private static readonly LEARNING_RATE = 0.05;
    private static readonly MIN_LR = 0.005;
    private static readonly MAX_LR = 0.2;

    // ── Accuracy tracking ──
    private predictionCount = 0;
    private correctPredictions = 0;
    private recentPredictions: AccuracyRecord[] = [];
    private static readonly RECENT_WINDOW = 20;

    // ── Pending prediction (awaiting future outcome for learning) ──
    private pending: PendingPrediction | null = null;

    // ── Components ──
    private readonly poles = new PoleDetector();
    private readonly microEngine = new MicrostructureFeatureEngine({
        normalizationWindowEvents: 200,
        localRangeWindowEvents: 50,
    });
    private readonly microRegime = new MicroRegimeDetector();
    private readonly regimeDiag = new RegimeDiagnostics();
    private latestMicro: NormalizedFeatureSet | null = null;
    private latestRegimeResult: RegimeDetectionResult | null = null;
    private readonly extractor = new FeatureExtractor();
    private readonly edge = new EdgeCalculator();
    private readonly diagnostics = new PredictionDiagnostics();

    // ─────────────────────────────────────────────────────────────────────

    /**
     * Legacy entry point — accepts a single price scalar.
     * Constructs a minimal MarketSnapshot and delegates to the full method.
     */
    public updateAndPredict(price: number, timestamp: number): PricePrediction | null {
        const minimalSnapshot: MarketSnapshot = {
            bestBid: price,
            bestAsk: price,
            bestBidSize: 0,
            bestAskSize: 0,
            timestamp,
            recentEventCount: 1,
            downAsk: undefined,
            roundStartTime: undefined,
        };
        return this.updateAndPredictWithSnapshot(minimalSnapshot);
    }

    /**
     * Rich entry point — accepts a full MarketSnapshot with orderbook + timing data.
     * The primary price used for the model is always `snapshot.bestAsk` (UP token ask).
     */
    public updateAndPredictWithSnapshot(snapshot: MarketSnapshot): PricePrediction | null {
        const t0 = Date.now();
        const price = snapshot.bestAsk;
        const timestamp = snapshot.timestamp;

        // ── Gate: price range ──
        if (price < AdaptivePricePredictor.MIN_PRICE || price > AdaptivePricePredictor.MAX_PRICE) {
            return null;
        }

        // ── Gate: first price (initialization) ──
        if (this.smoothedPrice === null) {
            this.smoothedPrice = price;
            this.lastAddedPrice = price;
            this.priceHistory.push(price);
            this.timestamps.push(timestamp);
            return null;
        }

        // ── Gate: adaptive noise filter ──
        // Threshold scales with market conditions instead of a fixed 0.02.
        // In tight markets (spread 0.02): threshold ≈ max(0.01, 0.01, vol×0.3) ≈ 0.01
        // In wide markets (spread 0.10): threshold ≈ max(0.01, 0.05, vol×0.3) ≈ 0.05
        const adaptiveThreshold = this.computeAdaptiveNoiseThreshold();
        if (this.lastRawPrice !== null &&
            Math.abs(price - this.lastRawPrice) < adaptiveThreshold) {
            return null;
        }
        this.lastRawPrice = price;

        // ── Smooth ──
        this.smoothedPrice =
            AdaptivePricePredictor.SMOOTHING_ALPHA * price +
            (1 - AdaptivePricePredictor.SMOOTHING_ALPHA) * this.smoothedPrice;

        if (this.smoothedPrice < AdaptivePricePredictor.MIN_PRICE ||
            this.smoothedPrice > AdaptivePricePredictor.MAX_PRICE) {
            return null;
        }

        const currentPrice = this.smoothedPrice;

        // ── Track quote intensity + spread on every accepted update ──
        this.extractor.trackQuoteArrival(snapshot);
        this.extractor.trackSpread(snapshot);
        this.updatesSinceLastPrediction++;

        // ── Buffer update ──
        this.priceHistory.push(currentPrice);
        this.timestamps.push(timestamp);
        this.lastAddedPrice = currentPrice;

        if (this.priceHistory.length > AdaptivePricePredictor.MAX_HISTORY) {
            this.priceHistory.shift();
            this.timestamps.shift();
        }

        // ── Microstructure + regime (every accepted tick) ──
        this.latestMicro = this.microEngine.update(snapshot);
        this.latestRegimeResult = this.microRegime.detect(this.latestMicro);
        this.regimeDiag.record({
            features: this.latestMicro,
            result: this.latestRegimeResult,
            timestamp,
        });

        // ── Gate: minimum history ──
        if (this.priceHistory.length < 3) return null;

        const regime = this.latestRegimeResult.regime;

        // ── Gate: prediction trigger (regime-conditioned) ──
        const isPole = this.poles.detect(this.priceHistory, timestamp, adaptiveThreshold);
        let shouldPredict = isPole;

        if (!isPole) {
            const fastBypass =
                regime === "flow_dominance" ||
                regime === "momentum" ||
                regime === "breakout";
            const urgentBypass = regime === "expiry" || regime === "liquidity_vacuum";
            if (fastBypass && this.updatesSinceLastPrediction >= 2) {
                shouldPredict = true;
            } else if (urgentBypass && this.updatesSinceLastPrediction >= 1) {
                shouldPredict = true;
            }
        }

        if (!shouldPredict) return null;

        this.updatesSinceLastPrediction = 0;

        // ══════════════════════════════════════════════════════════════════
        // LEARNING LIFECYCLE (correct timing):
        //
        //   Prediction T: features_T extracted → predict(features_T) → pending
        //   Prediction T+1: currentPrice → learnFromPending(currentPrice)
        //                   (evaluates T's prediction against T+1's outcome)
        //                   → features_T+1 → predict(features_T+1) → pending
        //
        // This ensures no current-bar information leaks into training.
        // Works identically regardless of whether T was triggered by a pole,
        // momentum bypass, or expiry bypass.
        // ══════════════════════════════════════════════════════════════════

        // ── Step 1: Learn from previous prediction using current price as outcome ──
        this.learnFromPending(currentPrice);

        // ── Step 2: Extract features for current prediction ──
        this.extractor.updateStatistics(this.priceHistory);
        const features = this.extractor.extractWithSnapshot(this.priceHistory, snapshot);

        // ── Step 3: Predict (weights may have just been updated by learning) ──
        const { predictedPrice, rawScore } = this.predict(features);

        // ── Step 4: Update EMA for next call's trend calculation ──
        this.extractor.updateEMA(currentPrice);

        // ── Step 5: Edge-based decision (regime-conditioned) ──
        const recentAccuracy = this.getRecentAccuracy();
        const decision = this.edge.compute({
            predictedPrice,
            currentPrice,
            rawScore,
            features,
            snapshot,
            recentAccuracy,
            resolvedCount: this.recentPredictions.length,
            regime,
            regimeResult: this.latestRegimeResult,
        });

        // ── Step 6: Store current prediction as pending ──
        this.pending = {
            features,
            predictedPrice,
            basePrice: currentPrice,
            confidence: decision.confidence,
        };

        // ── Build result ──
        const result: PricePrediction = {
            predictedPrice,
            confidence: decision.confidence,
            direction: decision.direction,
            signal: decision.signal,
            isPoleValue: isPole,
            features: {
                momentum: features.momentum,
                volatility: features.volatility,
                trend: features.trend,
            },
            pUp: decision.pUp,
            pDown: decision.pDown,
            edgeBuyUp: decision.edgeBuyUp,
            edgeBuyDown: decision.edgeBuyDown,
            rawScore: decision.rawScore,
            regime,
            regimeConfidence: this.latestRegimeResult.bestScore,
            regimeScoreMargin: this.latestRegimeResult.scoreMargin,
            blockedBySafetyGate: decision.blockedBySafetyGate,
            safetyBlockReason: decision.safetyBlockReason,
        };

        this.regimeDiag.recordPrediction(
            decision.signal,
            decision.edgeBuyUp,
            decision.edgeBuyDown,
            regime,
            decision.safetyBlockReason,
        );

        // ── Step 7: Record for diagnostics ──
        this.diagnostics.record(result, snapshot, currentPrice);

        // ── Timing guard ──
        const elapsed = Date.now() - t0;
        if (elapsed > 20) {
            logger.error(`Price prediction took ${elapsed}ms (exceeds 20ms limit)`);
        }

        return result;
    }

    /** Compute time remaining fraction from snapshot, or null if unavailable. */
    private computeTimeRemaining(snapshot: MarketSnapshot): number | null {
        if (snapshot.roundStartTime === null || snapshot.roundStartTime === undefined) {
            return null;
        }
        const elapsed = snapshot.timestamp - snapshot.roundStartTime;
        return clamp(elapsed / (5 * 60 * 1000), 0, 1);
    }

    /** Adaptive noise threshold: max(tickFloor, spreadFactor, volFactor, absoluteMin) */
    private computeAdaptiveNoiseThreshold(): number {
        const recentSpread = this.extractor.getLastSpread();
        const spreadComponent = recentSpread !== null
            ? AdaptivePricePredictor.NOISE_SPREAD_FACTOR * recentSpread
            : AdaptivePricePredictor.TICK_FLOOR;

        const volComponent = this.priceHistory.length >= 3
            ? AdaptivePricePredictor.NOISE_VOL_FACTOR * this.extractor.getRecentVolatility(this.priceHistory)
            : 0;

        return Math.max(
            AdaptivePricePredictor.NOISE_ABSOLUTE_MIN,
            AdaptivePricePredictor.TICK_FLOOR,
            spreadComponent,
            volComponent,
        );
    }

    // ── Model ───────────────────────────────────────────────────────────

    private predict(features: FeatureVector): { predictedPrice: number; rawScore: number } {
        const w = this.weights;
        const rawScore =
            w.intercept +
            // Legacy
            w.priceLag1 * features.priceLag1 +
            w.priceLag2 * features.priceLag2 +
            w.priceLag3 * features.priceLag3 +
            w.momentum  * features.momentum +
            w.volatility * features.volatility +
            w.trend     * features.trend +
            // Microstructure
            w.spread        * features.spread +
            w.microprice    * features.microprice +
            w.bookImbalance * features.bookImbalance +
            w.downAskDelta  * features.downAskDelta +
            w.timeRemaining * features.timeRemaining +
            w.quoteIntensity * features.quoteIntensity;
        return { predictedPrice: this.extractor.denormalizePrice(rawScore), rawScore };
    }

    /**
     * Evaluate the pending prediction against the realized outcome and update weights.
     *
     * Timing contract:
     *   - At pole T, we made a prediction P_T with features F_T about price at base B_T.
     *   - At pole T+1, outcomePrice is the new smoothed price.
     *   - We evaluate: error = outcomePrice - P_T (price-space regression error)
     *   - Direction: did price move from B_T toward P_T or away from it?
     *   - Gradient uses F_T (frozen at prediction time), NOT current features.
     *   - outcomePrice was NOT available when F_T was computed → no leakage.
     *
     * TODO: replace with proper regularized SGD or explore EWRLS
     */
    private learnFromPending(outcomePrice: number): void {
        if (!this.pending) return;

        const p = this.pending;
        const f = p.features;

        // Error: how far off was the predicted price from the realized outcome?
        const error = outcomePrice - p.predictedPrice;
        const normError = Math.min(1, Math.abs(error) * 10);

        // Direction evaluation: relative to the price AT prediction time.
        // "I predicted price would go from basePrice toward predictedPrice.
        //  Did it actually go that way?"
        const predDir = p.predictedPrice > p.basePrice ? 1 : (p.predictedPrice < p.basePrice ? -1 : 0);
        const actDir  = outcomePrice > p.basePrice ? 1 : (outcomePrice < p.basePrice ? -1 : 0);
        const wrong   = predDir !== actDir && predDir !== 0 && actDir !== 0;
        const correct = predDir === actDir && predDir !== 0;

        // Asymmetric learning: learn faster from mistakes
        const mult = wrong ? 8.0 : 2.5;
        const lr = clamp(
            AdaptivePricePredictor.LEARNING_RATE * (1 + normError * mult),
            AdaptivePricePredictor.MIN_LR,
            AdaptivePricePredictor.MAX_LR,
        );

        // TODO: weight decay should be a separate regularization strategy
        const decay = wrong ? 0.85 : 0.97;
        const grad = lr * error;
        this.weights.intercept  = this.weights.intercept  * decay + grad;
        // Legacy
        this.weights.priceLag1  = this.weights.priceLag1  * decay + grad * f.priceLag1;
        this.weights.priceLag2  = this.weights.priceLag2  * decay + grad * f.priceLag2;
        this.weights.priceLag3  = this.weights.priceLag3  * decay + grad * f.priceLag3;
        this.weights.momentum   = this.weights.momentum   * decay + grad * f.momentum;
        this.weights.volatility = this.weights.volatility * decay + grad * f.volatility;
        this.weights.trend      = this.weights.trend      * decay + grad * f.trend;
        // Microstructure
        this.weights.spread        = this.weights.spread        * decay + grad * f.spread;
        this.weights.microprice    = this.weights.microprice    * decay + grad * f.microprice;
        this.weights.bookImbalance = this.weights.bookImbalance * decay + grad * f.bookImbalance;
        this.weights.downAskDelta  = this.weights.downAskDelta  * decay + grad * f.downAskDelta;
        this.weights.timeRemaining = this.weights.timeRemaining * decay + grad * f.timeRemaining;
        this.weights.quoteIntensity = this.weights.quoteIntensity * decay + grad * f.quoteIntensity;

        // Track accuracy
        this.predictionCount++;
        if (correct) this.correctPredictions++;

        this.recentPredictions.push({ correct, confidence: p.confidence });
        if (this.recentPredictions.length > AdaptivePricePredictor.RECENT_WINDOW) {
            this.recentPredictions.shift();
        }

        // Record outcome for diagnostics
        this.diagnostics.resolve(outcomePrice, Date.now());
        if (predDir !== 0 && actDir !== 0) {
            this.regimeDiag.recordResolution(correct);
        }

        this.pending = null;
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private getRecentAccuracy(): number {
        // Cold-start: return 0.5 (coin-flip) — no phantom confidence.
        // The warm-up gate in EdgeCalculator will force HOLD anyway until
        // enough samples are collected to trust this value.
        if (this.recentPredictions.length === 0) return 0.5;
        return this.recentPredictions.filter(p => p.correct).length / this.recentPredictions.length;
    }

    // ── Public API ──────────────────────────────────────────────────────

    public getAccuracyStats(): { accuracy: number; totalPredictions: number; correctPredictions: number } {
        return {
            accuracy: this.predictionCount > 0 ? this.correctPredictions / this.predictionCount : 0,
            totalPredictions: this.predictionCount,
            correctPredictions: this.correctPredictions,
        };
    }
    
    public getLatestMicrostructure(): NormalizedFeatureSet | null {
        return this.latestMicro;
    }

    public getLatestRegimeResult(): RegimeDetectionResult | null {
        return this.latestRegimeResult;
    }

    public getRegimeDiagnostics(): RegimeDiagnostics {
        return this.regimeDiag;
    }

    public getDiagnostics(): PredictionDiagnostics {
        return this.diagnostics;
    }

    public reset(): void {
        this.priceHistory = [];
        this.timestamps = [];
        this.smoothedPrice = null;
        this.lastAddedPrice = null;
        this.lastRawPrice = null;
        this.updatesSinceLastPrediction = 0;
        // Discard pending prediction — it belongs to the old market cycle
        // and the outcome will never arrive in the new cycle.
        this.pending = null;
        this.poles.reset();
        this.microEngine.reset();
        this.microRegime.reset();
        this.regimeDiag.reset();
        this.latestMicro = null;
        this.latestRegimeResult = null;
        this.extractor.reset();
        // Weights + accuracy tracking intentionally preserved across market cycles
    }
}
