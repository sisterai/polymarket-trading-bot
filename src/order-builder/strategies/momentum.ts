/**
 * momentum regime: moderate-confidence continuation; stricter than flow_dominance.
 */

import type { NormalizedFeatureSet, RegimeDetectionResult } from "../../utils/microstructure-regimes";

const EPS = 1e-9;

function clamp01(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x;
}

function signDir(x: number): -1 | 0 | 1 {
    if (Math.abs(x) <= EPS) return 0;
    return x > 0 ? 1 : -1;
}

/** Shorter max hold than flow_dominance (15). */
export const MOMENTUM_MAX_HOLD_EVENTS = 10;

export interface MomentumEntrySnapshot {
    ofiSign: -1 | 0 | 1;
    pctRealizedVol: number;
}

export interface MomentumEntryResult {
    shouldEnter: boolean;
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    direction: "up" | "down";
    confidence: number;
    momentumScore: number;
    reason: string;
    blockReason?: string;
    entrySnapshot: MomentumEntrySnapshot;
}

/**
 * momentumScore =
 *   0.4 * clamp01(abs(ofiNormZ) / 1.5)
 * + 0.3 * clamp01(abs(queueImbalanceZ) / 1.2)
 * + 0.2 * clamp01(abs(return1Z) / 1.5)
 * + 0.1 * persistenceScore
 */
export function computeMomentumScore(micro: NormalizedFeatureSet, persistenceScore: number): number {
    const { zOfiNorm, zQueueImbalance, zReturn1 } = micro;
    return (
        0.4 * clamp01(Math.abs(zOfiNorm) / 1.5) +
        0.3 * clamp01(Math.abs(zQueueImbalance) / 1.2) +
        0.2 * clamp01(Math.abs(zReturn1) / 1.5) +
        0.1 * clamp01(persistenceScore)
    );
}

/**
 * alignment(ofiNorm, queueImbalance, return1): all three non-zero and same sign.
 */
export function alignmentOfiQueueReturn1(micro: NormalizedFeatureSet): boolean {
    const a = signDir(micro.raw.ofiNorm);
    const b = signDir(micro.raw.queueImbalance);
    const c = signDir(micro.raw.return1);
    if (a === 0 || b === 0 || c === 0) return false;
    return a === b && b === c;
}

/**
 * Prefer pullback entry, avoid chasing spikes.
 * UP token: require shallow retracement from window high (2%–30% of range), not at the spike top.
 * DOWN bias: symmetric from window low.
 */
export function pullbackEntryAllows(
    recentUpAsks: readonly number[],
    direction: "up" | "down",
): { ok: boolean; detail: string } {
    if (recentUpAsks.length < 4) {
        return { ok: false, detail: "pullback: need >=4 samples" };
    }
    const high = Math.max(...recentUpAsks);
    const low = Math.min(...recentUpAsks);
    const range = high - low;
    const current = recentUpAsks[recentUpAsks.length - 1]!;
    if (range < 1e-6) {
        return { ok: true, detail: "pullback: flat window" };
    }

    if (direction === "up") {
        const retraceFromHigh = (high - current) / range;
        if (retraceFromHigh < 0.02) {
            return { ok: false, detail: `pullback: spike-chase retrace=${(retraceFromHigh * 100).toFixed(1)}%<2%` };
        }
        if (retraceFromHigh > 0.30) {
            return { ok: false, detail: `pullback: deep retrace ${(retraceFromHigh * 100).toFixed(1)}%>30%` };
        }
        return { ok: true, detail: `pullback: retrace=${(retraceFromHigh * 100).toFixed(1)}%` };
    }

    const retraceFromLow = (current - low) / range;
    if (retraceFromLow < 0.02) {
        return { ok: false, detail: `pullback: spike-chase retrace=${(retraceFromLow * 100).toFixed(1)}%<2%` };
    }
    if (retraceFromLow > 0.30) {
        return { ok: false, detail: `pullback: deep bounce ${(retraceFromLow * 100).toFixed(1)}%>30%` };
    }
    return { ok: true, detail: `pullback: retrace=${(retraceFromLow * 100).toFixed(1)}%` };
}

