/**
 * flow_dominance regime: order-flow + queue-imbalance continuation (aggressive).
 * Decoupled from the generic edge model; consumed by UpDownPredictionBot.
 */

import type { NormalizedFeatureSet, RegimeDetectionResult } from "../../utils/microstructure-regimes";

const EPS = 1e-9;

function clamp01(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function signDir(x: number): -1 | 0 | 1 {
    if (Math.abs(x) <= EPS) return 0;
    return x > 0 ? 1 : -1;
}

/** Snapshot at flow_dominance entry for exit evaluation */
export interface FlowDominanceEntrySnapshot {
    ofiSign: -1 | 0 | 1;
    ofiNormZ: number;
    queueImbalanceZ: number;
    spreadPctRank: number;
    timeToExpiryMs: number;
}

export interface FlowDominanceEntryResult {
    shouldEnter: boolean;
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    direction: "up" | "down";
    confidence: number;
    entryScore: number;
    edgeDirection: -1 | 0 | 1;
    /** Human-readable diagnostics */
    reason: string;
    blockReason?: string;
    entrySnapshot: FlowDominanceEntrySnapshot;
}

const MAX_SPREAD_PCT_ENTRY = 0.015;
const MIN_DEPTH_RANK_RISK = 0.2;
const MAX_HOLD_EVENTS = 15;

/**
 * edgeDirection =
 *   sign(ofiNorm) if abs(ofiNormZ) > abs(queueImbalanceZ)
 *   else sign(queueImbalance)
 */
export function computeEdgeDirection(micro: NormalizedFeatureSet): -1 | 0 | 1 {
    const { raw, zOfiNorm, zQueueImbalance } = micro;
    const useOfi = Math.abs(zOfiNorm) > Math.abs(zQueueImbalance);
    return useOfi ? signDir(raw.ofiNorm) : signDir(raw.queueImbalance);
}

export function computeEntryScore(micro: NormalizedFeatureSet, persistenceScore: number): number {
    const { zOfiNorm, zQueueImbalance } = micro;
    return (
        0.5 * clamp01(Math.abs(zOfiNorm) / 2.0) +
        0.3 * clamp01(Math.abs(zQueueImbalance) / 1.5) +
        0.2 * clamp01(persistenceScore)
    );
}

/** Risk guardrails (hard no-trade before entry rules). */
export function flowDominanceRiskBlocked(micro: NormalizedFeatureSet): string | null {
    if (micro.raw.spreadPct > MAX_SPREAD_PCT_ENTRY) {
        return `risk: spreadPct ${(micro.raw.spreadPct * 100).toFixed(2)}% > 1.5%`;
    }
    if (micro.pctTotalDepth < MIN_DEPTH_RANK_RISK) {
        return `risk: depthRank ${micro.pctTotalDepth.toFixed(3)} < 0.2`;
    }
    return null;
}

/**
 * ENTRY RULE (flow_dominance only). Uses regime detector persistence when available.
 */
export function evaluateFlowDominanceEntry(
    micro: NormalizedFeatureSet,
    regimeResult: RegimeDetectionResult,
): FlowDominanceEntryResult {
    const persistenceScore = regimeResult.persistenceScore ?? 0;
    const regimeConfidence = regimeResult.bestScore;
    const { zOfiNorm, zQueueImbalance, pctSpreadPct, pctTotalDepth, raw } = micro;

    const edgeDirection = computeEdgeDirection(micro);
    const entryScore = computeEntryScore(micro, persistenceScore);

    const entrySnapshot: FlowDominanceEntrySnapshot = {
        ofiSign: signDir(raw.ofiNorm),
        ofiNormZ: zOfiNorm,
        queueImbalanceZ: zQueueImbalance,
        spreadPctRank: pctSpreadPct,
        timeToExpiryMs: raw.timeToExpiryMs,
    };

    const risk = flowDominanceRiskBlocked(micro);
    if (risk) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: 0,
            entryScore,
            edgeDirection,
            reason: risk,
            blockReason: risk,
            entrySnapshot,
        };
    }

    const reasons: string[] = [];
    let blockReason: string | undefined;

    if (regimeResult.regime !== "flow_dominance") {
        blockReason = "regime != flow_dominance";
    } else if (Math.abs(zOfiNorm) < 1.2) {
        blockReason = `abs(ofiNormZ)=${Math.abs(zOfiNorm).toFixed(2)} < 1.2`;
    } else if (Math.abs(zQueueImbalance) < 0.8) {
        blockReason = `abs(queueImbalanceZ)=${Math.abs(zQueueImbalance).toFixed(2)} < 0.8`;
    } else if (persistenceScore < 0.6) {
        blockReason = `persistenceScore=${persistenceScore.toFixed(2)} < 0.6`;
    } else if (pctSpreadPct > 0.8) {
        blockReason = `spreadPctRank=${pctSpreadPct.toFixed(2)} > 0.80`;
    } else if (pctTotalDepth < 0.25) {
        blockReason = `depthRank=${pctTotalDepth.toFixed(2)} < 0.25`;
    } else if (entryScore < 0.65) {
        blockReason = `entryScore=${entryScore.toFixed(3)} < 0.65`;
    } else if (edgeDirection === 0) {
        blockReason = "edgeDirection=0 (no side)";
    }

    if (blockReason) {
        return {
            shouldEnter: false,
            signal: "HOLD",
            direction: "up",
            confidence: entryScore,
            entryScore,
            edgeDirection,
            reason: `blocked: ${blockReason}`,
            blockReason,
            entrySnapshot,
        };
    }

    const signal: "BUY_UP" | "BUY_DOWN" = edgeDirection > 0 ? "BUY_UP" : "BUY_DOWN";
    const direction: "up" | "down" = edgeDirection > 0 ? "up" : "down";
    reasons.push(
        `ofiZ=${zOfiNorm.toFixed(2)} queueZ=${zQueueImbalance.toFixed(2)} persist=${persistenceScore.toFixed(2)}`,
        `entryScore=${entryScore.toFixed(3)} conf(regime)=${regimeConfidence.toFixed(3)}`,
    );

    return {
        shouldEnter: true,
        signal,
        direction,
        confidence: entryScore,
        entryScore,
        edgeDirection,
        reason: reasons.join(" | "),
        entrySnapshot,
    };
}

