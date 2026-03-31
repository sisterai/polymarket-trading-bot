import { logger } from "./logger";

/**
 * Price prediction result
 */
export interface PricePrediction {
    predictedPrice: number;
    confidence: number; // 0-1, higher = more confident
    direction: "up" | "down"; // No neutral - always up or down
    signal: "BUY_UP" | "BUY_DOWN" | "HOLD";
    features: {
        momentum: number;
        volatility: number;
        trend: number;
    };
    isPoleValue?: boolean; // True if prediction was made at a pole (peak/trough)
}

/**
 * Adaptive Multi-Feature Linear Regression Price Predictor
 * 
 * Uses multiple features (price history, momentum, volatility, spread) to predict next price.
 * Adapts weights in real-time using online gradient descent.
 * 
 * Performance: ~12-15ms per prediction
 */
export class AdaptivePricePredictor {
    // Price history (circular buffer) - stores smoothed prices
    private priceHistory: number[] = [];
    private timestamps: number[] = [];
    private readonly maxHistorySize = 10;
    
    // Noise filtering - ignore changes < 0.02 (only filter UNDER 0.02, consider >= 0.02)
    private readonly noiseThreshold = 0.02; // Ignore price changes < 0.02 (must be >= 0.02 to be considered)
    private smoothedPrice: number | null = null; // Current smoothed price
    private lastAddedPrice: number | null = null; // Last price added to history
    private smoothingAlpha = 0.5; // EMA smoothing factor (0.5 = balanced, more responsive to actual price changes)
    
    // Stability detection (for periods of no movement)
    private stablePriceCount = 0; // Count of consecutive stable prices
    private readonly maxStableCount = 5; // After this many stable prices, reduce confidence
    private lastStablePrice: number | null = null;
    
    // Model weights (learned parameters)
    // IMPROVED: Based on log analysis showing stronger trend/momentum and lower volatility correlate with success
    private weights: {
        intercept: number;
        priceLag1: number; // Previous price
        priceLag2: number; // 2 periods ago
        priceLag3: number; // 3 periods ago
        momentum: number;
        volatility: number;
        trend: number;
    } = {
        intercept: 0.5,
        priceLag1: 0.25, // Reduced - recent price less important than trend/momentum
        priceLag2: 0.08,
        priceLag3: 0.04,
        momentum: 0.35, // INCREASED - stronger momentum correlates with success
        volatility: -0.20, // INCREASED penalty - lower volatility strongly correlates with success
        trend: 0.45, // INCREASED - stronger trend signals correlate with success (most reliable)
    };
    
    // Learning parameters
    private readonly learningRate = 0.05; // Increased from 0.01 for faster learning
    private readonly minLearningRate = 0.005; // Increased minimum
    private readonly maxLearningRate = 0.2; // Increased maximum
    
    // Statistics for normalization
    private priceMean = 0.5;
    private priceStd = 0.1;
    private predictionCount = 0;
    private correctPredictions = 0;
    
    // Recent accuracy tracking (sliding window for better adaptation)
    private recentPredictions: Array<{ correct: boolean; confidence: number }> = [];
    private readonly recentWindowSize = 20; // Track last 20 predictions
    
    // EMA for trend - using shorter periods for faster response
    private emaShort = 0.5; // Fast EMA (2 periods) - faster response
    private emaLong = 0.5; // Slow EMA (5 periods) - medium response
    private readonly alphaShort = 2 / (2 + 1); // Faster EMA
    private readonly alphaLong = 2 / (5 + 1); // Medium EMA
    
    // Pole detection (peaks and troughs) - only predict at pole values
    private poleHistory: Array<{ price: number; type: "peak" | "trough"; timestamp: number }> = [];
    private lastPolePrice: number | null = null;
    private lastPoleType: "peak" | "trough" | null = null;
    private lastPrediction: PricePrediction | null = null;
    private lastPredictionFeatures: {
        priceLag1: number; priceLag2: number; priceLag3: number;
        momentum: number; volatility: number; trend: number;
    } | null = null;
    
