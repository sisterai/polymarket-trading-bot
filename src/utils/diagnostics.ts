import type { PricePrediction, MarketSnapshot } from "./pricePredictor";

// ═══════════════════════════════════════════════════════════════════════════
// Record Types
// ═══════════════════════════════════════════════════════════════════════════

export interface PredictionRecord {
    id: number;
    timestamp: number;

    // Market snapshot summary
    upAsk: number;
    downAsk: number | null;
    spread: number | null;

    // Model outputs
    predictedPrice: number;
    rawScore: number;
    pUp: number;
    pDown: number;
    edgeBuyUp: number;
    edgeBuyDown: number;

    // Decision
    direction: "up" | "down";
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    confidence: number;

    // Key features
    momentum: number;
    volatility: number;
    trend: number;

    // Smoothed price at prediction time (baseline for direction evaluation)
    basePrice: number;
}

export interface ResolvedRecord extends PredictionRecord {
    outcomePrice: number;
    outcomeTimestamp: number;
    actualDirection: "up" | "down";
    wasCorrect: boolean;
    realizedPnl: number;
}

export interface CalibrationBucket {
    rangeLabel: string;
    count: number;
    hitRate: number;
    avgConfidence: number;
}

export interface PerformanceStats {
    windowSize: number;
    totalPredictions: number;
    tradedCount: number;
    holdCount: number;
    hitRate: number;
    tradeHitRate: number;
    avgEdgeBeforeCost: number;
    avgEdgeAfterCost: number;
    noTradeRate: number;
    buyUpCount: number;
    buyUpHitRate: number;
    buyDownCount: number;
    buyDownHitRate: number;
    calibrationBuckets: CalibrationBucket[];
}

export interface HealthStatus {
    tradingAllowed: boolean;
    warnings: string[];
    recentAccuracy: number;
    spreadAnomaly: boolean;
    overconfident: boolean;
    rollingPnl: number;
    maxDrawdown: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PredictionDiagnostics
// Standalone observer — records predictions, resolves them against outcomes,
// computes rolling stats, and provides safety assessments.
// ═══════════════════════════════════════════════════════════════════════════

export class PredictionDiagnostics {
    private static readonly BUFFER_CAPACITY = 200;
    private static readonly HEALTH_WINDOW = 20;
    private static readonly ACCURACY_COLLAPSE_THRESHOLD = 0.35;
    private static readonly ACCURACY_COLLAPSE_MIN_SAMPLES = 15;
    private static readonly OVERCONFIDENCE_CONF_THRESHOLD = 0.72;
    private static readonly OVERCONFIDENCE_HIT_THRESHOLD = 0.50;
    private static readonly SPREAD_ANOMALY_THRESHOLD = 0.08;
    private static readonly SPREAD_ANOMALY_WINDOW = 10;
    // Stop trading if rolling PnL of recent trades drops below this (per-token PnL).
    private static readonly MAX_DRAWDOWN_THRESHOLD = -0.15;
    // Consecutive losing trade streak that triggers a warning.
    private static readonly LOSING_STREAK_LIMIT = 5;

    private resolved: ResolvedRecord[] = [];
    private pending: PredictionRecord | null = null;
    private seqCounter = 0;
    private totalPredictions = 0;
    private totalTrades = 0;
    private totalHolds = 0;

    // ── Recording ──────────────────────────────────────────────────────

    record(prediction: PricePrediction, snapshot: MarketSnapshot, basePrice: number): void {
        const rec: PredictionRecord = {
            id: this.seqCounter++,
            timestamp: snapshot.timestamp,
            upAsk: snapshot.bestAsk,
            downAsk: snapshot.downAsk,
            spread: snapshot.spread,
            predictedPrice: prediction.predictedPrice,
            rawScore: prediction.rawScore,
            pUp: prediction.pUp,
            pDown: prediction.pDown,
            edgeBuyUp: prediction.edgeBuyUp,
            edgeBuyDown: prediction.edgeBuyDown,
            direction: prediction.direction,
            signal: prediction.signal,
            confidence: prediction.confidence,
            momentum: prediction.features.momentum,
            volatility: prediction.features.volatility,
            trend: prediction.features.trend,
            basePrice,
        };

