import type {
    Regime,
    NormalizedFeatureSet,
    RegimeDetectionResult,
} from "./microstructure-regimes";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

const ALL_REGIMES: readonly Regime[] = [
    "flow_dominance", "momentum", "breakout", "reversal",
    "liquidity_vacuum", "expiry", "chop",
];

/**
 * Full record of a single regime classification event.
 * Stored in a ring buffer for export and per-event analysis.
 *
 * `features` holds the complete normalized feature snapshot at classification
 * time, including raw values via `features.raw`.  This makes each event
 * self-contained for offline calibration analysis.
 */
export interface RegimeEvent {
    timestamp: number;
    eventIndex: number;
    features: NormalizedFeatureSet;
    result: RegimeDetectionResult;
    spreadSafe: boolean;
    depthSafe: boolean;

    signal?: "BUY_UP" | "BUY_DOWN" | "HOLD";
    edgeBuyUp?: number;
    edgeBuyDown?: number;
    safetyBlockReason?: string;
    wasCorrect?: boolean;
}

export interface PerRegimeStats {
    count: number;
    predictions: number;
    trades: number;
    holds: number;
    noTradeRate: number;
    resolved: number;
    correctPredictions: number;
    hitRate: number;
    avgSpreadPct: number;
    avgDepthRank: number;
    avgBestEdge: number;
    safetyBlocks: number;
}

export interface RegimeStatsSnapshot {
    totalEvents: number;
    bufferSize: number;

    frequency: Record<Regime, number>;
    frequencyPct: Record<Regime, number>;

    avgDuration: Record<Regime, number>;
    currentRegime: Regime | null;
    currentDuration: number;
    transitionCount: number;
    transitionRate: number;
    topTransitions: Array<{ from: string; to: string; count: number }>;

    perRegime: Record<Regime, PerRegimeStats>;

    liquidityVacuumOverrides: number;
    expiryOverrides: number;

    closeMarginCount: number;
    closeMarginRate: number;
    persistenceFailCount: number;
    rapidSwitchCount: number;
    rapidSwitchRate: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RegimeDiagnostics
//
// Standalone observer — records every regime classification event, tracks
// rolling quality metrics, transition stability, and confusion diagnostics.
// Decoupled from prediction logic; the predictor feeds it via three calls:
//   record()           → on every accepted price update (after regime detect)
//   recordPrediction() → when a prediction is emitted (associates signal/edge)
//   recordResolution() → when the prediction outcome is known (hit rate)
//
// ── Tuning thresholds from live paper-trading data ──
//
// 1. closeMarginRate > 25%: regime boundaries are ambiguous.
//    → Increase minimumScoreMargin or recalibrate score formulas.
// 2. Directional regime hitRate < 50%: not profitable.
//    → Tighten edge threshold for that regime or raise its activation score.
// 3. rapidSwitchRate > 30%: detection is too noisy.
//    → Increase regimeSwitchMargin or persistence requirements.
// 4. Frequent liquidity_vacuum overrides on a seemingly liquid market:
//    → Lower liquidityVacuumOverrideScore or recalibrate spread/depth ranks.
// 5. chop > 60%: regime engine may be too conservative.
//    → Lower minDirectionalRegimeScore or minimumScoreMargin.
// 6. High noTradeRate in a directional regime: safety gates too strict.
//    → Widen maxSpreadPctForAggressiveEntry or lower minDepthRankForAggressiveEntry.
// 7. avgBestEdge consistently negative: model overconfident in that regime.
//    → Tighten MIN_EDGE threshold for that regime.
//
// TODO: Add replay/backtest integration by serializing RegimeEvent[] to JSONL.
// TODO: Add per-cycle (5-min) regime-distribution breakdown.
// ═══════════════════════════════════════════════════════════════════════════

const SPREAD_SAFETY_RANK = 0.80;
const DEPTH_SAFETY_RANK = 0.25;
const CLOSE_MARGIN_THRESHOLD = 0.10;
const RAPID_SWITCH_EVENTS = 3;

export class RegimeDiagnostics {
    private readonly cap: number;
    private events: RegimeEvent[] = [];
    private eventCounter = 0;

    private lifetimeCount = 0;
    private regimeCounts: Record<Regime, number>;
    private transitionMatrix = new Map<string, number>();
    private lifetimeTransitions = 0;

