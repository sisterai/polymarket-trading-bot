# PricePredictor — Updated Architecture & Logic Reference

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture: Component Map](#2-architecture-component-map)
3. [Data Flow: WebSocket to Trade Signal](#3-data-flow-websocket-to-trade-signal)
4. [MarketSnapshot — The Input Contract](#4-marketsnapshot--the-input-contract)
5. [Gate System — When Prediction is Skipped](#5-gate-system--when-prediction-is-skipped)
6. [PoleDetector — Trigger Timing](#6-poledetector--trigger-timing)
7. [FeatureExtractor — What the Model Sees](#7-featureextractor--what-the-model-sees)
8. [Online Linear Model — Predict()](#8-online-linear-model--predict)
9. [EdgeCalculator — From Prediction to Trade Decision](#9-edgecalculator--from-prediction-to-trade-decision)
10. [Safety Layers — When the Bot Refuses to Trade](#10-safety-layers--when-the-bot-refuses-to-trade)
11. [Online Learning — learnFromPending()](#11-online-learning--learnfrompending)
12. [PredictionDiagnostics — Observability & Health](#12-predictiondiagnostics--observability--health)
13. [Orchestrator — updateAndPredictWithSnapshot() Step by Step](#13-orchestrator--updateandpredictwithsnapshot-step-by-step)
14. [Key Constants Reference](#14-key-constants-reference)
15. [Recent Bug Fixes & Safety Improvements](#15-recent-bug-fixes--safety-improvements)

---

## 1. System Overview

The `AdaptivePricePredictor` is the decision engine of the Polymarket BTC 5-minute UP/DOWN trading bot. It does **not** predict BTC's spot price. It predicts the next movement of the **Polymarket UP token's ask price** and converts that into a probabilistic trade decision.

**What it does in one sentence:**

> Receives live WebSocket price updates, detects local price peaks/troughs (poles), runs an online linear regression model on 12 features, converts the predicted price into a probability and expected edge after cost, and emits `BUY_UP`, `BUY_DOWN`, or `HOLD`.

**What makes it "safe":**

The system has **6 independent safety gates** that all must pass before any trade is executed. If any single gate fails, the output is `HOLD` (no trade). The bot also auto-disables if live diagnostics detect model degradation, drawdown limits, or abnormal market conditions.

---

## 2. Architecture: Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│                   AdaptivePricePredictor                        │
│                      (Orchestrator)                             │
│                                                                 │
│  Owns: priceHistory[], weights, pending prediction              │
│  Delegates to:                                                  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ PoleDetector  │  │ FeatureExtractor  │  │ EdgeCalculator   │  │
│  │              │  │                  │  │                  │  │
│  │ Detects local│  │ 6 legacy +       │  │ sigmoid(delta)   │  │
│  │ peaks/troughs│  │ 6 microstructure │  │ → pUp/pDown      │  │
│  │ in smoothed  │  │ features         │  │ → edge per side  │  │
│  │ price series │  │                  │  │ → 6 safety gates │  │
│  │              │  │ Owns EMA state,  │  │ → signal         │  │
│  │              │  │ normalization    │  │                  │  │
│  └──────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              PredictionDiagnostics                        │   │
│  │  Records every prediction, resolves against outcome,     │   │
│  │  tracks hit rate, calibration, PnL, drawdown, health     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**File locations:**
- `src/utils/pricePredictor.ts` — PoleDetector, FeatureExtractor, EdgeCalculator, AdaptivePricePredictor
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
┌─ predictor.updateAndPredictWithSnapshot(snapshot) ─┐
│                                                     │
│  1. Price range gate             → null if invalid  │
│  2. First-price gate             → null if first    │
│  3. Noise filter gate            → null if < 0.02   │
│  4. Smooth price (EMA α=0.5)                        │
│  5. Track quote arrival (for quoteIntensity)        │
│  6. Buffer update (keep last 10)                    │
│  7. Minimum history gate         → null if < 3      │
│  8. Pole detection gate          → null if no pole  │
│  ─────────────────────────────────────────────────  │
│  9. Learn from previous pending prediction          │
│ 10. Extract 12 features                             │
│ 11. Run linear model → predictedPrice               │
│ 12. Update EMA                                      │
│ 13. EdgeCalculator.compute() → signal               │
│ 14. Store current as pending                        │
│ 15. Record in diagnostics                           │
│                                                     │
│  Returns PricePrediction { signal, direction,       │
│    pUp, pDown, edgeBuyUp, edgeBuyDown, ... }        │
└───────────────────────┬─────────────────────────────┘
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
// src/utils/pricePredictor.ts:38-55

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

The predictor has **5 sequential gates** before any prediction is attempted. Each returns `null` (skip this update) if the gate fails:

| # | Gate | Condition to PASS | Purpose |
|---|------|-------------------|---------|
| 1 | Price range | `0.003 ≤ price ≤ 0.97` | Reject degenerate prices near 0 or 1 |
| 2 | First price | `smoothedPrice !== null` | Initialize on first call, no prediction possible |
| 3 | Noise filter | `|rawPrice - lastRawPrice| ≥ 0.02` | Ignore tiny price jitters, reduce noise |
| 4 | Minimum history | `priceHistory.length ≥ 3` | Need at least 3 points for meaningful features |
| 5 | Pole detection | PoleDetector returns `true` | Only predict at local peaks/troughs |

**Important fix (noise filter):** Previously compared raw price to the *smoothed* `lastAddedPrice`, creating an inconsistent threshold. Now tracks `lastRawPrice` separately and compares raw-to-raw.

```typescript
// BEFORE (bug): compared raw to smoothed
if (Math.abs(price - this.lastAddedPrice) < NOISE_THRESHOLD) return null;
// lastAddedPrice was the smoothed price

// AFTER (fixed): compare raw to raw
if (this.lastRawPrice !== null &&
    Math.abs(price - this.lastRawPrice) < NOISE_THRESHOLD) return null;
this.lastRawPrice = price;
```

---

## 6. PoleDetector — Trigger Timing

The predictor does **not** produce a prediction on every price update. It only predicts at "poles" — local peaks and troughs in the smoothed price series.

**Why poles?** Poles represent moments where the price has just reversed direction. Predicting at these inflection points captures the moment of maximum information about the next directional move.

**Detection logic:**

```typescript
// src/utils/pricePredictor.ts:149-182

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

## 7. FeatureExtractor — What the Model Sees

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

**Quote intensity fix:** Previously `computeQuoteIntensity()` was only called inside `extractWithSnapshot()`, which only runs at pole detections. This meant it measured *pole frequency* (every few seconds), not *quote update frequency* (many per second). Fixed by adding `trackQuoteArrival()` called on every accepted price update before the pole gate:

```typescript
// Called on EVERY accepted update (before pole gate)
this.extractor.trackQuoteArrival(snapshot);

// Later, inside extractWithSnapshot (only at poles):
quoteIntensity: this.computeQuoteIntensity(), // reads pre-computed EMA
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

## 8. Online Linear Model — Predict()

The core model is a **weighted linear combination** of all 12 features:

```typescript
// src/utils/pricePredictor.ts:768-786

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

**Output:** `predictedPrice` is the model's estimate of where the UP token smoothed price will be at the next pole.

---

## 9. EdgeCalculator — From Prediction to Trade Decision

This is the most critical component for safety. It converts the raw model prediction into a **probabilistic, cost-aware trade decision**.

### Step-by-step pipeline

```
predictedPrice → delta → sigmoid → pUp/pDown → edge per side → safety gates → signal
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

### Step 6: Signal gating (6 safety layers)

```typescript
if (resolvedCount < WARMUP_MIN_RESOLVED)           → HOLD  // Not enough data
else if (volatility > VOL_CIRCUIT_BREAKER)          → HOLD  // Market too chaotic
else if (spread > MAX_SPREAD_TO_TRADE)              → HOLD  // Too illiquid
else if (adjustedEdge >= MIN_EDGE)                  → BUY_UP or BUY_DOWN
else                                                → HOLD  // Edge too weak
```

---

## 10. Safety Layers — When the Bot Refuses to Trade

The system has **multiple independent safety mechanisms**. A trade is only placed when ALL of them agree:

### Layer 1: Warm-up Gate (EdgeCalculator)
- **Threshold:** `resolvedCount < 5`
- **Behavior:** Force HOLD until at least 5 predictions have been made AND evaluated against real outcomes
- **Why:** Prevents trading before the model has any validated track record

### Layer 2: Volatility Circuit Breaker (EdgeCalculator)
- **Threshold:** `volatility > 0.08`
- **Behavior:** Force HOLD during high volatility
- **Why:** Chaotic price action makes predictions unreliable and fills unpredictable

### Layer 3: Spread Liquidity Gate (EdgeCalculator)
- **Threshold:** `spread > 0.06`
- **Behavior:** Force HOLD when bid-ask spread is too wide
- **Why:** Wide spreads mean high execution cost and poor fill quality

### Layer 4: Edge Threshold (EdgeCalculator)
- **Threshold:** `adjustedEdge < 0.03` (3 cents per share)
- **Behavior:** Force HOLD when edge after cost is insufficient
- **Why:** Only trade when expected profit clearly exceeds transaction costs

### Layer 5: Diagnostics Health Check (updown-bot.ts)
Before executing any trade, the bot queries `diagnostics.getHealthStatus()`:

| Check | Threshold | Action |
|-------|-----------|--------|
| Accuracy collapse | < 35% over last 20 predictions | **Disable trading entirely** |
| Max drawdown | Rolling PnL below -15% | **Disable trading entirely** |
| Overconfidence | Avg confidence > 72% but hit rate < 50% | Warning logged |
| Spread anomaly | Avg spread > 0.08 over last 10 records | Warning logged |
| Losing streak | 5+ consecutive losing trades | Warning logged |

```typescript
// In updown-bot.ts executePredictionTrade():
const health = predictor.getDiagnostics().getHealthStatus();
if (!health.tradingAllowed) {
    logger.warning(`SAFETY: trading disabled - ${health.warnings.join(", ")}`);
    return; // DO NOT TRADE
}
```

### Layer 6: Per-Side Position Limits (updown-bot.ts)
- Max `N` buys per side (UP / DOWN) per market cycle
- Once limit is reached, market is paused

**Net effect:** The bot will produce far more HOLD signals than trade signals. This is intentional — it only trades when the model is confident, the market is liquid, the edge is clear, and the track record supports it.

---

## 11. Online Learning — learnFromPending()

### The Timing Problem (previously a bug)

The model learns online — it updates its weights based on how well previous predictions matched reality. The critical requirement is **no label leakage**: the model must never train using information from the future.

### Learning Lifecycle

```
Pole T:
  1. Extract features_T from current price history
  2. Predict: predictedPrice_T = model(features_T)
  3. Store as pending: { features_T, predictedPrice_T, basePrice_T }

Pole T+1:
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

## 12. PredictionDiagnostics — Observability & Health

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
    basePrice                           // Reference price
}
```

When the outcome arrives (at next pole), it becomes a `ResolvedRecord` with:

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
Hit rate: 58.0% | Trade hit rate: 62.5%
Traded: 24 | Hold: 176 | No-trade rate: 88%
BUY_UP: 14 (64%) | BUY_DOWN: 10 (60%)
Avg edge before cost: 1.82% | after cost: 0.45%
Rolling PnL: 3.21% | Max drawdown: -2.14%
Calibration: [0.50-0.60] n=85 hit=52% | [0.60-0.70] n=67 hit=58% | ...
```

### Health assessment (single-pass scan)

The `getHealthStatus()` method scans the resolved buffer in a single pass and evaluates:

1. **Accuracy collapse**: Hit rate < 35% over last 20 predictions → **disable trading**
2. **Max drawdown**: Rolling PnL below -15% → **disable trading**
3. **Overconfidence**: High confidence + low hit rate → warning
4. **Spread anomaly**: Recent avg spread > 8 cents → warning
5. **Losing streak**: 5+ consecutive wrong trades → warning

---

## 13. Orchestrator — updateAndPredictWithSnapshot() Step by Step

Here is the exact sequence of operations, with line references:

```
updateAndPredictWithSnapshot(snapshot)
│
├─ Gate 1: price range check                    [line 633-636]
├─ Gate 2: first-price initialization           [line 638-644]
├─ Gate 3: noise filter (raw vs raw)            [line 647-653]
├─ Smooth: EMA(α=0.5) on price                 [line 655-665]
├─ Track quote arrival (quoteIntensity EMA)     [line 667-668]
├─ Buffer: push smoothed price, cap at 10      [line 670-678]
├─ Gate 4: minimum history (need 3+)           [line 680-681]
├─ Gate 5: pole detection                       [line 683-685]
│
│  ═══ Past all gates → at a pole ═══
│
├─ Step 1: learnFromPending(currentPrice)       [line 702-703]
│   └─ If pending exists: evaluate, update weights, record diagnostics
│
├─ Step 2: updateStatistics + extractWithSnapshot [line 705-707]
│   └─ Compute all 12 features from history + snapshot
│
├─ Step 3: predict(features)                    [line 709-710]
│   └─ Linear model → rawScore → denormalize → predictedPrice
│
├─ Step 4: updateEMA(currentPrice)              [line 712-713]
│   └─ Update short/long EMA for next call's trend feature
│
├─ Step 5: edge.compute(...)                    [line 715-725]
│   └─ sigmoid → pUp/pDown → edge → 6 safety gates → signal
│
├─ Step 6: store as pending                     [line 727-733]
│   └─ Freeze { features, predictedPrice, basePrice, confidence }
│
├─ Step 7: diagnostics.record(result)           [line 754-755]
│
├─ Timing guard: warn if > 20ms                [line 757-759]
│
└─ Return PricePrediction                       [line 763]
```

---

## 14. Key Constants Reference

### EdgeCalculator — Trade Decision

| Constant | Value | Purpose |
|----------|-------|---------|
| `SIGMOID_SENSITIVITY` | 15 | How aggressively price delta maps to probability |
| `FIXED_COST` | 0.008 | Slippage + Polymarket taker fee estimate per share |
| `DEFAULT_HALF_SPREAD` | 0.008 | Assumed half-spread when actual spread is unavailable |
| `MIN_EDGE` | 0.03 | Minimum net edge after cost required to trade (3%) |
| `VOL_CIRCUIT_BREAKER` | 0.08 | Max volatility before forcing HOLD |
| `MAX_SPREAD_TO_TRADE` | 0.06 | Max spread before forcing HOLD (6 cents) |
| `WARMUP_MIN_RESOLVED` | 5 | Min validated predictions before trading allowed |

### AdaptivePricePredictor — Model & Filtering

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_HISTORY` | 10 | Price buffer size (rolling window) |
| `NOISE_THRESHOLD` | 0.02 | Min raw price change to accept update (2 cents) |
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
| `ACCURACY_COLLAPSE_THRESHOLD` | 0.35 | Below this → disable trading |
| `MAX_DRAWDOWN_THRESHOLD` | -0.15 | Below this → disable trading |
| `OVERCONFIDENCE_CONF_THRESHOLD` | 0.72 | Confidence above this + low hit rate → warning |
| `LOSING_STREAK_LIMIT` | 5 | Consecutive losses triggering warning |
| `SPREAD_ANOMALY_THRESHOLD` | 0.08 | Avg spread above this → warning |

---

## 15. Recent Bug Fixes & Safety Improvements

### Bugs Fixed

| # | Issue | Impact | Fix |
|---|-------|--------|-----|
| 1 | **Dead stability code** — `stablePriceCount`, `updateStability()` were computed but never read | Wasted CPU, confusing dead code | Removed entirely |
| 2 | **Noise filter compared raw to smoothed** — `|rawPrice - smoothedPrice|` used inconsistent reference | Threshold behavior was unpredictable | Added `lastRawPrice` field, compare raw-to-raw |
| 3 | **quoteIntensity measured pole frequency** — only called at pole detections, not on every WS update | Feature measured the wrong thing entirely | Added `trackQuoteArrival()` called on every accepted update |

### Safety Improvements

| # | Change | Before → After | Effect |
|---|--------|---------------|--------|
| 1 | **Warm-up gate added** | Trade immediately on first prediction | HOLD until 5 predictions validated |
| 2 | **Cold-start accuracy** | Return phantom 0.6 with no data | Return 0.5 (coin-flip, no false confidence) |
| 3 | **MIN_EDGE raised** | 0.02 (2%) | 0.03 (3%) — higher bar for trading |
| 4 | **VOL_CIRCUIT_BREAKER tightened** | 0.12 | 0.08 — hold earlier in chaotic markets |
| 5 | **Spread gate added** | None | HOLD if spread > 0.06 (illiquid market) |
| 6 | **Cost estimates raised** | FIXED_COST 0.005, HALF_SPREAD 0.005 | 0.008, 0.008 — more conservative |
| 7 | **Max drawdown gate** | None | Disable trading if rolling PnL < -15% |
| 8 | **Losing streak warning** | None | Warn at 5+ consecutive losses |
| 9 | **Second-side limit order** | Hardcoded `0.98 - firstSidePrice` | Uses actual opposite-side ask with 2-cent discount, clamped so first+second < 0.98 |
| 10 | **Health check performance** | 3 separate slice+filter passes | Single-pass scan over buffer |

### Net Safety Posture

The bot now operates with a "trade reluctantly" philosophy:
- Most predictions result in HOLD (high no-trade rate is expected and desired)
- Trades only happen when edge is convincing (3%+ after cost), volatility is calm, spread is tight, and the model has a validated track record
- Auto-shutdown triggers exist for accuracy collapse and drawdown
- Every prediction is logged with full context for post-session analysis
