const SECONDS_PER_YEAR = 31_536_000;

/**
 * Abramowitz & Stegun approximation of erf (max error < 1.5e-7).
 */
function erf(x: number): number {
    const sign = x >= 0 ? 1 : -1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const poly =
        t *
        (0.254829592 +
            t *
                (-0.284496736 +
                    t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return sign * (1 - poly * Math.exp(-ax * ax));
}

/** Standard normal CDF. */
export function normCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Black-Scholes d2 probability for the UP outcome (r = 0 simplification).
 *
 *   d2 = ( ln(S/K) - (σ²/2) * T ) / ( σ * √T )
 *   P(UP) = normCdf(d2)
 *
 * @param S          Current spot price of the underlying asset.
 * @param K          Strike price at the start of the prediction window.
 * @param T_seconds  Time remaining until settlement in **seconds**.
 * @param sigma      Annualised volatility (σ).
 */
export function computeUpProbability(
    S: number,
    K: number,
    T_seconds: number,
    sigma: number
): number {
    if (S <= 0 || K <= 0 || T_seconds <= 0 || sigma <= 0) return 0.5;
    const T = T_seconds / SECONDS_PER_YEAR;
    const sqrtT = Math.sqrt(T);
    const d2 = (Math.log(S / K) - (sigma * sigma / 2) * T) / (sigma * sqrtT);
    return normCdf(d2);
}

/**
 * EWMA volatility tracker (λ = 0.94, RiskMetrics standard).
 *
 * Updates on each new price tick, normalises log-returns to a per-second
 * basis so that `getAnnualizedVolatility()` is consistent with the T-in-years
 * convention used in `computeUpProbability`.
 */
export class EWMAVolatility {
    private readonly lambda = 0.94;
    private variancePerSecond = 0;
    private lastPrice: number | null = null;
    private lastTimestamp: number | null = null;
    private initialized = false;

    update(price: number, timestamp: number): void {
        if (this.lastPrice === null || this.lastTimestamp === null) {
            this.lastPrice = price;
            this.lastTimestamp = timestamp;
            return;
        }

        const dt = Math.max(0.01, (timestamp - this.lastTimestamp) / 1000); // seconds
        const logReturn = Math.log(price / this.lastPrice);
        // Normalise to per-second variance so annualisation is straightforward
        const r2PerSec = (logReturn * logReturn) / dt;

        this.variancePerSecond = this.initialized
            ? this.lambda * this.variancePerSecond + (1 - this.lambda) * r2PerSec
            : r2PerSec;

        this.initialized = true;
        this.lastPrice = price;
        this.lastTimestamp = timestamp;
    }

    /** Returns σ in annualised terms (consistent with T in years). */
    getAnnualizedVolatility(): number {
        // Fallback 80% covers typical crypto volatility before enough data accumulates
        if (!this.initialized) return 0.8;
        return Math.sqrt(this.variancePerSecond * SECONDS_PER_YEAR);
    }

    reset(): void {
        this.variancePerSecond = 0;
        this.lastPrice = null;
        this.lastTimestamp = null;
        this.initialized = false;
    }
}

// ---------------------------------------------------------------------------
// Final-window exit logic (last ~30s): cheap-leg dump + BS sell/hold on remainder
// ---------------------------------------------------------------------------

/** If a leg's best ask is at or below this, FOK-sell the entire position on that leg (when holding both). */
export const EXPIRY_CHEAP_LEG_ASK_THRESHOLD = 0.35;

/** Prior ask minus current ask on the held (remaining) leg counts as a "sudden" drop. */
export const EXPIRY_SUDDEN_ASK_DROP = 0.04;

/**
 * After a sudden drop on the remaining leg, sell if Black–Scholes prob of that outcome
 * is below this level; otherwise hold for settlement.
 * (P(outcome) = P(UP) when holding UP, 1 - P(UP) when holding DOWN.)
 */
export const EXPIRY_REMAINING_HOLD_MIN_BS_PROB = 0.45;

export function detectSuddenAskDrop(
    currentAsk: number,
    previousAsk: number | undefined | null,
): boolean {
    if (previousAsk === null || previousAsk === undefined || !Number.isFinite(previousAsk)) {
        return false;
    }
    return previousAsk - currentAsk >= EXPIRY_SUDDEN_ASK_DROP;
}

export function remainingLegBlackScholesSellOrHold(
    heldLeg: "UP" | "DOWN",
    pUp: number,
    suddenDrop: boolean,
): "SELL" | "HOLD" {
    if (!suddenDrop) return "HOLD";
    const pHeld = heldLeg === "UP" ? pUp : 1 - pUp;
    if (pHeld < EXPIRY_REMAINING_HOLD_MIN_BS_PROB) return "SELL";
    return "HOLD";
}