        this.pending = rec;
        this.totalPredictions++;
        if (prediction.signal === "HOLD") {
            this.totalHolds++;
        } else {
            this.totalTrades++;
        }
    }

    resolve(outcomePrice: number, outcomeTimestamp: number): void {
        if (!this.pending) return;

        const p = this.pending;
        const actualDirection: "up" | "down" = outcomePrice > p.basePrice ? "up" : "down";
        const wasCorrect = p.direction === actualDirection;

        // PnL: mark-to-market change if we bought the predicted direction.
        //
        // outcomePrice = UP token smoothed ask at the next pole.
        //
        // If direction == "up": we bought UP at upAsk.
        //   PnL = outcomePrice - upAsk  (UP token appreciated)
        //
        // If direction == "down": we bought DOWN at downAsk.
        //   The DOWN token's value moves inversely to UP token.
        //   Fair value approximation: Δ(DOWN) ≈ −Δ(UP).
        //   Entry cost = downAsk. Value change ≈ p.basePrice - outcomePrice (UP went down = good for DOWN).
        //   PnL ≈ (p.basePrice - outcomePrice) - (downAsk - (1 - p.basePrice))
        //       = (p.basePrice - outcomePrice) - downAsk + (1 - p.basePrice)
        //       = (1 - outcomePrice) - downAsk
        //
        // Note: this is an approximation — the DOWN token on Polymarket doesn't
        // track 1−UP exactly at every instant, but it converges at resolution.
        let realizedPnl: number;
        if (p.direction === "up") {
            realizedPnl = outcomePrice - p.upAsk;
        } else {
            const downEntry = p.downAsk ?? (1 - p.upAsk);
            realizedPnl = (1 - outcomePrice) - downEntry;
        }

        const resolved: ResolvedRecord = {
            ...p,
            outcomePrice,
            outcomeTimestamp,
            actualDirection,
            wasCorrect,
            realizedPnl,
        };

        this.resolved.push(resolved);
        if (this.resolved.length > PredictionDiagnostics.BUFFER_CAPACITY) {
            this.resolved.shift();
        }

        this.pending = null;
    }

    // ── Stats ──────────────────────────────────────────────────────────

    getStats(window?: number): PerformanceStats {
        const records = window
            ? this.resolved.slice(-window)
            : this.resolved;

        const n = records.length;
        if (n === 0) {
            return this.emptyStats(0);
        }

        const traded = records.filter(r => r.signal !== "HOLD");
        const holds = n - traded.length;
        const correct = records.filter(r => r.wasCorrect);
        const tradedCorrect = traded.filter(r => r.wasCorrect);
        const buyUp = records.filter(r => r.signal === "BUY_UP");
        const buyDown = records.filter(r => r.signal === "BUY_DOWN");

        const avgEdgeBefore = this.avg(records.map(r => Math.max(r.edgeBuyUp, r.edgeBuyDown)));
        const avgEdgeAfter = this.avg(traded.map(r => r.realizedPnl));

        return {
            windowSize: n,
            totalPredictions: this.totalPredictions,
            tradedCount: traded.length,
            holdCount: holds,
            hitRate: correct.length / n,
            tradeHitRate: traded.length > 0 ? tradedCorrect.length / traded.length : 0,
            avgEdgeBeforeCost: avgEdgeBefore,
            avgEdgeAfterCost: avgEdgeAfter,
            noTradeRate: holds / n,
            buyUpCount: buyUp.length,
            buyUpHitRate: buyUp.length > 0 ? buyUp.filter(r => r.wasCorrect).length / buyUp.length : 0,
            buyDownCount: buyDown.length,
            buyDownHitRate: buyDown.length > 0 ? buyDown.filter(r => r.wasCorrect).length / buyDown.length : 0,
            calibrationBuckets: this.computeCalibration(records),
        };
    }