    private regimeSpreadSum: Record<Regime, number>;
    private regimeDepthSum: Record<Regime, number>;
    private regimeEdgeSum: Record<Regime, number>;
    private regimePredictions: Record<Regime, number>;
    private regimeTrades: Record<Regime, number>;
    private regimeHolds: Record<Regime, number>;
    private regimeResolved: Record<Regime, number>;
    private regimeCorrect: Record<Regime, number>;
    private regimeSafetyBlocks: Record<Regime, number>;

    private closeMarginTotal = 0;
    private persistenceFailTotal = 0;
    private rapidSwitchTotal = 0;

    private currentRegime: Regime | null = null;
    private currentRunLength = 0;
    private runLengths = new Map<Regime, number[]>();

    private liquidityVacuumOverrides = 0;
    private expiryOverrides = 0;

    private recentChangeIndices: number[] = [];

    // Tracks which regime was active when the most recent prediction was made,
    // so recordResolution() can attribute the outcome to the correct regime
    // without the caller needing to pass the regime again.
    private pendingResolutionRegime: Regime | null = null;

    constructor(bufferCapacity = 500) {
        this.cap = bufferCapacity;
        this.regimeCounts = this.zeros();
        this.regimeSpreadSum = this.zeros();
        this.regimeDepthSum = this.zeros();
        this.regimeEdgeSum = this.zeros();
        this.regimePredictions = this.zeros();
        this.regimeTrades = this.zeros();
        this.regimeHolds = this.zeros();
        this.regimeResolved = this.zeros();
        this.regimeCorrect = this.zeros();
        this.regimeSafetyBlocks = this.zeros();
    }

    private zeros(): Record<Regime, number> {
        return {
            flow_dominance: 0, momentum: 0, breakout: 0, reversal: 0,
            liquidity_vacuum: 0, expiry: 0, chop: 0,
        };
    }

    // ── Record each regime classification event ──────────────────────────
    // Called on EVERY accepted price update, after regime detection runs.
    // This provides the raw data for all rolling metrics.

    record(input: {
        features: NormalizedFeatureSet;
        result: RegimeDetectionResult;
        timestamp: number;
    }): void {
        const { features, result, timestamp } = input;
        const regime = result.regime;

        const event: RegimeEvent = {
            timestamp,
            eventIndex: this.eventCounter++,
            features,
            result,
            spreadSafe: features.pctSpreadPct < SPREAD_SAFETY_RANK,
            depthSafe: features.pctTotalDepth >= DEPTH_SAFETY_RANK,
        };

        this.events.push(event);
        if (this.events.length > this.cap) this.events.shift();

        this.lifetimeCount++;
        this.regimeCounts[regime]++;
        this.regimeSpreadSum[regime] += features.raw.spreadPct;
        this.regimeDepthSum[regime] += features.pctTotalDepth;

        // ── Transition tracking ──
        if (this.currentRegime !== null && this.currentRegime !== regime) {
            this.lifetimeTransitions++;
            const key = `${this.currentRegime}->${regime}`;
            this.transitionMatrix.set(key, (this.transitionMatrix.get(key) ?? 0) + 1);

            const prev = this.runLengths.get(this.currentRegime) ?? [];
            prev.push(this.currentRunLength);
            if (prev.length > 100) prev.shift();
            this.runLengths.set(this.currentRegime, prev);

            this.currentRunLength = 1;

            // Rapid switch: two transitions within K events of each other
            this.recentChangeIndices.push(this.eventCounter);
            if (this.recentChangeIndices.length > 20) this.recentChangeIndices.shift();
            const n = this.recentChangeIndices.length;
            if (n >= 2) {
                const gap = this.recentChangeIndices[n - 1] - this.recentChangeIndices[n - 2];
                if (gap < RAPID_SWITCH_EVENTS) this.rapidSwitchTotal++;
            }
        } else {
            this.currentRunLength++;
        }
        this.currentRegime = regime;

        // ── Override tracking ──
        if (result.selectionMethod === "override") {
            if (regime === "liquidity_vacuum") this.liquidityVacuumOverrides++;
            if (regime === "expiry") this.expiryOverrides++;
        }

        // ── Confusion tracking ──
        if (result.scoreMargin < CLOSE_MARGIN_THRESHOLD) this.closeMarginTotal++;
        if (result.insufficientPersistenceReason) this.persistenceFailTotal++;
    }

    // ── Associate a prediction with the latest regime event ──────────────
    // Called once per prediction (not per price update).
    // The prediction is attributed to the most recent event in the buffer.