export function computeMomentumPositionSize(baseSize: number, momentumScore: number): number {
    const raw = baseSize * 0.7 * momentumScore;
    return Math.max(1, Math.round(raw * 1000) / 1000);
}

export function evaluateMomentumEntry(
    micro: NormalizedFeatureSet,
    regimeResult: RegimeDetectionResult,
    recentUpAsks: readonly number[],
): MomentumEntryResult {
    const persistenceScore = regimeResult.persistenceScore ?? 0;
    const { pctRealizedVol, pctSpreadPct, raw } = micro;

    const momentumScore = computeMomentumScore(micro, persistenceScore);
    const aligned = alignmentOfiQueueReturn1(micro);
    const dirSign = signDir(raw.ofiNorm);
    const direction: "up" | "down" = dirSign > 0 ? "up" : "down";
    const signal: "BUY_UP" | "BUY_DOWN" = dirSign > 0 ? "BUY_UP" : "BUY_DOWN";

    const entrySnapshot: MomentumEntrySnapshot = {
        ofiSign: signDir(raw.ofiNorm),
        pctRealizedVol,
    };

    if (regimeResult.regime !== "momentum") {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: 0,
            momentumScore,
            reason: "regime != momentum",
            blockReason: "regime != momentum",
            entrySnapshot,
        };
    }

    if (momentumScore < 0.65) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: `momentumScore=${momentumScore.toFixed(3)} < 0.65`,
            blockReason: "momentumScore < 0.65",
            entrySnapshot,
        };
    }

    if (persistenceScore < 0.6) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: `persistence=${persistenceScore.toFixed(2)} < 0.6`,
            blockReason: "persistence < 0.6",
            entrySnapshot,
        };
    }

    if (pctRealizedVol < 0.30 || pctRealizedVol > 0.85) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: `realizedVolRank=${pctRealizedVol.toFixed(2)} not in [0.30,0.85]`,
            blockReason: "vol rank band",
            entrySnapshot,
        };
    }

    if (pctSpreadPct > 0.75) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: `spreadPctRank=${pctSpreadPct.toFixed(2)} > 0.75`,
            blockReason: "spread rank",
            entrySnapshot,
        };
    }

    if (!aligned) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: "alignment(ofi, queue, return1) false",
            blockReason: "alignment",
            entrySnapshot,
        };
    }

    if (dirSign === 0) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: momentumScore,
            momentumScore,
            reason: "direction flat after alignment",
            blockReason: "flat direction",
            entrySnapshot,
        };
    }

    const pb = pullbackEntryAllows(recentUpAsks, direction);
    if (!pb.ok) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction,
            confidence: momentumScore,
            momentumScore,
            reason: pb.detail,
            blockReason: pb.detail,
            entrySnapshot,
        };
    }

    return {
        shouldEnter: true,
        signal,
        direction,
        confidence: momentumScore,
        momentumScore,
        reason: `mom=${momentumScore.toFixed(3)} persist=${persistenceScore.toFixed(2)} volR=${pctRealizedVol.toFixed(2)} sprR=${pctSpreadPct.toFixed(2)} align | ${pb.detail}`,
        entrySnapshot,
    };
}

export function shouldExitMomentumPosition(
    micro: NormalizedFeatureSet,
    entry: MomentumEntrySnapshot,
    persistenceScore: number,
): { exit: boolean; reason?: string } {
    const ofiNow = signDir(micro.raw.ofiNorm);
    if (entry.ofiSign !== 0 && ofiNow !== 0 && ofiNow !== entry.ofiSign) {
        return { exit: true, reason: "ofi sign flipped" };
    }
    if (persistenceScore < 0.4) {
        return { exit: true, reason: `persistence=${persistenceScore.toFixed(2)} < 0.4` };
    }
    if (micro.pctRealizedVol > 0.9) {
        return { exit: true, reason: `vol spike rank=${micro.pctRealizedVol.toFixed(2)} > 0.9` };
    }
    return { exit: false };
}

export function shouldForceExitMomentumByHoldDuration(eventsSinceEntry: number): boolean {
    return eventsSinceEntry > MOMENTUM_MAX_HOLD_EVENTS;
}
