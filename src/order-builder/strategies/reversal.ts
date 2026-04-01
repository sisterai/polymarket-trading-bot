/**
 * reversal regime: mean reversion after strong directional moves (exhaustion + divergence).
 * Never enters on the first qualifying event — requires one confirmation tick.
 */

import type { NormalizedFeatureSet, RegimeDetectionResult } from "../../utils/microstructure-regimes";

const EPS = 1e-9;

/** Sum return1 over this many events for trend strength. */
export const RECENT_TREND_N = 8;

/** Cumulative |sum(return1)| must be >= this to count as HIGH (fractional returns). */
export const TREND_STRENGTH_THRESHOLD = 0.001;

/** Exit when trend strength rebuilds to this fraction of entry threshold. */
export const TREND_RESUME_FRACTION = 0.6;

/** Max ticks to wait for confirmation after arming. */
export const REVERSAL_ARM_MAX_AGE_TICKS = 3;

export const REVERSAL_MAX_HOLD_EVENTS = 10;

export interface ReversalArmPending {
    armedAtTick: number;
    /** Sign of the strong trend we are fading (before mean reversion). */
    trendSign: -1 | 1;
}

export interface ReversalEntrySnapshot {
    /** Trend direction we faded against (exit if it resumes). */
    trendSign: -1 | 1;
}

export interface ReversalEntryResult {
    shouldEnter: boolean;
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    direction: "up" | "down";
    confidence: number;
    reason: string;
    blockReason?: string;
    entrySnapshot?: ReversalEntrySnapshot;
    pendingNext: ReversalArmPending | null;
}

function signOrZero(x: number): -1 | 0 | 1 {
    if (Math.abs(x) <= EPS) return 0;
    return x > 0 ? 1 : -1;
}

export function sumReturns(returns: readonly number[]): number {
    return returns.reduce((a, b) => a + b, 0);
}

export function recentTrendSum(returnHistory: readonly number[], n: number): number {
    if (returnHistory.length < n) return 0;
    return sumReturns(returnHistory.slice(-n));
}

/** recentTrendStrength HIGH */
export function trendStrengthHigh(absSum: number, threshold: number = TREND_STRENGTH_THRESHOLD): boolean {
    return absSum >= threshold;
}

/** sign(recentTrend) != sign(ofiNorm); requires both non-zero for a clean divergence. */
export function divergenceTrue(trendSign: -1 | 0 | 1, ofiNorm: number): boolean {
    const o = signOrZero(ofiNorm);
    if (trendSign === 0 || o === 0) return false;
    return trendSign !== o;
}

/** abs(ofiNormZ) decreasing AND micropriceEdgeZ weakening (|z| decreasing vs prior tick). */
export function exhaustionTrue(
    micro: NormalizedFeatureSet,
    prev: { absOfiZ: number; absMicroZ: number } | null,
): boolean {
    if (!prev) return false;
    const a = Math.abs(micro.zOfiNorm);
    const m = Math.abs(micro.zMicropriceEdge);
    return a < prev.absOfiZ - EPS && m < prev.absMicroZ - EPS;
}

function armGates(
    micro: NormalizedFeatureSet,
    rr: RegimeDetectionResult,
    returnHistory: readonly number[],
    prevExhaustionZ: { absOfiZ: number; absMicroZ: number } | null,
): {
    ok: boolean;
    trendSign: -1 | 0 | 1;
    absSum: number;
    blockReason?: string;
} {
    if (rr.regime !== "reversal") {
        return { ok: false, trendSign: 0, absSum: 0, blockReason: "regime != reversal" };
    }
    if (returnHistory.length < RECENT_TREND_N) {
        return { ok: false, trendSign: 0, absSum: 0, blockReason: `need >=${RECENT_TREND_N} return samples` };
    }
    const sum = recentTrendSum(returnHistory, RECENT_TREND_N);
    const absSum = Math.abs(sum);
    const trendSign = signOrZero(sum);
    if (!trendStrengthHigh(absSum)) {
        return { ok: false, trendSign, absSum, blockReason: `trend strength ${absSum.toFixed(6)} < ${TREND_STRENGTH_THRESHOLD}` };
    }
    if (trendSign === 0) {
        return { ok: false, trendSign: 0, absSum, blockReason: "trend sign flat" };
    }
    if (!divergenceTrue(trendSign, micro.raw.ofiNorm)) {
        return { ok: false, trendSign, absSum, blockReason: "divergence false" };
    }
    if (!exhaustionTrue(micro, prevExhaustionZ)) {
        return { ok: false, trendSign, absSum, blockReason: "exhaustion false" };
    }
    return { ok: true, trendSign, absSum };
}

/** One additional event confirms fade direction (price step toward mean or OFI still diverged). */
function confirmReversalEvent(micro: NormalizedFeatureSet, trendSign: -1 | 1): boolean {
    const r = micro.raw.return1;
    const fadeUp = trendSign < 0; // was down trend → fade up
    const priceConfirms = fadeUp ? r > EPS : r < -EPS;
    const stillDivergence =
        signOrZero(micro.raw.ofiNorm) !== 0 && signOrZero(micro.raw.ofiNorm) !== trendSign;
    return priceConfirms || stillDivergence;
}