    recordPrediction(
        signal: "BUY_UP" | "BUY_DOWN" | "HOLD",
        edgeBuyUp: number,
        edgeBuyDown: number,
        regime: Regime,
        safetyBlockReason?: string,
    ): void {
        if (this.events.length > 0) {
            const last = this.events[this.events.length - 1];
            last.signal = signal;
            last.edgeBuyUp = edgeBuyUp;
            last.edgeBuyDown = edgeBuyDown;
            last.safetyBlockReason = safetyBlockReason;
        }

        this.regimePredictions[regime]++;
        if (signal === "HOLD") {
            this.regimeHolds[regime]++;
        } else {
            this.regimeTrades[regime]++;
        }
        this.regimeEdgeSum[regime] += Math.max(edgeBuyUp, edgeBuyDown);
        if (safetyBlockReason) this.regimeSafetyBlocks[regime]++;

        this.pendingResolutionRegime = regime;
    }

    // ── Record resolution for per-regime hit rate ────────────────────────
    // Called when a pending prediction is evaluated against the realized
    // outcome. Only call for clear outcomes (correct or wrong, not flat).

    recordResolution(wasCorrect: boolean): void {
        if (this.pendingResolutionRegime === null) return;
        const r = this.pendingResolutionRegime;
        this.regimeResolved[r]++;
        if (wasCorrect) this.regimeCorrect[r]++;
        this.pendingResolutionRegime = null;
    }

    // ── Stats snapshot ───────────────────────────────────────────────────

    getStats(): RegimeStatsSnapshot {
        const total = this.lifetimeCount;

        const frequency = { ...this.regimeCounts };
        const frequencyPct = this.zeros();
        for (const r of ALL_REGIMES) {
            frequencyPct[r] = total > 0 ? frequency[r] / total : 0;
        }

        const avgDuration = this.zeros();
        for (const r of ALL_REGIMES) {
            const runs = this.runLengths.get(r);
            if (runs && runs.length > 0) {
                avgDuration[r] = runs.reduce((a, b) => a + b, 0) / runs.length;
            }
        }

        const topTransitions = [...this.transitionMatrix.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([key, count]) => {
                const [from, to] = key.split("->");
                return { from, to, count };
            });

        const perRegime = {} as Record<Regime, PerRegimeStats>;
        for (const r of ALL_REGIMES) {
            const preds = this.regimePredictions[r];
            const trades = this.regimeTrades[r];
            const holds = this.regimeHolds[r];
            const resolved = this.regimeResolved[r];
            const correct = this.regimeCorrect[r];
            const count = this.regimeCounts[r];
            perRegime[r] = {
                count,
                predictions: preds,
                trades,
                holds,
                noTradeRate: preds > 0 ? holds / preds : 0,
                resolved,
                correctPredictions: correct,
                hitRate: resolved > 0 ? correct / resolved : 0,
                avgSpreadPct: count > 0 ? this.regimeSpreadSum[r] / count : 0,
                avgDepthRank: count > 0 ? this.regimeDepthSum[r] / count : 0,
                avgBestEdge: preds > 0 ? this.regimeEdgeSum[r] / preds : 0,
                safetyBlocks: this.regimeSafetyBlocks[r],
            };
        }

        return {
            totalEvents: total,
            bufferSize: this.events.length,
            frequency,
            frequencyPct,
            avgDuration,
            currentRegime: this.currentRegime,
            currentDuration: this.currentRunLength,
            transitionCount: this.lifetimeTransitions,
            transitionRate: total > 0 ? this.lifetimeTransitions / total : 0,
            topTransitions,
            perRegime,
            liquidityVacuumOverrides: this.liquidityVacuumOverrides,
            expiryOverrides: this.expiryOverrides,
            closeMarginCount: this.closeMarginTotal,
            closeMarginRate: total > 0 ? this.closeMarginTotal / total : 0,
            persistenceFailCount: this.persistenceFailTotal,
            rapidSwitchCount: this.rapidSwitchTotal,
            rapidSwitchRate: this.lifetimeTransitions > 0
                ? this.rapidSwitchTotal / this.lifetimeTransitions
                : 0,
        };
    }

    // ── Formatted report ─────────────────────────────────────────────────

