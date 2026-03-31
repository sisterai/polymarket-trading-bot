# PricePredictor — Updated Architecture & Logic Reference

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture: Component Map](#2-architecture-component-map)
3. [Data Flow: WebSocket to Trade Signal](#3-data-flow-websocket-to-trade-signal)
4. [MarketSnapshot — The Input Contract](#4-marketsnapshot--the-input-contract)
5. [Gate System — When Prediction is Skipped](#5-gate-system--when-prediction-is-skipped)
6. [PoleDetector — Trigger Timing](#6-poledetector--trigger-timing)
7. [RegimeDetector — Market State Classification](#7-regimedetector--market-state-classification)
8. [FeatureExtractor — What the Model Sees](#8-featureextractor--what-the-model-sees)
9. [Online Linear Model — Predict()](#9-online-linear-model--predict)
10. [EdgeCalculator — From Prediction to Trade Decision](#10-edgecalculator--from-prediction-to-trade-decision)
11. [Safety Layers — When the Bot Refuses to Trade](#11-safety-layers--when-the-bot-refuses-to-trade)
12. [Online Learning — learnFromPending()](#12-online-learning--learnfrompending)
13. [PredictionDiagnostics — Observability & Health](#13-predictiondiagnostics--observability--health)
14. [Orchestrator — updateAndPredictWithSnapshot() Step by Step](#14-orchestrator--updateandpredictwithsnapshot-step-by-step)
15. [Key Constants Reference](#15-key-constants-reference)
16. [Bug Fixes & Safety Improvements (Changelog)](#16-bug-fixes--safety-improvements-changelog)

---

## 1. System Overview

The `AdaptivePricePredictor` is the decision engine of the Polymarket BTC 5-minute UP/DOWN trading bot. It does **not** predict BTC's spot price. It predicts the next movement of the **Polymarket UP token's ask price** and converts that into a probabilistic trade decision.

**What it does in one sentence:**

> Receives live WebSocket price updates, classifies market regime, detects trigger conditions (poles, momentum surges, expiry), runs an online linear regression model on 12 features, converts the predicted price into a probability and expected edge after regime-conditioned costs, and emits `BUY_UP`, `BUY_DOWN`, or `HOLD`.

**What makes it "safe":**

The system has **7 independent safety gates** that all must pass before any trade is executed. If any single gate fails, the output is `HOLD` (no trade). The bot also auto-disables if live diagnostics detect model degradation, drawdown limits, losing streaks, or abnormal market conditions.

---

## 2. Architecture: Component Map

```
┌───────────────────────────────────────────────────────────────────┐
│                    AdaptivePricePredictor                          │
│                       (Orchestrator)                               │
│                                                                    │
│  Owns: priceHistory[], weights, pending prediction, noise filter   │
│  Delegates to:                                                     │
│                                                                    │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  PoleDetector   │  │  RegimeDetector   │  │ FeatureExtractor │   │
│  │                │  │                  │  │                  │   │
│  │ Detects local  │  │ Classifies into: │  │ 6 legacy +       │   │
│  │ peaks/troughs  │  │  momentum        │  │ 6 microstructure │   │
│  │ in smoothed    │  │  reversal        │  │ features         │   │
│  │ price series   │  │  chop            │  │                  │   │
│  │                │  │  expiry          │  │ Owns EMA state,  │   │
│  │                │  │                  │  │ normalization,   │   │
│  │                │  │ Uses raw values  │  │ quote intensity  │   │
│  └────────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                    │
│  ┌──────────────────┐  ┌─────────────────────────────────────┐    │
│  │  EdgeCalculator   │  │       PredictionDiagnostics          │    │
│  │                  │  │                                     │    │
│  │ sigmoid(delta)   │  │ Records every prediction, resolves  │    │
│  │ → pUp/pDown      │  │ against outcome, tracks hit rate,   │    │
│  │ → edge per side  │  │ calibration, PnL, drawdown, losing  │    │
│  │ → regime-gated   │  │ streak, regime distribution, health  │    │
│  │   safety checks  │  │                                     │    │
│  │ → signal         │  │                                     │    │
│  └──────────────────┘  └─────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

**File locations:**
- `src/utils/pricePredictor.ts` — PoleDetector, RegimeDetector, FeatureExtractor, EdgeCalculator, AdaptivePricePredictor
- `src/utils/diagnostics.ts` — PredictionDiagnostics, record types, health system

---

## 3. Data Flow: WebSocket to Trade Signal

```
WebSocket best_bid_ask event
        │
        ▼
┌─ updown-bot.ts: handlePriceUpdate() ─┐
│  Constructs MarketSnapshot {          │
│    bestAsk, bestBid, spread, mid,     │
│    bidSize, askSize, downAsk,         │
│    timestamp, roundStartTime          │
│  }                                    │
└───────────┬───────────────────────────┘
            │
            ▼
┌─ predictor.updateAndPredictWithSnapshot(snapshot) ──────────────┐
│                                                                  │
│  1. Price range gate               → null if invalid             │
│  2. First-price gate               → null if first               │
│  3. Adaptive noise filter gate     → null if Δ < threshold       │
│  4. Smooth price (EMA α=0.5)                                     │
│  5. Track quote arrival + spread (for quoteIntensity / filter)   │
│  6. Buffer update (keep last 10)                                 │
│  7. Minimum history gate           → null if < 3                 │
│  8. Regime detection (momentum / reversal / chop / expiry)       │
│  9. Prediction trigger gate        → null if no trigger          │
│     • pole detected → always trigger                             │
│     • momentum regime + 2 updates → trigger                      │
│     • expiry regime + 1 update → trigger                         │
│  ──────────────────────────────────────────────────────────────  │
│ 10. Learn from previous pending prediction                       │
│ 11. Extract 12 features                                          │
│ 12. Run linear model → predictedPrice                            │
│ 13. Update EMA                                                   │
│ 14. EdgeCalculator.compute(regime) → signal                      │
│ 15. Store current as pending                                     │
│ 16. Record in diagnostics                                        │
│                                                                  │
│  Returns PricePrediction { signal, direction, regime,            │
│    pUp, pDown, edgeBuyUp, edgeBuyDown, isPoleValue, ... }        │
└───────────────────────┬──────────────────────────────────────────┘
                        │
                        ▼
┌─ updown-bot.ts: executePredictionTrade() ──────────┐
│  1. Check signal !== HOLD                           │
│  2. Check diagnostics health (tradingAllowed)       │
│  3. Check per-side limits                           │
│  4. Buy first side (market order)                   │
│  5. Place second-side limit order (hedge)           │
└─────────────────────────────────────────────────────┘
```

---

## 4. MarketSnapshot — The Input Contract

```typescript
// src/utils/pricePredictor.ts

interface MarketSnapshot {
    bestAsk: number;                // UP token ask price (REQUIRED)
    bestBid: number | null;         // UP token bid price
    spread: number | null;          // ask - bid
    mid: number | null;             // (bid + ask) / 2
    bidSize: number | null;         // top-of-book bid quantity
    askSize: number | null;         // top-of-book ask quantity
    downAsk: number | null;         // DOWN token ask price
    timestamp: number;              // ms epoch (REQUIRED)
    roundStartTime: number | null;  // ms epoch of 5-min round start
}
```

**Design principle:** Only `bestAsk` and `timestamp` are required. All other fields gracefully degrade to neutral values when null, so the model still works with minimal data — it just produces less-informed predictions.

**Where it's built** (in `updown-bot.ts`):

```typescript
const snapshot: MarketSnapshot = {
    bestAsk: upAsk,
    bestBid: upPrice.bestBid,
    spread: upPrice.spread,
    mid: upPrice.mid,
    bidSize: null,       // TODO: populate when book events are parsed
    askSize: null,       // TODO: populate when book events are parsed
    downAsk: downAsk,
    timestamp: Date.now(),
    roundStartTime: current5mSlotStartMs(),
};
```

---

## 5. Gate System — When Prediction is Skipped

The predictor has **5 sequential gates** plus a **regime-conditioned trigger** before any prediction is attempted. Each returns `null` (skip this update) if the gate fails:

| # | Gate | Condition to PASS | Purpose |
|---|------|-------------------|---------|
| 1 | Price range | `0.003 ≤ price ≤ 0.97` | Reject degenerate prices near 0 or 1 |
| 2 | First price | `smoothedPrice !== null` | Initialize on first call, no prediction possible |
| 3 | Adaptive noise filter | `|rawPrice - lastRawPrice| ≥ adaptiveThreshold` | Ignore tiny price jitters scaled to market conditions |
| 4 | Minimum history | `priceHistory.length ≥ 3` | Need at least 3 points for meaningful features |
| 5 | Prediction trigger | Pole detected, OR momentum+2 updates, OR expiry+1 update | Only predict when there's a meaningful trading opportunity |

### Adaptive Noise Filter (Gate 3)

Previously used a fixed `NOISE_THRESHOLD = 0.02`. Now the threshold adapts to market conditions:

```
adaptiveThreshold = max(
    NOISE_ABSOLUTE_MIN,          // 0.005 — hard floor
    TICK_FLOOR,                  // 0.01  — minimum tick size
    NOISE_SPREAD_FACTOR × spread,  // 0.5 × current spread
    NOISE_VOL_FACTOR × volatility  // 0.3 × recent std dev
)
```

| Market condition | Spread | Threshold | Effect |
|-----------------|--------|-----------|--------|
| Tight market | 0.02 | ~0.01 | Accept small moves (1 cent) |
| Normal market | 0.04 | ~0.02 | Filter small noise (2 cents) |
| Wide market | 0.10 | ~0.05 | Only large moves pass (5 cents) |

The filter compares **raw-to-raw prices** (not raw-to-smoothed), ensuring a consistent threshold:

```typescript
if (this.lastRawPrice !== null &&
    Math.abs(price - this.lastRawPrice) < adaptiveThreshold) {
    return null;
}
this.lastRawPrice = price;
```

### Prediction Trigger (Gate 5)

The prediction trigger is **regime-conditioned** — different market states allow different trigger conditions:

| Regime | Trigger condition | Rationale |
|--------|-------------------|-----------|
| **reversal** | Pole only | Classic behavior — wait for price reversals |
| **momentum** | Pole, OR 2+ updates since last prediction | Capture continuation trades during strong moves |
| **expiry** | Pole, OR 1+ update since last prediction | Trade more frequently as round nears end |
| **chop** | Pole only (but EdgeCalculator forces HOLD) | Detect pole structure, but never trade |

---

## 6. PoleDetector — Trigger Timing

The predictor's primary trigger mechanism. It detects local peaks and troughs in the smoothed price series.

**Why poles?** Poles represent moments where the price has just reversed direction. Predicting at these inflection points captures the moment of maximum information about the next directional move.

**Detection logic:**

```typescript
detect(priceHistory, timestamp, noiseThreshold) {
    // Need at least 3 prices
    const price = priceHistory[last];

    // Check if current price is higher than all lookback prices (peak)
    // or lower than all lookback prices (trough)
    let isPeak = true, isTrough = true;
    for (i in lookback window) {
        if (priceHistory[i] >= price) isPeak = false;
        if (priceHistory[i] <= price) isTrough = false;
    }

    // Must be a different type from last pole, or significant price change
    if (changeFromLast >= noiseThreshold || isDifferentType) {
        return true; // New pole detected → trigger prediction
    }
}
```

**Pole sequence example:**

```
Price: 0.52  0.55  0.58  0.54  0.51  0.53  0.56
              ↑           ↑                  ↑
           (trough?)    (trough)           (peak)
                         PREDICT            PREDICT
```

---

## 7. RegimeDetector — Market State Classification

The `RegimeDetector` classifies the current market into one of four regimes **before** the pole gate. The detected regime influences two things:

1. **Prediction trigger** — momentum and expiry regimes allow non-pole predictions
2. **EdgeCalculator thresholds** — each regime has its own MIN_EDGE and VOL_CIRCUIT_BREAKER

### Regimes

| Regime | Meaning | Prediction trigger | Trading behavior |
|--------|---------|-------------------|-----------------|
| **momentum** | Strong directional move | Pole + momentum bypass (2 updates) | Trade continuations with slightly lower edge threshold |
| **reversal** | Local peak/trough | Pole only | Classic pole-based entry, standard thresholds |
| **chop** | Flat, no clear direction | Pole only (but forced HOLD) | Never trade — no signal worth pursuing |
| **expiry** | Final portion of 5-min round | Pole + expiry bypass (1 update) | Higher edge requirement — book may be distorted |

### Detection Logic

The detector receives **raw** values (not feature-space scaled):

```typescript
detect(momentum, volatility, trend, timeRemaining): MarketRegime {
    // 1. Expiry takes priority — book changes fundamentally
    if (timeRemaining > 0.85) return "expiry";

    // 2. Momentum — strong directional move
    if (|trend| > 0.01 && volatility > 0.005 && |momentum| > 0.02)
        return "momentum";

    // 3. Chop — flat, low-energy market
    if (volatility < 0.005 && |trend| < 0.003 && |momentum| < 0.01)
        return "chop";

    // 4. Default — reversal
    return "reversal";
}
```

### Threshold Calibration

Thresholds are calibrated to the **raw** input ranges for a token priced 0.40-0.60:

| Input | Source | Typical range | Used for |
|-------|--------|---------------|----------|
| `momentum` | `(current - lag1) / lag1` | [-0.10, +0.10] | Momentum: > 0.02, Chop: < 0.01 |
| `volatility` | Std dev of last 5 smoothed prices | [0.003, 0.03] | Momentum: > 0.005, Chop: < 0.005 |
| `trend` | `emaShort - emaLong` | [-0.03, +0.03] | Momentum: > 0.01, Chop: < 0.003 |
| `timeRemaining` | `elapsed / 300000` | [0, 1] | Expiry: > 0.85 |

**Critical note:** These are RAW values (not feature-space). The feature-space `trend` is `rawTrend * 10` clamped to [-1, 1], and feature-space `volatility` is `rawVol * 5` clamped to [0, 1]. The RegimeDetector operates on the raw values *before* scaling.

---

## 8. FeatureExtractor — What the Model Sees

The model uses **12 features** organized into two groups:

### Legacy Features (price-derived, 6 features)

| Feature | Range | Formula | Purpose |
|---------|-------|---------|---------|
| `priceLag1` | [0,1] | z-score normalized price at t-1 | Recent price level |
| `priceLag2` | [0,1] | z-score normalized price at t-2 | Slightly older price level |
| `priceLag3` | [0,1] | z-score normalized price at t-3 | Even older price level |
| `momentum` | [-1,1] | Blend of short-term and long-term % change | Direction and speed of price movement |
| `volatility` | [0,1] | StdDev of last 5 prices × 5 | Market turbulence (higher = more chaotic) |
| `trend` | [-1,1] | Weighted blend: 40% EMA trend + 40% momentum trend + 20% price trend | Persistent directional tendency |

### Microstructure Features (orderbook-derived, 6 features)

| Feature | Range | Neutral | Formula | Purpose |
|---------|-------|---------|---------|---------|
| `spread` | [0,1] | 0 | `(ask - bid) / 0.5` clamped | Liquidity indicator — wider = worse |
| `microprice` | [0,1] | 0.5 | `(bid×askSize + ask×bidSize) / (bidSize+askSize)` normalized | Size-weighted fair value, better than mid |
| `bookImbalance` | [-1,1] | 0 | `(bidSize - askSize) / (bidSize + askSize)` | Buy/sell pressure — positive = buyers |
| `downAskDelta` | [-1,1] | 0 | `(upAsk - (1 - downAsk)) / 0.1` | Cross-leg mispricing / arb pressure |
| `timeRemaining` | [0,1] | 0.5 | `elapsed / 300000` (5 min in ms) | Expiry proximity — near 1 = expiry |
| `quoteIntensity` | [0,1] | 0 | EMA-smoothed quote arrival rate / 10 | Market activity level |

### Quote Intensity Tracking

`trackQuoteArrival()` is called on **every accepted price update** (before the pole gate) so the EMA tracks actual WebSocket quote frequency, not pole frequency:

```typescript
// Called on EVERY accepted update (before pole gate)
this.extractor.trackQuoteArrival(snapshot);

// Later, inside extractWithSnapshot (only at prediction trigger):
quoteIntensity: this.computeQuoteIntensity(), // reads pre-computed EMA
```

### Spread Tracking

`trackSpread()` is called on every accepted update to feed the adaptive noise filter:

```typescript
this.extractor.trackSpread(snapshot);  // stores latest spread for noise filter
```

### Normalization

Price features are z-score normalized using rolling statistics from the price history buffer:

```typescript
normalizePrice(price) {
    const z = (price - priceMean) / priceStd;
    return clamp((z + 3) / 6, 0, 1);  // maps [-3σ, +3σ] → [0, 1]
}
```

This keeps the model numerically stable regardless of the absolute price level of the UP token.

---

## 9. Online Linear Model — Predict()

The core model is a **weighted linear combination** of all 12 features:

```typescript
predict(features: FeatureVector) {
    const rawScore =
        w.intercept +
        // Legacy (6 features)
        w.priceLag1 * features.priceLag1 +
        w.priceLag2 * features.priceLag2 +
        w.priceLag3 * features.priceLag3 +
        w.momentum  * features.momentum +
        w.volatility * features.volatility +
        w.trend     * features.trend +
        // Microstructure (6 features)
        w.spread        * features.spread +
        w.microprice    * features.microprice +
        w.bookImbalance * features.bookImbalance +
        w.downAskDelta  * features.downAskDelta +
        w.timeRemaining * features.timeRemaining +
        w.quoteIntensity * features.quoteIntensity;

    return {
        predictedPrice: denormalizePrice(rawScore),
        rawScore
    };
}
```

**Initial weights:**
- Legacy features have non-zero initial weights (e.g., `momentum: 0.35`, `trend: 0.45`) based on prior domain knowledge.
- Microstructure features start at **zero** — no behavior change at deployment. The online learner discovers their signal over time.

**Output:** `predictedPrice` is the model's estimate of where the UP token smoothed price will be at the next trigger point.

---

## 10. EdgeCalculator — From Prediction to Trade Decision

This is the most critical component for safety. It converts the raw model prediction into a **probabilistic, cost-aware, regime-conditioned trade decision**.

### Step-by-step pipeline

```
predictedPrice → delta → sigmoid → pUp/pDown → edge per side
    → regime thresholds → safety gates → signal
```

### Step 1: Predicted move to probability

```typescript
const delta = predictedPrice - currentPrice;
const pUp = 1 / (1 + Math.exp(-SIGMOID_SENSITIVITY * delta));
const pDown = 1 - pUp;
```

The sigmoid transforms the raw price delta into a probability-like value:
- `delta = +0.05` → `pUp ≈ 0.68` (68% chance UP token is undervalued)
- `delta = +0.10` → `pUp ≈ 0.82`
- `delta = 0` → `pUp = 0.50` (no edge)
- `delta = -0.05` → `pUp ≈ 0.32` → `pDown ≈ 0.68`

`SIGMOID_SENSITIVITY = 15` controls how quickly small price moves translate to extreme probabilities.

### Step 2: Execution cost estimate

```typescript
const halfSpread = snapshot?.spread !== null
    ? snapshot.spread / 2
    : DEFAULT_HALF_SPREAD;              // 0.008
const costPerShare = halfSpread + FIXED_COST;  // FIXED_COST = 0.008
```

Total cost per trade includes:
- **Half-spread** (crossing the bid-ask to buy)
- **Fixed cost** (Polymarket taker fee + slippage estimate = 0.8 cents)

### Step 3: Edge per side

```typescript
const edgeBuyUp   = pUp   - upAsk   - costPerShare;
const edgeBuyDown = pDown - downAsk - costPerShare;
```

**This is the binary market edge formula:**

For a token that pays $1 if event occurs and $0 otherwise:
- Expected value = P(event) × $1 = P(event)
- Cost to buy = ask price + execution cost
- **Edge = P(event) - askPrice - cost**

A positive edge means the market is offering the token cheaper than its estimated fair value.

### Step 4: Direction and confidence

```typescript
const direction = edgeBuyUp >= edgeBuyDown ? "up" : "down";
const bestEdge = Math.max(edgeBuyUp, edgeBuyDown);
const confidence = direction === "up" ? pUp : pDown;
```

Direction is determined by which side has the **better edge** (not just which direction the model predicts — it considers current prices too).

### Step 5: Accuracy discount

```typescript
const accuracyFactor = recentAccuracy >= 0.5 ? 1.0 : 0.5 + recentAccuracy;
const adjustedEdge = bestEdge * accuracyFactor;
```

If the model's recent accuracy drops below 50%, the effective edge is scaled down. At 30% accuracy, the edge is multiplied by 0.8. This makes it progressively harder to reach the trade threshold when the model is underperforming.

### Step 6: Regime-conditioned signal gating

The EdgeCalculator applies **regime-specific** thresholds:

```typescript
// Chop regime → NEVER trade
if (regime === "chop") → HOLD

// Warm-up gate
if (resolvedCount < 5) → HOLD

// Spread liquidity gate
if (spread > 0.06) → HOLD

// Regime-specific volatility circuit breaker
if (volatility > volBreaker[regime]) → HOLD

// Regime-specific edge threshold
if (adjustedEdge >= minEdge[regime]) → BUY_UP or BUY_DOWN
else → HOLD
```

**Regime-specific thresholds:**

| Regime | MIN_EDGE | VOL_BREAKER | Rationale |
|--------|----------|-------------|-----------|
| **momentum** | 0.025 (2.5%) | 0.12 | Lower bar — model has directional conviction, higher vol is expected |
| **reversal** | 0.03 (3%) | 0.08 | Standard — classic pole trade needs clear edge |
| **chop** | N/A | N/A | **Forced HOLD** — no signal worth pursuing |
| **expiry** | 0.04 (4%) | 0.06 | Higher bar — book distortion near expiry, need strong conviction |

---

## 11. Safety Layers — When the Bot Refuses to Trade

The system has **multiple independent safety mechanisms**. A trade is only placed when ALL of them agree:

### Layer 1: Chop Regime Block (EdgeCalculator)
- **Condition:** `regime === "chop"`
- **Behavior:** Force HOLD unconditionally
- **Why:** Flat markets produce random noise, not tradable signals

### Layer 2: Warm-up Gate (EdgeCalculator)
- **Threshold:** `resolvedCount < 5`
- **Behavior:** Force HOLD until at least 5 predictions have been made AND evaluated against real outcomes
- **Why:** Prevents trading before the model has any validated track record

### Layer 3: Spread Liquidity Gate (EdgeCalculator)
- **Threshold:** `spread > 0.06`
- **Behavior:** Force HOLD when bid-ask spread is too wide
- **Why:** Wide spreads mean high execution cost and poor fill quality

### Layer 4: Volatility Circuit Breaker (EdgeCalculator, regime-conditioned)
- **Thresholds:** Momentum 0.12, Reversal 0.08, Expiry 0.06
- **Behavior:** Force HOLD during high volatility (relative to regime expectation)
- **Why:** Chaotic price action makes predictions unreliable. Momentum tolerates more volatility (it IS the regime). Expiry is strictest (chaotic near expiry is dangerous).

### Layer 5: Edge Threshold (EdgeCalculator, regime-conditioned)
- **Thresholds:** Momentum 0.025, Reversal 0.03, Expiry 0.04
- **Behavior:** Force HOLD when edge after cost is insufficient
- **Why:** Only trade when expected profit clearly exceeds transaction costs

### Layer 6: Diagnostics Health Check (updown-bot.ts)
Before executing any trade, the bot queries `diagnostics.getHealthStatus()`:

| Check | Threshold | Action |
|-------|-----------|--------|
| Accuracy collapse | < 35% over last 20 predictions | **Disable trading entirely** |
| Max drawdown | Rolling PnL below -15% | **Disable trading entirely** |
| Losing streak | 5+ consecutive losing trades (current) | **Disable trading entirely** |
| Overconfidence | Avg confidence > 72% but hit rate < 50% | Warning logged |
| Spread anomaly | Avg spread > 0.08 over last 10 records | Warning logged |

```typescript
// In updown-bot.ts executePredictionTrade():
const health = predictor.getDiagnostics().getHealthStatus();
if (!health.tradingAllowed) {
    logger.warning(`SAFETY: trading disabled - ${health.warnings.join(", ")}`);
    return; // DO NOT TRADE
}
```

### Layer 7: Per-Side Position Limits (updown-bot.ts)
- Max `N` buys per side (UP / DOWN) per market cycle
- Once limit is reached, market is paused

**Net effect:** The bot will produce far more HOLD signals than trade signals. This is intentional — it only trades when the model is confident, the regime is favorable, the market is liquid, the edge is clear, and the track record supports it.

---

## 12. Online Learning — learnFromPending()

### The Timing Problem (previously a bug)

The model learns online — it updates its weights based on how well previous predictions matched reality. The critical requirement is **no label leakage**: the model must never train using information from the future.

### Learning Lifecycle

```
Trigger T:
  1. Extract features_T from current price history
  2. Predict: predictedPrice_T = model(features_T)
  3. Store as pending: { features_T, predictedPrice_T, basePrice_T }

Trigger T+1:
  1. outcomePrice = current smoothed price
  2. LEARN: evaluate pending prediction against outcomePrice
     - error = outcomePrice - predictedPrice_T
     - direction correct? predicted vs actual movement from basePrice_T
     - update weights using features_T (frozen) and error
  3. Clear pending
  4. Extract features_T+1
  5. Predict: predictedPrice_T+1 = model(features_T+1)  ← uses updated weights
  6. Store as pending
```

**Note:** "Trigger" means any prediction trigger — pole, momentum bypass, or expiry bypass. The learning lifecycle works identically regardless of trigger type.

**Key guarantees:**
- Features used for learning were computed **before** the outcome was known
- The predicted price being evaluated was computed **before** the outcome
- No current-bar information leaks into the training of its own prediction

### Weight Update (SGD with asymmetric learning)

```typescript
// Direction evaluation
const predDir = predictedPrice > basePrice ? 1 : -1;
const actDir  = outcomePrice > basePrice ? 1 : -1;
const wrong   = predDir !== actDir;

// Asymmetric: learn 3× faster from mistakes
const mult = wrong ? 8.0 : 2.5;
const lr = clamp(BASE_LR * (1 + normError * mult), MIN_LR, MAX_LR);
// lr range: [0.005, 0.2]

// Weight decay: shrink existing weights (stronger decay on wrong predictions)
const decay = wrong ? 0.85 : 0.97;

// Gradient step
const grad = lr * error;
weight_i = weight_i * decay + grad * feature_i;
```

**Intuition:**
- When the model predicts correctly, weights are gently reinforced (decay 0.97, low lr multiplier)
- When the model predicts incorrectly, weights are aggressively corrected (decay 0.85 = 15% shrinkage, 3× higher lr multiplier)
- This makes the model quickly adapt to regime changes while maintaining stability during good performance

---

## 13. PredictionDiagnostics — Observability & Health

`PredictionDiagnostics` (in `diagnostics.ts`) is a standalone observer that runs alongside the predictor without affecting its behavior.

### What it records

Every prediction generates a `PredictionRecord`:

```typescript
{
    id, timestamp,
    upAsk, downAsk, spread,           // Market state
    predictedPrice, rawScore,          // Model output
    pUp, pDown, edgeBuyUp, edgeBuyDown, // Edge analysis
    direction, signal, confidence,      // Decision
    momentum, volatility, trend,        // Key features
    basePrice,                          // Reference price
    regime                              // Detected market regime
}
```

When the outcome arrives (at next trigger), it becomes a `ResolvedRecord` with:

```typescript
{
    ...PredictionRecord,
    outcomePrice,       // What the price actually was
    actualDirection,    // Which way price actually moved
    wasCorrect,         // Did the prediction match reality?
    realizedPnl         // Estimated mark-to-market P&L
}
```

### Rolling performance stats

```
--- DIAGNOSTICS (150 total, 150 in window) ---
Hit rate: 58.0% | Trade hit rate: 62.5%
Traded: 24 | Hold: 126 | No-trade rate: 84%
BUY_UP: 14 (64%) | BUY_DOWN: 10 (60%)
Regimes: momentum=32 reversal=85 chop=18 expiry=15
Avg edge before cost: 1.82% | after cost: 0.45%
Rolling PnL: 3.21% | Max drawdown: -2.14%
Calibration: [0.50-0.60] n=85 hit=52% | [0.60-0.70] n=67 hit=58% | ...
```

### Health assessment (single-pass scan)

The `getHealthStatus()` method scans the **full** resolved buffer (up to 200 records) in a single pass. It computes:

1. **Accuracy** from the last 20 records (health window)
2. **Spread anomaly** from the last 10 records (spread window)
3. **Drawdown** across the **entire** buffer (needs full history)
4. **Current losing streak** at the **tail** of the buffer (not historical max)

**Trading halt conditions** (`tradingAllowed = false`):

| Check | Threshold | Why |
|-------|-----------|-----|
| Accuracy collapse | < 35% over last 20 | Model has broken down |
| Max drawdown | Rolling PnL below -15% | Too much capital lost |
| Losing streak | 5+ consecutive losses **currently active** | Pattern of repeated failures |

**Warning-only conditions:**

| Check | Threshold | Why |
|-------|-----------|-----|
| Overconfidence | Avg confidence > 72% + hit rate < 50% | Model is miscalibrated |
| Spread anomaly | Avg spread > 0.08 over last 10 | Market becoming illiquid |

**Important:** The losing streak check uses the **current** streak (the one active at the end of the buffer), not the worst historical streak. If a 5-loss streak occurred 100 predictions ago but was followed by 50 wins, trading remains enabled.

---

## 14. Orchestrator — updateAndPredictWithSnapshot() Step by Step

Here is the exact sequence of operations:

```
updateAndPredictWithSnapshot(snapshot)
│
├─ Gate 1: price range check
│   └─ 0.003 ≤ bestAsk ≤ 0.97
│
├─ Gate 2: first-price initialization
│   └─ smoothedPrice === null → initialize, return null
│
├─ Gate 3: adaptive noise filter
│   └─ |rawPrice - lastRawPrice| < max(0.005, 0.01, 0.5×spread, 0.3×vol)
│      → return null
│
├─ Smooth: EMA(α=0.5) on accepted price
│
├─ Track: quoteArrival (for quoteIntensity EMA)
├─ Track: spread (for adaptive noise filter)
├─ Increment: updatesSinceLastPrediction
│
├─ Buffer: push smoothed price, cap at 10
│
├─ Gate 4: minimum history (need 3+)
│
├─ Regime detection (lightweight, before trigger gate)
│   └─ Uses raw momentum, volatility, EMA trend, timeRemaining
│   └─ Returns: momentum | reversal | chop | expiry
│
├─ Gate 5: prediction trigger (regime-conditioned)
│   ├─ Pole detected? → trigger
│   ├─ Momentum regime + 2 updates since last prediction? → trigger
│   ├─ Expiry regime + 1 update since last prediction? → trigger
│   └─ None of the above? → return null
│
│  ═══ Past all gates → prediction triggered ═══
│
├─ Reset: updatesSinceLastPrediction = 0
│
├─ Step 1: learnFromPending(currentPrice)
│   └─ If pending exists: evaluate, update weights, record diagnostics
│
├─ Step 2: updateStatistics + extractWithSnapshot
│   └─ Compute all 12 features from history + snapshot
│
├─ Step 3: predict(features)
│   └─ Linear model → rawScore → denormalize → predictedPrice
│
├─ Step 4: updateEMA(currentPrice)
│   └─ Update short/long EMA for next call's trend feature
│
├─ Step 5: edge.compute({ ..., regime })
│   └─ sigmoid → pUp/pDown → edge → regime-conditioned gates → signal
│
├─ Step 6: store as pending
│   └─ Freeze { features, predictedPrice, basePrice, confidence }
│
├─ Step 7: diagnostics.record(result, snapshot, currentPrice)
│
├─ Timing guard: warn if > 20ms
│
└─ Return PricePrediction {
       predictedPrice, confidence, direction, signal,
       isPoleValue, regime,
       pUp, pDown, edgeBuyUp, edgeBuyDown, rawScore,
       features: { momentum, volatility, trend }
   }
```

---

## 15. Key Constants Reference

### RegimeDetector — Market State Classification

| Constant | Value | Input type | Purpose |
|----------|-------|------------|---------|
| `EXPIRY_THRESHOLD` | 0.85 | timeRemaining [0,1] | Last 45s of 5-min round → expiry |
| `MOMENTUM_TREND_THRESHOLD` | 0.01 | raw EMA diff | Min |EMA trend| for momentum |
| `MOMENTUM_MOM_THRESHOLD` | 0.02 | raw % change | Min |momentum| for momentum |
| `MOMENTUM_VOL_FLOOR` | 0.005 | raw std dev | Min volatility for momentum |
| `CHOP_VOL_CEILING` | 0.005 | raw std dev | Max volatility for chop |
| `CHOP_TREND_CEILING` | 0.003 | raw EMA diff | Max |EMA trend| for chop |
| `CHOP_MOM_CEILING` | 0.01 | raw % change | Max |momentum| for chop |

### EdgeCalculator — Trade Decision

| Constant | Value | Purpose |
|----------|-------|---------|
| `SIGMOID_SENSITIVITY` | 15 | How aggressively price delta maps to probability |
| `FIXED_COST` | 0.008 | Slippage + Polymarket taker fee estimate per share |
| `DEFAULT_HALF_SPREAD` | 0.008 | Assumed half-spread when actual spread is unavailable |
| `MAX_SPREAD_TO_TRADE` | 0.06 | Max spread before forcing HOLD (6 cents) |
| `WARMUP_MIN_RESOLVED` | 5 | Min validated predictions before trading allowed |
| `MIN_EDGE_MOMENTUM` | 0.025 | Min net edge after cost for momentum regime |
| `MIN_EDGE_REVERSAL` | 0.03 | Min net edge after cost for reversal regime |
| `MIN_EDGE_EXPIRY` | 0.04 | Min net edge after cost for expiry regime |
| `VOL_BREAKER_MOMENTUM` | 0.12 | Volatility circuit breaker for momentum |
| `VOL_BREAKER_REVERSAL` | 0.08 | Volatility circuit breaker for reversal |
| `VOL_BREAKER_EXPIRY` | 0.06 | Volatility circuit breaker for expiry |

### AdaptivePricePredictor — Model & Filtering

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_HISTORY` | 10 | Price buffer size (rolling window) |
| `TICK_FLOOR` | 0.01 | Minimum tick size for noise filter |
| `NOISE_SPREAD_FACTOR` | 0.5 | Noise threshold = 0.5 × recent spread |
| `NOISE_VOL_FACTOR` | 0.3 | Noise threshold = 0.3 × recent volatility |
| `NOISE_ABSOLUTE_MIN` | 0.005 | Hard floor for noise threshold |
| `SMOOTHING_ALPHA` | 0.5 | EMA smoothing factor (higher = more reactive) |
| `MIN_PRICE` / `MAX_PRICE` | 0.003 / 0.97 | Valid price range |
| `LEARNING_RATE` | 0.05 | Base SGD learning rate |
| `MIN_LR` / `MAX_LR` | 0.005 / 0.2 | Learning rate bounds |
| `RECENT_WINDOW` | 20 | Rolling accuracy window size |

### PredictionDiagnostics — Health

| Constant | Value | Purpose |
|----------|-------|---------|
| `BUFFER_CAPACITY` | 200 | Max resolved records kept in memory |
| `HEALTH_WINDOW` | 20 | Lookback for accuracy assessment |
| `ACCURACY_COLLAPSE_THRESHOLD` | 0.35 | Below this → **disable trading** |
| `MAX_DRAWDOWN_THRESHOLD` | -0.15 | Below this → **disable trading** |
| `LOSING_STREAK_LIMIT` | 5 | Consecutive losses → **disable trading** |
| `OVERCONFIDENCE_CONF_THRESHOLD` | 0.72 | Confidence above this + low hit rate → warning |
| `OVERCONFIDENCE_HIT_THRESHOLD` | 0.50 | Hit rate below this + high confidence → warning |
| `SPREAD_ANOMALY_THRESHOLD` | 0.08 | Avg spread above this → warning |
| `SPREAD_ANOMALY_WINDOW` | 10 | Lookback for spread anomaly check |

---

## 16. Bug Fixes & Safety Improvements (Changelog)

### Round 1: Structural Refactoring & Core Bug Fixes

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | **Label leakage** — model trained on features containing the outcome | Model appeared accurate but had no real predictive power | Introduced `PendingPrediction` buffer with learn-then-predict lifecycle |
| 2 | **Dead stability code** — `stablePriceCount`, `updateStability()` computed but never read | Wasted CPU, confusing dead code | Removed entirely |
| 3 | **Noise filter compared raw to smoothed** — inconsistent threshold reference | Threshold behavior was unpredictable | Added `lastRawPrice` field, compare raw-to-raw |
| 4 | **quoteIntensity measured pole frequency** — only called at pole detections | Feature measured wrong thing entirely | Added `trackQuoteArrival()` on every accepted update |
| 5 | **Cold-start accuracy** — returned phantom 0.6 with no data | False confidence before validation | Return 0.5 (coin-flip) |

### Round 2: Safety Improvements

| # | Change | Before → After | Effect |
|---|--------|---------------|--------|
| 1 | **Warm-up gate** | Trade immediately | HOLD until 5 predictions validated |
| 2 | **MIN_EDGE raised** | 0.02 (2%) | 0.03 (3%) — higher bar for trading |
| 3 | **VOL_CIRCUIT_BREAKER tightened** | 0.12 | 0.08 — hold earlier in chaotic markets |
| 4 | **Spread gate added** | None | HOLD if spread > 0.06 |
| 5 | **Cost estimates raised** | FIXED_COST 0.005, HALF_SPREAD 0.005 | 0.008, 0.008 — more conservative |
| 6 | **Max drawdown gate** | None | Disable trading if rolling PnL < -15% |
| 7 | **Second-side limit order** | Hardcoded `0.98 - firstSidePrice` | Uses actual opposite-side ask with discount, clamped |

### Round 3: Regime Detection & Adaptive Logic

| # | Change | Description |
|---|--------|-------------|
| 1 | **RegimeDetector added** | Classifies market into momentum / reversal / chop / expiry |
| 2 | **Adaptive noise filter** | Fixed 0.02 threshold → `max(0.005, 0.01, 0.5×spread, 0.3×vol)` |
| 3 | **Regime-conditioned triggers** | Non-pole predictions allowed in momentum (2 updates) and expiry (1 update) |
| 4 | **Regime-conditioned EdgeCalculator** | MIN_EDGE and VOL_BREAKER vary by regime (see table in Section 10) |
| 5 | **Chop regime block** | Forced HOLD in chop — no signal worth pursuing |
| 6 | **Losing streak promoted** | Warning → **trading halt** at 5+ consecutive losses |
| 7 | **Regime logged** | PricePrediction and diagnostics include `regime` field |

### Round 4: Threshold Calibration & Correctness Fixes

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | **RegimeDetector thresholds unreachable** — `MOMENTUM_TREND_THRESHOLD = 0.3` but raw EMA diff is 0.001-0.03 | Momentum regime **never** triggered; all regime logic was dead code | Recalibrated all thresholds to raw value ranges (trend: 0.01, vol floor: 0.005, chop ceiling: 0.005) |
| 2 | **Drawdown scanned only buffer tail** — started from `scanStart` (last 20 records) not index 0 | Drawdown underestimated — could miss historical drawdown | Scan starts from 0; full buffer used |
| 3 | **Losing streak permanently sticky** — used `maxLosingStreak` (worst-ever in buffer) | A 5-loss streak 100 predictions ago disabled trading forever | Changed to `currentLosingStreak` (active streak at buffer tail); wins reset counter |
| 4 | **Stale comments** — "pole-only" language in updown-bot.ts | Misleading documentation alongside regime-aware code | Updated all comments to reflect regime-conditioned triggers |
| 5 | **Hardcoded accuracy threshold** — updown-bot.ts used `0.02` for direction evaluation | Inconsistent with adaptive noise filter | Simplified to pure sign check (`priceDiff >= 0 ? "up" : "down"`) |

### Net Safety Posture

The bot now operates with a "trade reluctantly" philosophy:
- Most predictions result in HOLD (high no-trade rate is expected and desired)
- Four different market regimes receive tailored treatment — chop is never traded, expiry requires extra conviction
- Trades only happen when edge is convincing (2.5-4% after cost depending on regime), volatility is calm, spread is tight, and the model has a validated track record
- Auto-shutdown triggers exist for accuracy collapse, drawdown, and losing streaks (all three disable trading, not just warn)
- Every prediction is logged with full context including regime for post-session analysis
