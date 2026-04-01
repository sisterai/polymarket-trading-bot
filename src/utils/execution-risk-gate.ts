import type { NormalizedFeatureSet, RegimeDetectionResult } from "./microstructure-regimes";

/** Block when spread percentile is at or above this (wide / toxic). */
export const EXECUTION_RISK_SPREAD_RANK_MIN = 0.9;

/** Block when depth percentile is at or below this (thin book). */
export const EXECUTION_RISK_DEPTH_RANK_MAX = 0.2;

/** Optional tiny size only when regime flow_dominance score is at or above this. */
export const EXECUTION_RISK_SMALL_TRADE_FLOW_DOM_SCORE = 0.8;

/** Max position fraction of base when small-trade exception applies. */
export const EXECUTION_RISK_SMALL_TRADE_MAX_FRACTION = 0.3;

/**
 * Thin / dangerous market: liquidity vacuum regime, very wide spread rank, or very thin depth rank.
 * Micro is required for spread/depth; vacuum is detected from regime alone.
 */
export function executionRiskDanger(rr: RegimeDetectionResult, micro: NormalizedFeatureSet | null): boolean {
    if (rr.regime === "liquidity_vacuum") return true;
    if (!micro) return false;
    if (micro.pctSpreadPct >= EXECUTION_RISK_SPREAD_RANK_MIN) return true;
    if (micro.pctTotalDepth <= EXECUTION_RISK_DEPTH_RANK_MAX) return true;
    return false;
}

export function executionRiskSmallTradeAllowed(rr: RegimeDetectionResult): boolean {
    const s = rr.scores?.flow_dominance ?? 0;
    return s >= EXECUTION_RISK_SMALL_TRADE_FLOW_DOM_SCORE;
}

export function capExecutionRiskSmallTradeSize(baseShares: number, requested: number): number {
    const cap = Math.max(1, Math.round(baseShares * EXECUTION_RISK_SMALL_TRADE_MAX_FRACTION * 1000) / 1000);
    return Math.min(requested, cap);
}

export function formatExecutionRiskBlockReason(rr: RegimeDetectionResult, micro: NormalizedFeatureSet | null): string {
    const parts: string[] = [];
    if (rr.regime === "liquidity_vacuum") parts.push("regime=liquidity_vacuum");
    if (micro) {
        if (micro.pctSpreadPct >= EXECUTION_RISK_SPREAD_RANK_MIN) {
            parts.push(`spreadPctRank=${micro.pctSpreadPct.toFixed(2)}>=${EXECUTION_RISK_SPREAD_RANK_MIN}`);
        }
        if (micro.pctTotalDepth <= EXECUTION_RISK_DEPTH_RANK_MAX) {
            parts.push(`depthRank=${micro.pctTotalDepth.toFixed(2)}<=${EXECUTION_RISK_DEPTH_RANK_MAX}`);
        }
    }
    return parts.length > 0 ? `execution-risk: ${parts.join(" ")}` : "execution-risk";
}
