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
 * EWMA volatility tracker calibrated for **sub-second Binance aggTrade data**.
 *
 * Strategy: bucket incoming ticks into 1-second bars, compute one log-return
 * per completed second, then apply EWMA with λ = 0.98 (≈ 50-second effective
 * lookback at 1 obs/sec).  This avoids the classic RiskMetrics λ = 0.94 mistake
 * where that value was designed for *daily* data and gives only ~1.7 s lookback
 * on tick data.
 *
 * `getAnnualizedVolatility()` returns σ in years, consistent with T-in-years
 * used in `computeUpProbability`.
 */
export class EWMAVolatility {
    /** λ for 1-obs/second data: effective lookback ≈ 1/(1-λ) seconds. */
    private readonly lambda = 0.98;
    /** L2 regularisation coefficient – prevents weight collapse under bad streaks. */
    private readonly l2 = 0.001;

    private variancePerSecond = 0;
    private initialized = false;

    // Second-bar state
    private currentSecond = -1;
    private barOpen: number | null = null;
    private barClose: number | null = null;

    update(price: number, timestamp: number): void {
        const sec = Math.floor(timestamp / 1000);

        if (this.currentSecond === -1) {
            // Very first tick – open first bar
            this.currentSecond = sec;
            this.barOpen = price;
            this.barClose = price;
            return;
        }

        if (sec === this.currentSecond) {
            // Same second – update close
            this.barClose = price;
        } else {
            // New second – commit the completed bar
            if (this.barOpen !== null && this.barClose !== null && this.barOpen > 0) {
                const logRet = Math.log(this.barClose / this.barOpen);
                const r2 = logRet * logRet;
                this.variancePerSecond = this.initialized
                    ? this.lambda * this.variancePerSecond + (1 - this.lambda) * r2
                    : r2;
                this.initialized = true;
            }
            // Start new bar (may skip empty seconds – that's fine)
            this.currentSecond = sec;
            this.barOpen = price;
            this.barClose = price;
        }
    }

    /** Returns σ in annualised terms (consistent with T in years). */
    getAnnualizedVolatility(): number {
        if (!this.initialized) return 0.8; // conservative fallback until first full second
        const raw = Math.sqrt(this.variancePerSecond * SECONDS_PER_YEAR);
        // Apply L2 shrinkage toward 0.8 to damp extreme estimates from thin markets
        return raw * (1 - this.l2) + 0.8 * this.l2;
    }

    reset(): void {
        this.variancePerSecond = 0;
        this.initialized = false;
        this.currentSecond = -1;
        this.barOpen = null;
        this.barClose = null;
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