    // Price range limits - stop predictions outside this range
    private readonly minPrice = 0.003; // Stop predictions if price < 0.003
    private readonly maxPrice = 0.97; // Stop predictions if price > 0.97
    
    /**
     * Update predictor with new price
     * Returns prediction for next price
     */
    public updateAndPredict(price: number, timestamp: number): PricePrediction | null {
        const startTime = Date.now();
        
        // CRITICAL: Stop predictions if price is outside valid range (0.003 to 0.97)
        if (price < this.minPrice || price > this.maxPrice) {
            // Price outside valid range - stop predictions until next market
            // Predictions will resume when reset() is called (new market cycle)
            return null;
        }
        
        // Apply noise filtering: smooth the price first
        if (this.smoothedPrice === null) {
            // Initialize with first price
            this.smoothedPrice = price;
            this.lastAddedPrice = price;
            this.priceHistory.push(price);
            this.timestamps.push(timestamp);
            // Return null - not enough data for prediction yet
            return null;
        }
        
        // Check ACTUAL price change first (before smoothing) - use raw price for threshold check
        const actualPriceChange = this.lastAddedPrice !== null 
            ? Math.abs(price - this.lastAddedPrice)
            : 0;
        
        // CRITICAL: Filter only changes UNDER 0.02 (strictly < 0.02)
        // Changes >= 0.02 should be considered for prediction
        if (this.lastAddedPrice !== null && actualPriceChange < this.noiseThreshold) {
            // Price change too small (< 0.02) - ignore completely, don't make prediction, don't add to history
            return null;
        }
        
        // Update smoothed price using EMA (only if change is significant)
        this.smoothedPrice = this.smoothingAlpha * price + (1 - this.smoothingAlpha) * (this.smoothedPrice ?? price);
        
        // Also check smoothed price is in valid range
        if (this.smoothedPrice < this.minPrice || this.smoothedPrice > this.maxPrice) {
            return null;
        }
        
        // Use smoothed price change for further processing (but threshold already checked with raw price)
        const smoothedPriceChange = Math.abs(this.smoothedPrice - (this.lastAddedPrice ?? this.smoothedPrice));
        
        // Only process if change is significant (>= 0.02)
        // Detect stability (using smoothed change for stability detection)
        const isStable = smoothedPriceChange < this.noiseThreshold;
        
        if (isStable) {
            this.stablePriceCount++;
            if (this.lastStablePrice !== null && Math.abs(this.smoothedPrice - this.lastStablePrice) < 0.001) {
                // Price is completely stable
            } else {
                this.lastStablePrice = this.smoothedPrice;
            }
        } else {
            this.stablePriceCount = 0;
            this.lastStablePrice = null;
        }
        
        // Add to history (change is significant >= 0.02)
        this.priceHistory.push(this.smoothedPrice);
        this.timestamps.push(timestamp);
        this.lastAddedPrice = this.smoothedPrice;
        
        // Maintain history size
        if (this.priceHistory.length > this.maxHistorySize) {
            this.priceHistory.shift();
            this.timestamps.shift();
        }
        
        // Need at least 3 prices for prediction
        if (this.priceHistory.length < 3) {
            return null; // Not enough data
        }
        
        // Use smoothed price for all calculations
        const currentSmoothedPrice = this.smoothedPrice ?? price;
        
        // CRITICAL: Only make predictions at pole values (peaks and troughs)
        const isPole = this.detectPole(currentSmoothedPrice, timestamp);
        
        // If not at a pole, return null - NO PREDICTION
        if (!isPole) {
            return null;
        }
        
        // Update statistics
        this.updateStatistics();
        
        const features = this.calculateFeatures();
        this.lastPredictionFeatures = features;

        const predictedPrice = this.predictPrice(features);
        
        // Update EMA with smoothed price
        this.updateEMA(currentSmoothedPrice);
        
        // Learn from previous prediction if we have enough history
        if (this.priceHistory.length >= 4) {
            this.learnFromPreviousPrediction();
        }
        
        const recentAccuracy = this.getRecentAccuracy();
        const confidence = this.calculateConfidence(features, predictedPrice, currentSmoothedPrice, recentAccuracy);

        const direction = this.getDirection(predictedPrice, currentSmoothedPrice, features);

        const signal = this.generateSignal(direction, confidence, features, recentAccuracy);
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 20) {
            logger.error(`Price prediction took ${elapsed}ms (exceeds 20ms limit)`);
        }
        
