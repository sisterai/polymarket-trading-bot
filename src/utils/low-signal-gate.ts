import type { NormalizedFeatureSet, RegimeDetectionResult } from "./microstructure-regimes";

/** Require bestScore >= this to trade (block when strictly below). */
export const LOW_SIGNAL_MIN_BEST_SCORE = 0.65;

/** Require scoreMargin >= this to trade (block when strictly below). */
export const LOW_SIGNAL_MIN_SCORE_MARGIN = 0.10;

/**
 * Low-signal / ambiguous regime: do not trade.
 * Blocks most environments where the regime is chop, confidence is weak, or winner is unclear.
 */
export function lowSignalBlocksTrade(rr: RegimeDetectionResult): boolean {
    return (
        rr.regime === "chop" ||
        rr.bestScore < LOW_SIGNAL_MIN_BEST_SCORE ||
        rr.scoreMargin < LOW_SIGNAL_MIN_SCORE_MARGIN
    );
}

export function formatLowSignalBlockReason(rr: RegimeDetectionResult): string {
    const parts: string[] = [];
    if (rr.regime === "chop") parts.push("regime=chop");
    if (rr.bestScore < LOW_SIGNAL_MIN_BEST_SCORE) {
        parts.push(`bestScore=${rr.bestScore.toFixed(3)}<${LOW_SIGNAL_MIN_BEST_SCORE}`);
    }
    if (rr.scoreMargin < LOW_SIGNAL_MIN_SCORE_MARGIN) {
        parts.push(`margin=${rr.scoreMargin.toFixed(3)}<${LOW_SIGNAL_MIN_SCORE_MARGIN}`);
    }
    return parts.length > 0 ? `low-signal: ${parts.join(" ")}` : "low-signal";
}

/** Optional diagnostics when chop / no-trade (debug-only noise control). */
export function formatChopMicroMetrics(micro: NormalizedFeatureSet): string {
    const ofi = Math.abs(micro.zOfiNorm);
    const q = Math.abs(micro.zQueueImbalance);
    const me = Math.abs(micro.zMicropriceEdge);
    return (
        `chop metrics: signFlipRate=n/a | lowOFI=${ofi < 0.5 ? "yes" : "no"}(|zOfi|=${ofi.toFixed(2)}) ` +
        `lowImbalance=${q < 0.5 ? "yes" : "no"}(|zQueue|=${q.toFixed(2)}) |zMicroEdge|=${me.toFixed(2)}`
    );
}