    private computeCalibration(records: readonly ResolvedRecord[]): CalibrationBucket[] {
        const ranges: Array<{ lo: number; hi: number; label: string }> = [
            { lo: 0.50, hi: 0.60, label: "0.50-0.60" },
            { lo: 0.60, hi: 0.70, label: "0.60-0.70" },
            { lo: 0.70, hi: 0.80, label: "0.70-0.80" },
            { lo: 0.80, hi: 0.90, label: "0.80-0.90" },
            { lo: 0.90, hi: 1.01, label: "0.90-1.00" },
        ];

        return ranges.map(({ lo, hi, label }) => {
            const bucket = records.filter(r => r.confidence >= lo && r.confidence < hi);
            const count = bucket.length;
            return {
                rangeLabel: label,
                count,
                hitRate: count > 0 ? bucket.filter(r => r.wasCorrect).length / count : 0,
                avgConfidence: count > 0 ? this.avg(bucket.map(r => r.confidence)) : 0,
            };
        });
    }

    // ── Health ─────────────────────────────────────────────────────────

    getHealthStatus(): HealthStatus {
        const warnings: string[] = [];
        let tradingAllowed = true;

        // Single-pass scan over the tail of the resolved buffer.
        // Computes all health metrics at once instead of multiple slice+filter passes.
        const buf = this.resolved;
        const n = buf.length;
        const healthStart = Math.max(0, n - PredictionDiagnostics.HEALTH_WINDOW);
        const spreadStart = Math.max(0, n - PredictionDiagnostics.SPREAD_ANOMALY_WINDOW);
        const scanStart = Math.min(healthStart, spreadStart);

        let healthCorrect = 0;
        let healthCount = 0;
        let confidenceSum = 0;
        let spreadSum = 0;
        let spreadCount = 0;
        let rollingPnl = 0;
        let peakPnl = 0;
        let maxDrawdown = 0;
        let losingStreak = 0;
        let maxLosingStreak = 0;

        for (let i = scanStart; i < n; i++) {
            const r = buf[i];

            if (i >= healthStart) {
                healthCount++;
                if (r.wasCorrect) healthCorrect++;
                confidenceSum += r.confidence;
            }

            if (i >= spreadStart && r.spread !== null) {
                spreadSum += r.spread;
                spreadCount++;
            }

            // Drawdown tracking — across entire resolved buffer
            if (r.signal !== "HOLD") {
                rollingPnl += r.realizedPnl;
                peakPnl = Math.max(peakPnl, rollingPnl);
                maxDrawdown = Math.min(maxDrawdown, rollingPnl - peakPnl);
            }

            // Losing streak (for traded signals only)
            if (r.signal !== "HOLD") {
                if (!r.wasCorrect) {
                    losingStreak++;
                    maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
                } else {
                    losingStreak = 0;
                }
            }
        }

        const recentAccuracy = healthCount > 0 ? healthCorrect / healthCount : 0.5;

        // Accuracy collapse
        if (healthCount >= PredictionDiagnostics.ACCURACY_COLLAPSE_MIN_SAMPLES &&
            recentAccuracy < PredictionDiagnostics.ACCURACY_COLLAPSE_THRESHOLD) {
            tradingAllowed = false;
            warnings.push(`accuracy collapsed to ${(recentAccuracy * 100).toFixed(0)}% over last ${healthCount} predictions`);
        }

        // Overconfidence
        const avgConf = healthCount > 0 ? confidenceSum / healthCount : 0;
        const overconfident =
            healthCount >= 10 &&
            avgConf > PredictionDiagnostics.OVERCONFIDENCE_CONF_THRESHOLD &&
            recentAccuracy < PredictionDiagnostics.OVERCONFIDENCE_HIT_THRESHOLD;
        if (overconfident) {
            warnings.push("overconfident: high avg confidence but low hit rate");
        }

        // Spread anomaly
        const avgSpread = spreadCount > 0 ? spreadSum / spreadCount : 0;
        const spreadAnomaly = spreadCount >= 5 &&
            avgSpread > PredictionDiagnostics.SPREAD_ANOMALY_THRESHOLD;
        if (spreadAnomaly) {
            warnings.push(`spread anomaly: avg spread ${avgSpread.toFixed(3)} over last ${spreadCount} quotes`);
        }

        // Max drawdown gate
        if (maxDrawdown < PredictionDiagnostics.MAX_DRAWDOWN_THRESHOLD) {
            tradingAllowed = false;
            warnings.push(`drawdown limit hit: ${(maxDrawdown * 100).toFixed(1)}% (threshold: ${(PredictionDiagnostics.MAX_DRAWDOWN_THRESHOLD * 100).toFixed(0)}%)`);
        }

        // Losing streak warning
        if (maxLosingStreak >= PredictionDiagnostics.LOSING_STREAK_LIMIT) {
            warnings.push(`${maxLosingStreak} consecutive losing trades`);
        }

        return { tradingAllowed, warnings, recentAccuracy, spreadAnomaly, overconfident, rollingPnl, maxDrawdown };
    }