function confirmPathValid(micro: NormalizedFeatureSet, rr: RegimeDetectionResult): boolean {
    return rr.regime === "reversal";
}

export function computeReversalPositionSize(baseSize: number): number {
    const raw = baseSize * 0.6;
    return Math.max(1, Math.round(raw * 1000) / 1000);
}

export function evaluateReversalEntry(
    micro: NormalizedFeatureSet,
    rr: RegimeDetectionResult,
    returnHistory: readonly number[],
    prevExhaustionZ: { absOfiZ: number; absMicroZ: number } | null,
    pending: ReversalArmPending | null,
    processTick: number,
): ReversalEntryResult {
    if (pending) {
        const age = processTick - pending.armedAtTick;
        if (age <= 0) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.trendSign > 0 ? "down" : "up",
                confidence: 0,
                reason: "reversal: same tick as arm",
                blockReason: "reversal: internal",
                pendingNext: pending,
            };
        }
        if (age > REVERSAL_ARM_MAX_AGE_TICKS) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: "up",
                confidence: 0,
                reason: `reversal: arm stale (age=${age})`,
                blockReason: "reversal: confirmation timeout",
                pendingNext: null,
            };
        }

        if (!confirmPathValid(micro, rr)) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.trendSign > 0 ? "down" : "up",
                confidence: 0,
                reason: "reversal: confirm tick lost regime",
                blockReason: "regime != reversal",
                pendingNext: null,
            };
        }

        const sum = recentTrendSum(returnHistory, RECENT_TREND_N);
        if (signOrZero(sum) !== pending.trendSign) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.trendSign > 0 ? "down" : "up",
                confidence: 0,
                reason: "reversal: trend sign flipped before confirm",
                blockReason: "reversal: trend no longer aligned",
                pendingNext: null,
            };
        }

        if (!confirmReversalEvent(micro, pending.trendSign)) {
            return {
                shouldEnter: false,
                signal: "HOLD",
                direction: pending.trendSign > 0 ? "down" : "up",
                confidence: 0,
                reason: "reversal: confirmation not met",
                blockReason: "reversal: no confirm",
                pendingNext: null,
            };
        }

        const direction: "up" | "down" = pending.trendSign > 0 ? "down" : "up";
        const signal = direction === "up" ? "BUY_UP" : "BUY_DOWN";
        const entrySnapshot: ReversalEntrySnapshot = { trendSign: pending.trendSign };

        return {
            shouldEnter: true,
            signal,
            direction,
            confidence: Math.min(1, Math.abs(recentTrendSum(returnHistory, RECENT_TREND_N)) / (TREND_STRENGTH_THRESHOLD * 2)),
            reason: `reversal ENTRY: confirm | faded trendSign=${pending.trendSign} sum=${recentTrendSum(returnHistory, RECENT_TREND_N).toFixed(6)}`,
            entrySnapshot,
            pendingNext: null,
        };
    }

    const g = armGates(micro, rr, returnHistory, prevExhaustionZ);
    if (!g.ok || g.trendSign === 0) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: 0,
            reason: g.blockReason ?? "reversal: gates",
            blockReason: g.blockReason,
            pendingNext: null,
        };
    }

    const ts = g.trendSign as -1 | 1;
    return {
        shouldEnter: false,
        signal: "HOLD",
        direction: ts > 0 ? "down" : "up",
        confidence: 0,
        reason: `reversal ARM: await confirm | trendSign=${ts} |sum|=${g.absSum.toFixed(6)}`,
        blockReason: "reversal: awaiting confirmation",
        pendingNext: { armedAtTick: processTick, trendSign: ts },
    };
}

export function shouldExitReversalPosition(
    micro: NormalizedFeatureSet,
    entry: ReversalEntrySnapshot,
    returnHistory: readonly number[],
): { exit: boolean; reason?: string } {
    if (returnHistory.length < RECENT_TREND_N) return { exit: false };
    const sum = recentTrendSum(returnHistory, RECENT_TREND_N);
    const absSum = Math.abs(sum);
    const ts = signOrZero(sum);
    const resumeTh = TREND_STRENGTH_THRESHOLD * TREND_RESUME_FRACTION;
    if (ts === entry.trendSign && absSum >= resumeTh) {
        return { exit: true, reason: `trend resumed: sum=${sum.toFixed(6)}` };
    }
    const ofi = signOrZero(micro.raw.ofiNorm);
    if (ofi !== 0 && ofi === entry.trendSign) {
        return { exit: true, reason: "ofi realigned with prior trend" };
    }
    return { exit: false };
}

export function shouldForceExitReversalByHoldDuration(eventsSinceEntry: number): boolean {
    return eventsSinceEntry > REVERSAL_MAX_HOLD_EVENTS;
}
