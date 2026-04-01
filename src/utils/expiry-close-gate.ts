import type { NormalizedFeatureSet, RegimeDetectionResult } from "./microstructure-regimes";

/** Within this many ms of round end, default to no trade (prefer flat). */
export const EXPIRY_CLOSE_MS = 20_000;

/** Optional late-round trade only with strong flow score. */
export const EXPIRY_CLOSE_MIN_FLOW_DOM_SCORE = 0.8;

/** Optional: spread rank must be at or below this (tighter book). */
export const EXPIRY_CLOSE_MAX_SPREAD_RANK = 0.75;

/** Optional: depth rank must be at or above this (enough depth). */
export const EXPIRY_CLOSE_MIN_DEPTH_RANK = 0.3;

/** Max fraction of base size when optional expiry trade is allowed. */
export const EXPIRY_CLOSE_MAX_FRACTION = 0.5;

export function expiryCloseWindow(micro: NormalizedFeatureSet | null): boolean {
    if (!micro) return false;
    return micro.raw.timeToExpiryMs < EXPIRY_CLOSE_MS;
}

/**
 * Rare exception: only if flow is extreme and book quality gates pass.
 */
export function expiryCloseAllowsTrade(rr: RegimeDetectionResult, micro: NormalizedFeatureSet | null): boolean {
    if (!micro) return false;
    const fd = rr.scores?.flow_dominance ?? 0;
    if (fd < EXPIRY_CLOSE_MIN_FLOW_DOM_SCORE) return false;
    if (micro.pctSpreadPct > EXPIRY_CLOSE_MAX_SPREAD_RANK) return false;
    if (micro.pctTotalDepth < EXPIRY_CLOSE_MIN_DEPTH_RANK) return false;
    return true;
}

export function capExpiryCloseSize(baseShares: number, requested: number): number {
    const cap = Math.max(1, Math.round(baseShares * EXPIRY_CLOSE_MAX_FRACTION * 1000) / 1000);
    return Math.min(requested, cap);
}

export function formatExpiryCloseBlockReason(micro: NormalizedFeatureSet): string {
    return `expiry-close: timeToExpiryMs=${micro.raw.timeToExpiryMs} < ${EXPIRY_CLOSE_MS}`;
}