        const prediction: PricePrediction = {
            predictedPrice,
            confidence,
            direction,
            signal,
            isPoleValue: isPole,
            features: {
                momentum: features.momentum,
                volatility: features.volatility,
                trend: features.trend,
            },
        };
        
        // Store prediction for reuse when not at pole
        this.lastPrediction = prediction;
        
        return prediction;
    }
    
    private recordPole(price: number, type: "peak" | "trough", timestamp: number): void {
        this.lastPolePrice = price;
        this.lastPoleType = type;
        this.poleHistory.push({ price, type, timestamp });
        if (this.poleHistory.length > 10) this.poleHistory.shift();
    }

    private detectPole(currentPrice: number, timestamp: number): boolean {
        // Need at least 3 prices to detect a pole
        if (this.priceHistory.length < 3) {
            return false;
        }
        
        const n = this.priceHistory.length;
        const centerIdx = n - 1; // Current price is at the end
        const centerPrice = this.priceHistory[centerIdx];
        
        // Check if current price is a local peak (higher than previous prices)
        // or trough (lower than previous prices)
        if (centerIdx >= 2) {
            let isPeak = true;
            let isTrough = true;
            
            // Check at least 2 previous prices
            const lookback = Math.min(3, centerIdx);
            for (let i = centerIdx - lookback; i < centerIdx; i++) {
                const price = this.priceHistory[i];
                // For peak: all previous prices must be strictly lower
                if (price >= centerPrice) isPeak = false;
                // For trough: all previous prices must be strictly higher
                if (price <= centerPrice) isTrough = false;
            }
            
            // Check if this is a pole (peak or trough)
            if (isPeak || isTrough) {
                // Check if change from last pole is significant (> 0.019)
                if (this.lastPolePrice === null) {
                    // First pole - always accept
                    this.recordPole(centerPrice, isPeak ? "peak" : "trough", timestamp);
                    return true;
                } else {
                    const changeFromLastPole = Math.abs(centerPrice - this.lastPolePrice);
                    const isDifferentPoleType = (isPeak && this.lastPoleType === "trough") ||
                                                (isTrough && this.lastPoleType === "peak");

                    if (changeFromLastPole >= this.noiseThreshold || isDifferentPoleType) {
                        this.recordPole(centerPrice, isPeak ? "peak" : "trough", timestamp);
                        return true;
                    }
                    return false;
                }
            }
        }
        
        return false; // Not at a pole
    }
    
    /**
     * Calculate features from price history
     */
    private calculateFeatures(): {
        priceLag1: number;
        priceLag2: number;
        priceLag3: number;
        momentum: number;
        volatility: number;
        trend: number;
    } {
        const n = this.priceHistory.length;
        const currentPrice = this.priceHistory[n - 1];
        const priceLag1 = n >= 2 ? this.priceHistory[n - 2] : currentPrice;
        const priceLag2 = n >= 3 ? this.priceHistory[n - 3] : priceLag1;
        const priceLag3 = n >= 4 ? this.priceHistory[n - 4] : priceLag2;

        const shortMom = priceLag1 > 0 ? (currentPrice - priceLag1) / priceLag1 : 0;

        let momentum = shortMom;
        if (n >= 4) {
            const longMom = (currentPrice - priceLag2) / (priceLag2 + 0.0001);
            const sameSign = (shortMom > 0 && longMom > 0) || (shortMom < 0 && longMom < 0);
            if (sameSign) {
                momentum = (shortMom + longMom) / 2;
            }
        }

        const emaTrend = this.emaShort - this.emaLong;
        const momentumTrend = momentum * 0.5;
        const priceChangeTrend = n >= 3 ? (currentPrice - priceLag2) / (priceLag2 + 0.0001) * 0.3 : 0;
        const combinedTrend = emaTrend * 0.4 + momentumTrend * 0.4 + priceChangeTrend * 0.2;

        return {
            priceLag1: this.normalizePrice(priceLag1),
            priceLag2: this.normalizePrice(priceLag2),
            priceLag3: this.normalizePrice(priceLag3),
            momentum: this.normalizeMomentum(momentum),
            volatility: this.normalizeVolatility(this.calculateVolatility()),
            trend: this.normalizeTrend(combinedTrend),
        };
    }
    
    /**
     * Calculate volatility from smoothed price history
     */
    private calculateVolatility(): number {
        const n = this.priceHistory.length;
        if (n < 3) return 0;
        
        const recentPrices = this.priceHistory.slice(-5);
        const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
        const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length;
        return Math.sqrt(variance);
    }
    
    /**
     * Predict price using linear regression
     */
    private predictPrice(features: ReturnType<typeof this.calculateFeatures>): number {
        const prediction = 
            this.weights.intercept +
            this.weights.priceLag1 * features.priceLag1 +
            this.weights.priceLag2 * features.priceLag2 +
            this.weights.priceLag3 * features.priceLag3 +
            this.weights.momentum * features.momentum +
            this.weights.volatility * features.volatility +
            this.weights.trend * features.trend;
        
        // Denormalize
        return this.denormalizePrice(prediction);
    }
    
    private learnFromPreviousPrediction(): void {
        if (this.priceHistory.length < 4 || !this.lastPredictionFeatures) return;

        const n = this.priceHistory.length;
        const actualPrice = this.priceHistory[n - 1];
        const previousPrice = this.priceHistory[n - 2];

        const prevFeatures = this.lastPredictionFeatures;
        const predictedPrice = this.predictPrice(prevFeatures);
        const error = actualPrice - predictedPrice;

        const normalizedError = Math.min(1, Math.abs(error) * 10);

        const predictedDir = predictedPrice > previousPrice ? 1 : (predictedPrice < previousPrice ? -1 : 0);
        const actualDir = actualPrice > previousPrice ? 1 : (actualPrice < previousPrice ? -1 : 0);
        const wasWrong = predictedDir !== actualDir && predictedDir !== 0 && actualDir !== 0;
        const directionCorrect = predictedDir === actualDir && predictedDir !== 0;

        const errorMultiplier = wasWrong ? 8.0 : 2.5;
        const adaptiveLR = Math.max(
            this.minLearningRate,
            Math.min(this.maxLearningRate, this.learningRate * (1 + normalizedError * errorMultiplier)),
        );

        const decay = wasWrong ? 0.85 : 0.97;
        this.weights.intercept  = this.weights.intercept  * decay + adaptiveLR * error;
        this.weights.priceLag1  = this.weights.priceLag1  * decay + adaptiveLR * error * prevFeatures.priceLag1;
        this.weights.priceLag2  = this.weights.priceLag2  * decay + adaptiveLR * error * prevFeatures.priceLag2;
        this.weights.priceLag3  = this.weights.priceLag3  * decay + adaptiveLR * error * prevFeatures.priceLag3;
        this.weights.momentum   = this.weights.momentum   * decay + adaptiveLR * error * prevFeatures.momentum;
        this.weights.volatility = this.weights.volatility * decay + adaptiveLR * error * prevFeatures.volatility;
        this.weights.trend      = this.weights.trend      * decay + adaptiveLR * error * prevFeatures.trend;

        this.predictionCount++;
        if (directionCorrect) this.correctPredictions++;

        const lastConfidence = this.lastPrediction?.confidence ?? 0.5;
        this.recentPredictions.push({ correct: directionCorrect, confidence: lastConfidence });
        if (this.recentPredictions.length > this.recentWindowSize) {
            this.recentPredictions.shift();
        }
    }
    
    private getRecentAccuracy(): number {
        if (this.recentPredictions.length === 0) return 0.6;
        const correct = this.recentPredictions.filter(p => p.correct).length;
        return correct / this.recentPredictions.length;
    }

    private calculateConfidence(
        features: ReturnType<typeof this.calculateFeatures>,
        predictedPrice: number,
        currentPrice: number,
        recentAccuracy: number,
    ): number {
        // Base confidence on:
        // 1. Volatility (lower volatility = higher confidence)
        // 2. Trend strength (stronger trend = higher confidence)
        // 3. Momentum consistency
        // 4. Prediction magnitude (larger predicted change = higher confidence if trend aligns)
        
        // IMPROVED: Based on analysis - lower volatility (0.086) vs wrong (0.093) correlates with success
        // Apply MUCH stronger penalty for high volatility (> 0.08)
        const volatilityPenalty = features.volatility > 0.08 ? 0.25 : (features.volatility > 0.06 ? 0.10 : 0); // Extra penalty for high volatility
        const volatilityFactor = Math.max(0.20, 1 - features.volatility * 12 - volatilityPenalty); // Increased multiplier from 10 to 12
        
        // IMPROVED: Based on analysis - stronger trend (0.018) vs wrong (-0.009) correlates with success
        const trendFactor = Math.min(1, Math.abs(features.trend) * 10); // INCREASED multiplier from 8 to 10
        
        // IMPROVED: Based on analysis - stronger momentum (0.006) vs wrong (-0.004) correlates with success
        const momentumFactor = Math.min(1, Math.abs(features.momentum) * 4); // INCREASED multiplier from 3 to 4
        
        // Prediction magnitude factor - if prediction is significant and aligns with trend
        // Only consider changes >= 0.02, ignore < 0.02
        const predDiff = Math.abs(predictedPrice - currentPrice);
        const predMagnitudeFactor = predDiff >= this.noiseThreshold 
            ? Math.min(1, predDiff * 20) // Larger predicted change = higher confidence (only if >= 0.02)
            : 0; // Ignore predictions with changes < 0.02
        
        // Momentum-direction alignment
        const momentumAlignment = (features.momentum > 0 && predictedPrice > currentPrice) || 
                                  (features.momentum < 0 && predictedPrice < currentPrice) ? 1.0 : 0.7;
        
        const overallAccuracy = this.predictionCount > 10
            ? this.correctPredictions / this.predictionCount
            : 0.6;

        const accuracyRate = recentAccuracy * 0.6 + overallAccuracy * 0.4;
        
        // Stability penalty: reduce confidence if price has been stable for too long
        let stabilityFactor = 1.0;
        if (this.stablePriceCount > this.maxStableCount) {
            // Price is very stable - reduce confidence significantly
            stabilityFactor = Math.max(0.5, 1.0 - (this.stablePriceCount - this.maxStableCount) * 0.1);
        } else if (this.stablePriceCount > 0) {
            // Slightly reduce confidence for stable prices
            stabilityFactor = 0.9;
        }
        
        let confidence = (
            volatilityFactor  * 0.12 +
            trendFactor       * 0.31 +
            momentumFactor    * 0.19 +
            predMagnitudeFactor * 0.08 +
            accuracyRate      * 0.21 +
            momentumAlignment * 0.09
        );
        
        // Apply overconfidence penalty if recent high-confidence predictions were wrong
        if (this.recentPredictions.length >= 10) {
            const highConfPredictions = this.recentPredictions.filter(p => p.confidence >= 0.80);
            if (highConfPredictions.length >= 5) {
                const highConfAccuracy = highConfPredictions.filter(p => p.correct).length / highConfPredictions.length;
                // If high confidence predictions have low accuracy, we're overconfident
                if (highConfAccuracy < 0.65) {
                    // Reduce confidence more aggressively for overconfident model
                    const overconfidencePenalty = 0.85 - (0.65 - highConfAccuracy) * 0.5; // Penalty up to 20%
                    confidence *= Math.max(0.70, overconfidencePenalty);
                }
            }
        }
        
        // Apply stability factor - more penalty for unstable prices
        confidence *= Math.max(0.85, stabilityFactor); // More penalty for stability issues
        
        // IMPROVED: Based on analysis - require stronger trend/momentum signals for confidence boost
        // Analysis shows successful predictions have avg trend 0.018 vs wrong -0.009
        // Analysis shows successful predictions have avg momentum 0.006 vs wrong -0.004
        const strongTrend = Math.abs(features.trend) > 0.015; // LOWERED threshold from 0.05 - analysis shows even small positive trends matter
        const strongMomentum = Math.abs(features.momentum) > 0.005; // LOWERED threshold from 0.03 - analysis shows even small positive momentum matters
        const aligned = (features.trend > 0 && features.momentum > 0) || (features.trend < 0 && features.momentum < 0);
        
        // IMPROVED: More aggressive boost for aligned strong signals (analysis shows this correlates with success)
        if (strongTrend && strongMomentum && aligned && accuracyRate >= 0.55) {
            // Strong aligned signals - increased boost based on analysis
            const alignmentStrength = Math.min(1, (Math.abs(features.trend) + Math.abs(features.momentum)) * 6.0); // Increased from 5.0
            confidence = Math.min(0.95, confidence * (1 + alignmentStrength * 0.40)); // INCREASED from 0.35 to 0.40
        } else if ((strongTrend || strongMomentum) && accuracyRate >= 0.55) {
            // Only one strong signal - moderate boost
            confidence = Math.min(0.90, confidence * 1.15); // INCREASED from 1.10 to 1.15
        }
        
        // ADDITIONAL: Penalize high volatility more aggressively (analysis shows lower vol = success)
        if (features.volatility > 0.09) {
            // Very high volatility reduces confidence significantly
            confidence *= 0.80; // 20% penalty for very high volatility
        } else if (features.volatility > 0.08) {
            // High volatility reduces confidence
            confidence *= 0.88; // 12% penalty for high volatility
        } else if (features.volatility > 0.06) {
            // Moderate volatility - slight penalty
            confidence *= 0.95; // 5% penalty for moderate volatility
        }
        
        // Boost confidence if prediction magnitude is large AND aligns with trend AND accuracy is good
        if (predDiff >= 0.02 && aligned && accuracyRate >= 0.55) {
            confidence = Math.min(0.95, confidence * 1.20); // Reduced boost, cap at 95%
        }
        
        // Additional boost for very large predictions (>= 0.10) with alignment
        if (predDiff >= 0.10 && aligned && accuracyRate >= 0.60) {
            confidence = Math.min(0.95, confidence * 1.10); // Reduced boost, cap at 95%
        }
        
        if (this.recentPredictions.length >= 10) {
            const maxConfidence = Math.min(0.92, 0.60 + recentAccuracy * 0.32);
            confidence = Math.min(maxConfidence, confidence);

            if (recentAccuracy < 0.55) {
                confidence = Math.min(0.75, confidence);
            } else if (recentAccuracy < 0.60) {
                confidence = Math.min(0.80, confidence);
            } else if (recentAccuracy < 0.65) {
                confidence = Math.min(0.85, confidence);
            }
        } else {
            confidence = Math.min(0.85, confidence);
        }
        
        // ABSOLUTE HARD CAP: Never allow confidence above 92% (100% confidence is often wrong)
        confidence = Math.min(0.92, confidence);
        
        // STRICT PENALTY: If trend and momentum don't align, significantly reduce confidence
        if ((features.trend > 0 && features.momentum < -0.03) || (features.trend < 0 && features.momentum > 0.03)) {
            confidence = Math.max(0.35, confidence * 0.70); // Strong penalty for misalignment
        }
        
        // Special case: if price is very stable, lower confidence significantly
        if (this.stablePriceCount > this.maxStableCount * 2) {
            confidence = Math.max(0.35, confidence * 0.65); // Strong penalty for very stable prices
        }
        
        // CRITICAL: Don't allow minimum confidence to be too high - let weak signals be filtered out
        // If confidence is below 55%, it's likely a weak signal - don't force it to 50%
        return Math.max(0.40, Math.min(1, confidence)); // Lower minimum to allow filtering of weak signals
    }
    
    private getDirection(
        predictedPrice: number,
        currentPrice: number,
        features: ReturnType<typeof this.calculateFeatures>,
    ): "up" | "down" {
        const diff = predictedPrice - currentPrice;
        const effectiveThreshold = this.stablePriceCount > this.maxStableCount
            ? this.noiseThreshold * 2
            : this.noiseThreshold;

        if (Math.abs(diff) >= effectiveThreshold) {
            const predDir = diff > 0 ? "up" : "down" as const;
            const momentumAligned = (predDir === "up" && features.momentum > -0.01) ||
                                    (predDir === "down" && features.momentum < 0.01);
            const trendAligned = (predDir === "up" && features.trend > -0.01) ||
                                 (predDir === "down" && features.trend < 0.01);

            if (momentumAligned || trendAligned) return predDir;

            if (features.trend > 0.001 || features.momentum > 0.001) return "up";
            if (features.trend < -0.001 || features.momentum < -0.001) return "down";
            return predDir;
        }

        if (features.trend > 0.001) return "up";
        if (features.trend < -0.001) return "down";
        if (features.momentum > 0.001) return "up";
        if (features.momentum < -0.001) return "down";
        if (this.lastPoleType === "peak") return "down";
        if (this.lastPoleType === "trough") return "up";
        return "up";
    }
    
    private generateSignal(
        direction: "up" | "down",
        confidence: number,
        features: ReturnType<typeof this.calculateFeatures>,
        recentAccuracy: number,
    ): "BUY_UP" | "BUY_DOWN" | "HOLD" {
        const minConfidenceForTrade = recentAccuracy < 0.50 ? 0.65 : (recentAccuracy < 0.55 ? 0.60 : 0.55);
        
        // Very high confidence: trade if confidence >= 75% AND trend/momentum align
        if (confidence >= 0.75) {
            const strongTrend = Math.abs(features.trend) > 0.012;
            const aligned = (direction === "up" && features.trend > 0.012 && features.momentum > -0.03) ||
                           (direction === "down" && features.trend < -0.012 && features.momentum < 0.03);
            const lowVolatility = features.volatility < 0.10; // More lenient volatility requirement
            
            if (strongTrend && aligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // High confidence: require strong alignment (68-75%)
        if (confidence >= 0.68) {
            const strongTrend = Math.abs(features.trend) > 0.015;
            const trendAligned = (direction === "up" && features.trend > 0.015) || 
                                (direction === "down" && features.trend < -0.015);
            const momentumAligned = (direction === "up" && features.momentum > -0.04) || 
                                   (direction === "down" && features.momentum < 0.04);
            const lowVolatility = features.volatility < 0.10;
            
            if (strongTrend && trendAligned && momentumAligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Medium-high confidence: require strong alignment (62-68%)
        if (confidence >= 0.62) {
            const strongTrend = Math.abs(features.trend) > 0.018;
            const aligned = (direction === "up" && features.trend > 0.018 && features.momentum > -0.04) ||
                           (direction === "down" && features.trend < -0.018 && features.momentum < 0.04);
            const lowVolatility = features.volatility < 0.11;
            
            if (strongTrend && aligned && lowVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Medium confidence: require good alignment (55-62%) - this is where most trades should happen
        if (confidence >= minConfidenceForTrade) {
            // For medium confidence, require strong trend OR strong momentum with alignment
            // Trend is normalized to [-1, 1], so 0.15 = 15% of max range
            const strongTrend = Math.abs(features.trend) > 0.12; // Strong trend threshold (12% normalized = 0.012 raw)
            const goodMomentum = Math.abs(features.momentum) > 0.02; // Good momentum
            const aligned = (direction === "up" && features.trend > 0.08 && features.momentum > -0.05) ||
                           (direction === "down" && features.trend < -0.08 && features.momentum < 0.05);
            const acceptableVolatility = features.volatility < 0.12;
            
            // Trade if: (strong trend AND aligned) OR (good momentum AND aligned AND acceptable volatility)
            if ((strongTrend && aligned && acceptableVolatility) || 
                (goodMomentum && aligned && acceptableVolatility && confidence >= 0.55)) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Lower confidence (50-55%): Only trade if trend is VERY strong
        if (confidence >= 0.50 && recentAccuracy >= 0.50) {
            const veryStrongTrend = Math.abs(features.trend) > 0.15; // Very strong trend (15%+ normalized)
            const aligned = (direction === "up" && features.trend > 0.12 && features.momentum > -0.05) ||
                           (direction === "down" && features.trend < -0.12 && features.momentum < 0.05);
            const acceptableVolatility = features.volatility < 0.11;
            
            if (veryStrongTrend && aligned && acceptableVolatility) {
                if (direction === "up") return "BUY_UP";
                if (direction === "down") return "BUY_DOWN";
            }
        }
        
        // Default: HOLD - don't trade on weak signals
        return "HOLD";
    }
    
    /**
     * Update EMA
     */
    private updateEMA(price: number): void {
        if (this.emaShort === 0.5 && this.emaLong === 0.5) {
            // Initialize
            this.emaShort = price;
            this.emaLong = price;
        } else {
            this.emaShort = this.alphaShort * price + (1 - this.alphaShort) * this.emaShort;
            this.emaLong = this.alphaLong * price + (1 - this.alphaLong) * this.emaLong;
        }
    }
    
    /**
     * Update price statistics
     */
    private updateStatistics(): void {
        if (this.priceHistory.length === 0) return;
        
        const prices = this.priceHistory;
        this.priceMean = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - this.priceMean, 2), 0) / prices.length;
        this.priceStd = Math.sqrt(variance);
        
        // Prevent division by zero
        if (this.priceStd < 0.001) {
            this.priceStd = 0.1;
        }
    }
    
    /**
     * Normalize price to [0, 1] range
     */
    private normalizePrice(price: number): number {
        // Use z-score normalization with clipping
        const normalized = (price - this.priceMean) / this.priceStd;
        // Clip to reasonable range and scale to [0, 1]
        return Math.max(0, Math.min(1, (normalized + 3) / 6));
    }
    
    /**
     * Denormalize price from [0, 1] range
     */
    private denormalizePrice(normalized: number): number {
        // Reverse z-score normalization
        const zScore = (normalized * 6) - 3;
        return zScore * this.priceStd + this.priceMean;
    }
    
    /**
     * Normalize momentum
     */
    private normalizeMomentum(momentum: number): number {
        // Clip momentum to reasonable range [-1, 1]
        return Math.max(-1, Math.min(1, momentum));
    }
    
    /**
     * Normalize volatility
     */
    private normalizeVolatility(volatility: number): number {
        // Normalize volatility to [0, 1] range
        // Typical volatility for prediction markets is 0-0.2
        return Math.min(1, volatility * 5);
    }
    
    /**
     * Normalize trend
     */
    private normalizeTrend(trend: number): number {
        // Normalize trend to [-1, 1] range
        return Math.max(-1, Math.min(1, trend * 10));
    }
    
    /**
     * Get prediction accuracy statistics
     */
    public getAccuracyStats(): { accuracy: number; totalPredictions: number; correctPredictions: number } {
        return {
            accuracy: this.predictionCount > 0 ? this.correctPredictions / this.predictionCount : 0,
            totalPredictions: this.predictionCount,
            correctPredictions: this.correctPredictions,
        };
    }
    
    /**
     * Reset predictor (for new market cycle)
     */
    public reset(): void {
        this.priceHistory = [];
        this.timestamps = [];
        this.emaShort = 0.5;
        this.emaLong = 0.5;
        this.smoothedPrice = null;
        this.lastAddedPrice = null;
        this.stablePriceCount = 0;
        this.lastStablePrice = null;
        this.poleHistory = [];
        this.lastPolePrice = null;
        this.lastPoleType = null;
        this.lastPrediction = null;
        this.lastPredictionFeatures = null;
    }
}

