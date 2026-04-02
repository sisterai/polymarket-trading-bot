import type { PricePrediction } from "./pricePredictor";

export type ConfidenceInputs = Pick<PricePrediction, "confidence" | "regimeConfidence" | "regimeScoreMargin">;

/** Min/max multiplier vs `TRADING_SHARES` baseline (neutral blended confidence → 1.0). */
const MIN_MULT = 0.5;
const MAX_MULT = 1.4;
/** Strength of size response around neutral (0.5 blended confidence → multiplier 1.0). */
const SENSITIVITY = 0.85;

function clamp01(x: number): number {
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Scale order size from a blended confidence signal: stronger conviction → larger size,
 * weaker → smaller (floored at ≥1 share when base is positive).
 *
 * Blends: directional confidence (typically pUp/pDown for the chosen side), regime
 * confidence, and score margin (how decisive the regime call is).
 */
export function scaleSharesByConfidence(baseShares: number, pred: ConfidenceInputs): number {
    if (baseShares <= 0 || !Number.isFinite(baseShares)) return 1;

    const c = clamp01(pred.confidence);
    const rc = clamp01(pred.regimeConfidence);
    const margin = clamp(pred.regimeScoreMargin, 0, 1);
    const blended = 0.55 * c + 0.25 * rc + 0.2 * margin;
    const mult = clamp(1 + SENSITIVITY * (blended - 0.5), MIN_MULT, MAX_MULT);
    const raw = baseShares * mult;
    return Math.max(1, Math.round(raw * 1000) / 1000);
}