/**
 * positionSize = baseSize * clamp(entryScore * regimeConfidence, 0.5, 1.5)
 */
export function computeFlowDominancePositionSize(
    baseSize: number,
    entryScore: number,
    regimeConfidence: number,
): number {
    const mult = clamp(entryScore * regimeConfidence, 0.5, 1.5);
    const raw = baseSize * mult;
    return Math.max(1, Math.round(raw * 1000) / 1000);
}

/**
 * Exit immediately if ANY condition holds (vs entry snapshot).
 */
export function shouldExitFlowDominancePosition(
    micro: NormalizedFeatureSet,
    entry: FlowDominanceEntrySnapshot,
): { exit: boolean; reason?: string } {
    const { raw, zOfiNorm, zQueueImbalance, pctSpreadPct } = micro;
    const ofiSignNow = signDir(raw.ofiNorm);

    if (entry.ofiSign !== 0 && ofiSignNow !== 0 && ofiSignNow !== entry.ofiSign) {
        return { exit: true, reason: "ofi sign flipped" };
    }
    if (Math.abs(zOfiNorm) < 0.5) {
        return { exit: true, reason: `abs(ofiNormZ)=${Math.abs(zOfiNorm).toFixed(2)} < 0.5` };
    }
    if (Math.abs(zQueueImbalance) < 0.3) {
        return { exit: true, reason: `abs(queueImbalanceZ)=${Math.abs(zQueueImbalance).toFixed(2)} < 0.3` };
    }
    if (pctSpreadPct > 0.85) {
        return { exit: true, reason: `spreadPctRank=${pctSpreadPct.toFixed(2)} > 0.85` };
    }
    if (raw.timeToExpiryMs < 15_000) {
        return { exit: true, reason: `timeToExpiryMs=${raw.timeToExpiryMs} < 15000` };
    }
    return { exit: false };
}

/** Max holding window in processed market events (default 15). */
export function flowDominanceMaxHoldEvents(): number {
    return MAX_HOLD_EVENTS;
}

export function shouldForceExitByHoldDuration(eventsSinceEntry: number): boolean {
    return eventsSinceEntry > MAX_HOLD_EVENTS;
}