    // ── Export / Logging ───────────────────────────────────────────────

    dumpRecords(): ResolvedRecord[] {
        return [...this.resolved];
    }

    formatStatsLog(): string {
        const s = this.getStats();
        const h = this.getHealthStatus();

        const lines: string[] = [
            `--- DIAGNOSTICS (${s.totalPredictions} total, ${s.windowSize} in window) ---`,
            `Hit rate: ${(s.hitRate * 100).toFixed(1)}% | Trade hit rate: ${(s.tradeHitRate * 100).toFixed(1)}%`,
            `Traded: ${s.tradedCount} | Hold: ${s.holdCount} | No-trade rate: ${(s.noTradeRate * 100).toFixed(0)}%`,
            `BUY_UP: ${s.buyUpCount} (${(s.buyUpHitRate * 100).toFixed(0)}%) | BUY_DOWN: ${s.buyDownCount} (${(s.buyDownHitRate * 100).toFixed(0)}%)`,
            `Avg edge before cost: ${(s.avgEdgeBeforeCost * 100).toFixed(2)}% | after cost: ${(s.avgEdgeAfterCost * 100).toFixed(2)}%`,
            `Rolling PnL: ${(h.rollingPnl * 100).toFixed(2)}% | Max drawdown: ${(h.maxDrawdown * 100).toFixed(2)}%`,
            `Calibration: ${s.calibrationBuckets.map(b => `[${b.rangeLabel}] n=${b.count} hit=${(b.hitRate * 100).toFixed(0)}%`).join(" | ")}`,
        ];

        if (h.warnings.length > 0) {
            lines.push(`WARNINGS: ${h.warnings.join("; ")}`);
        }
        if (!h.tradingAllowed) {
            lines.push("** TRADING DISABLED BY SAFETY HOOK **");
        }

        return lines.join("\n");
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private avg(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((a, b) => a + b, 0) / values.length;
    }

    private emptyStats(windowSize: number): PerformanceStats {
        return {
            windowSize,
            totalPredictions: this.totalPredictions,
            tradedCount: 0,
            holdCount: 0,
            hitRate: 0,
            tradeHitRate: 0,
            avgEdgeBeforeCost: 0,
            avgEdgeAfterCost: 0,
            noTradeRate: 0,
            buyUpCount: 0,
            buyUpHitRate: 0,
            buyDownCount: 0,
            buyDownHitRate: 0,
            calibrationBuckets: [],
        };
    }
}