    formatStatsLog(): string {
        const s = this.getStats();
        if (s.totalEvents === 0) return "[RegimeDiag] No events recorded yet.";

        const lines: string[] = [];
        lines.push(
            `[RegimeDiag] Events: ${s.totalEvents} | Buffer: ${s.bufferSize}/${this.cap} ` +
            `| Transitions: ${s.transitionCount} (${(s.transitionRate * 100).toFixed(1)}%)`
        );

        const freqParts = ALL_REGIMES
            .map(r => `${r}=${s.frequency[r]}(${(s.frequencyPct[r] * 100).toFixed(0)}%)`)
            .join(" ");
        lines.push(`  Freq: ${freqParts}`);

        lines.push(
            `  Current: ${s.currentRegime ?? "none"} x${s.currentDuration}`
        );

        const durParts = ALL_REGIMES
            .filter(r => s.avgDuration[r] > 0)
            .map(r => `${r}=${s.avgDuration[r].toFixed(1)}`);
        if (durParts.length > 0) {
            lines.push(`  Avg run: ${durParts.join(" ")}`);
        }

        if (s.topTransitions.length > 0) {
            const txnParts = s.topTransitions
                .slice(0, 5)
                .map(t => `${t.from}->${t.to}=${t.count}`);
            lines.push(`  Top txns: ${txnParts.join(" ")}`);
        }

        for (const r of ALL_REGIMES) {
            const pr = s.perRegime[r];
            if (pr.predictions === 0 && pr.count < 5) continue;
            const parts: string[] = [`  ${r}:`];
            parts.push(`n=${pr.count}`);
            if (pr.predictions > 0) {
                parts.push(
                    `preds=${pr.predictions}`,
                    `trades=${pr.trades}`,
                    `holds=${pr.holds}`,
                    `noTrade=${(pr.noTradeRate * 100).toFixed(0)}%`,
                );
                if (pr.resolved > 0) {
                    parts.push(`hit=${(pr.hitRate * 100).toFixed(0)}%[${pr.resolved}]`);
                }
                parts.push(`avgEdge=${(pr.avgBestEdge * 100).toFixed(2)}%`);
                if (pr.safetyBlocks > 0) parts.push(`blocks=${pr.safetyBlocks}`);
            }
            parts.push(
                `avgSpread=${(pr.avgSpreadPct * 100).toFixed(2)}%`,
                `avgDepth=${pr.avgDepthRank.toFixed(2)}`,
            );
            lines.push(parts.join(" "));
        }

        lines.push(
            `  Overrides: liq_vacuum=${s.liquidityVacuumOverrides} expiry=${s.expiryOverrides}`
        );
        lines.push(
            `  Confusion: closeMargin=${s.closeMarginCount}(${(s.closeMarginRate * 100).toFixed(1)}%)` +
            ` persistFail=${s.persistenceFailCount}` +
            ` rapidSwitch=${s.rapidSwitchCount}(${(s.rapidSwitchRate * 100).toFixed(1)}% of txns)`
        );

        return lines.join("\n");
    }

    // ── Export recent events for offline analysis ────────────────────────

    getRecentEvents(n = 50): readonly RegimeEvent[] {
        return this.events.slice(-n);
    }

    // ── Reset ────────────────────────────────────────────────────────────
    // Note: in normal operation, regime diagnostics accumulate across market
    // cycles (5-min resets) for broader analysis. Call reset() only when
    // you want a full wipe (e.g., new trading session).

    reset(): void {
        this.events = [];
        this.eventCounter = 0;
        this.lifetimeCount = 0;
        this.regimeCounts = this.zeros();
        this.transitionMatrix.clear();
        this.lifetimeTransitions = 0;
        this.regimeSpreadSum = this.zeros();
        this.regimeDepthSum = this.zeros();
        this.regimeEdgeSum = this.zeros();
        this.regimePredictions = this.zeros();
        this.regimeTrades = this.zeros();
        this.regimeHolds = this.zeros();
        this.regimeResolved = this.zeros();
        this.regimeCorrect = this.zeros();
        this.regimeSafetyBlocks = this.zeros();
        this.closeMarginTotal = 0;
        this.persistenceFailTotal = 0;
        this.rapidSwitchTotal = 0;
        this.currentRegime = null;
        this.currentRunLength = 0;
        this.runLengths.clear();
        this.liquidityVacuumOverrides = 0;
        this.expiryOverrides = 0;
        this.recentChangeIndices = [];
        this.pendingResolutionRegime = null;
    }
}
