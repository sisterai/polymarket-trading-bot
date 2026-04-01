# Trading Agents & Strategy Guide (Current Implementation)

## Purpose

This document explains the **current** trading-agent architecture in this repo, how signals are produced, how each strategy behaves, and how risk controls are layered before any order is sent.

It is written from the actual implementation in:

- `src/index.ts`
- `src/order-builder/updown-bot.ts`
- `src/order-builder/strategies/*.ts`
- `src/utils/pricePredictor.ts`
- `src/utils/microstructure-regimes.ts`
- `src/utils/diagnostics.ts`
- `src/utils/regime-diagnostics.ts`
- `src/utils/low-signal-gate.ts`
- `src/utils/execution-risk-gate.ts`
- `src/utils/expiry-close-gate.ts`

---

## 1) Agent Topology

### Boot Agent (`src/index.ts`)

`main()` is the bootstrap orchestrator.

Responsibilities:

1. Create/load credentials.
2. Initialize CLOB client.
3. Approve/sync allowances.
4. Block until min USDC balance is available.
5. Optionally wait for next 5-minute boundary.
6. Create and start `UpDownPredictionBot`.
7. Handle graceful shutdown (SIGINT/SIGTERM), including final summaries.

---

### Runtime Trading Agent (`UpDownPredictionBot`)

`UpDownPredictionBot` is the live market agent.

Core responsibilities:

- Resolve current 5-minute BTC slug from wall clock.
- Fetch token IDs (UP/DOWN) from Gamma for that slug.
- Subscribe to both token feeds via WebSocket orderbook.
- Build `MarketSnapshot` for each accepted tick.
- Maintain one `AdaptivePricePredictor` per market.
- Apply regime-specific strategy overrides and risk overrides.
- Execute first-side buy and second-side hedge limit order.
- Track fills, token counts, prediction scores, diagnostics.
- Handle cycle rollover and predictor/strategy state reset.

Important scheduling:

- Summary generation check every 60s at 5m boundaries.
- Cycle-change detection every 10s (`checkAndHandleMarketCycleChanges`).

---

### Predictor Agent (`AdaptivePricePredictor`)

`AdaptivePricePredictor` is the model + decision engine. It does not place orders; it outputs `PricePrediction`.

Outputs include:

- `signal`: `BUY_UP` / `BUY_DOWN` / `HOLD`
- `direction`, `confidence`
- `pUp`, `pDown`
- edge estimates per side
- regime fields: `regime`, `regimeConfidence`, `regimeScoreMargin`
- optional safety block fields

It now exposes runtime internals for strategy layers:

- `getLatestMicrostructure()`
- `getLatestRegimeResult()`
- `getRegimeDiagnostics()`

---

## 2) End-to-End Decision Flow

1. WebSocket update arrives.
2. Bot fetches both UP/DOWN asks and creates `MarketSnapshot`.
3. Predictor processes tick and may return `null` (no trigger) or a `PricePrediction`.
4. If prediction exists, bot loads latest micro/regime from predictor.
5. If regime is directional and strategy module conditions pass, strategy can override direction/signal/size.
6. Global post-strategy gates may still force `HOLD`:
   - low-signal gate
   - execution-risk gate
   - expiry-close gate
7. If final signal is not `HOLD`, bot executes first-side buy then opposite-side limit hedge.
8. Bot tracks fills, trade score, and diagnostics.

---

## 3) Market Snapshot Contract

Canonical type is from `microstructure-regimes.ts`:

- required: `bestBid`, `bestAsk`, `bestBidSize`, `bestAskSize`, `timestamp`
- optional: top-3 depths, flow/event fields, `roundEndTimestamp`, `downAsk`, `roundStartTime`

Current bot construction (`updown-bot.ts`) intentionally uses placeholders for still-missing depth/size streams:

- `bestBidSize = 0`, `bestAskSize = 0`
- `bidDepthTop3`/`askDepthTop3 = undefined`
- `recentEventCount = 1`

So the pipeline is ready for richer micro data when streaming is expanded.

---

## 4) Regime Engine (7 Regimes)

`microstructure-regimes.ts` classifies each accepted tick into:

- `flow_dominance`
- `momentum`
- `breakout`
- `reversal`
- `liquidity_vacuum`
- `expiry`
- `chop`

### Detection mechanics

- Computes normalized feature set (`NormalizedFeatureSet`) via `MicrostructureFeatureEngine.update()`.
- Scores all regimes with adaptive z-score/rank formulas.
- Applies override regimes first (`liquidity_vacuum`, `expiry`).
- Uses score competition + minimum margin + guidance checks.
- Applies persistence checks and reversal confirmation.
- Uses hysteresis to avoid directional flip churn.

Defaults worth noting:

- `minimumScoreMargin = 0.10`
- `liquidityVacuumOverrideScore = 0.70`
- `expiryOverrideScore = 0.75`
- directional min confidence bands around ~0.65+

---

## 5) Predictor Trigger Policy

Inside `updateAndPredictWithSnapshot()` in `pricePredictor.ts`:

- Always update micro features + regime diagnostics on every accepted tick.
- Prediction trigger policy:
  - `reversal` / `chop`: pole-only
  - `flow_dominance` / `momentum` / `breakout`: pole OR >=2 accepted updates
  - `expiry` / `liquidity_vacuum`: pole OR >=1 accepted update

This allows faster reaction in urgent regimes while preserving pole discipline in noisier states.

---

## 6) Model + Edge Decision Layer

### Feature set (12 total)

- Legacy price features: lags, momentum, volatility, trend
- Micro features: spread, microprice, book imbalance, downAsk delta, time remaining, quote intensity

### Edge conversion (`EdgeCalculator`)

Pipeline:

1. `delta = predictedPrice - currentPrice`
2. sigmoid -> `pUp`, `pDown`
3. cost estimate from half-spread + fixed cost
4. edge per side (`edgeBuyUp`, `edgeBuyDown`)
5. choose best direction
6. apply accuracy discount when recent hit rate < 0.5
7. apply regime-specific min-edge + volatility gates

Current constants:

- fixed cost: `0.008`
- default half spread: `0.008`
- max spread gate: `0.06`
- warmup resolved min: `5`

Regime edge thresholds:

- flow dominance: `0.024`
- momentum: `0.025`
- breakout: `0.028`
- reversal: `0.03`
- expiry: `0.04`
- liquidity-vacuum exception: `0.038`

Vol breakers:

- momentum: `0.12`
- breakout: `0.10`
- reversal: `0.08`
- expiry: `0.06`

Liquidity-vacuum handling in edge layer:

- default HOLD
- allow only if `flow_dominance` score >= `0.8`
- otherwise sets `blockedBySafetyGate` + reason

---

## 7) Regime Strategy Modules (Bot Layer)

After predictor output, bot applies regime-specific strategy logic from `src/order-builder/strategies`.

### 7.1 Flow Dominance (`flow-dominance.ts`)

Intent: aggressive continuation when OFI + queue pressure are aligned.

Entry conditions include:

- regime must be `flow_dominance`
- `|zOfiNorm| >= 1.2`
- `|zQueueImbalance| >= 0.8`
- persistence >= `0.6`
- spread rank <= `0.80`
- depth rank >= `0.25`
- entry score >= `0.65`

Risk blockers:

- hard spread pct cap `1.5%`
- minimum depth rank `0.2`

Sizing:

- `base * clamp(entryScore * regimeConfidence, 0.5, 1.5)`

Exit:

- OFI sign flip, pressure fade, spread blowout, near-expiry, or max-hold > 15 events.

No pyramiding:

- active hold state blocks new entries.

---

### 7.2 Momentum (`momentum.ts`)

Intent: continuation with stricter quality constraints than flow dominance.

Entry conditions include:

- regime `momentum`
- momentum score >= `0.65`
- persistence >= `0.6`
- realized vol rank in `[0.30, 0.85]`
- spread rank <= `0.75`
- OFI + queue + return1 sign alignment
- pullback condition (avoid spike chasing)

Sizing:

- approximately `base * 0.7 * momentumScore`

Exit:

- OFI flip, persistence < `0.4`, vol spike, or max-hold > 10 events.

---

### 7.3 Breakout (`breakout.ts`)

Intent: avoid first-spike traps; trade confirmed breakouts only.

Two-stage behavior:

1. **ARM** on first qualified breakout signal (HOLD).
2. **ENTER** only on later confirmation tick.

Key parameters:

- compression lookback events: `16`
- range break minimum: `5 bps`
- arm max age: `3 ticks`
- max hold: `12 events`

Exit:

- price re-enters prior range, OFI weakens, spread too wide, or duration cap.

---

### 7.4 Reversal (`reversal.ts`)

Intent: mean-reversion fade after exhaustion/divergence in strong trend.

Two-stage behavior:

1. ARM when trend-strength + divergence + exhaustion pass.
2. ENTER only after next confirmation event.

Key parameters:

- recent trend window: `8`
- trend strength threshold: `0.001`
- arm max age: `3`
- max hold: `10`

Exit:

- prior trend resumes strongly, OFI realigns to old trend, or hold duration exceeded.

---

## 8) Global No-Trade / Risk Overrides (Post-Strategy)

These execute after strategy logic and can still force `HOLD`.

### Low-signal gate (`low-signal-gate.ts`)

Blocks when:

- regime is `chop`, or
- `bestScore < 0.65`, or
- `scoreMargin < 0.10`

### Execution-risk gate (`execution-risk-gate.ts`)

Danger conditions:

- regime `liquidity_vacuum`, or
- spread rank >= `0.9`, or
- depth rank <= `0.2`

Exception:

- allow small trade only if `flow_dominance` score >= `0.8`
- size capped to `30%` of base

### Expiry-close gate (`expiry-close-gate.ts`)

When `timeToExpiryMs < 20_000`:

- default HOLD
- optional exception only if strong flow + spread/depth quality
- size capped to `50%` of base

---

## 9) Order Execution Model

If final signal is tradable:

1. **First-side buy** at `ask + 0.01` as GTC (`buyShares`).
2. **Second-side hedge limit** immediately (`placeSecondSideLimitOrder`).

Second-side pricing:

- prefer `oppositeAsk - 0.02`
- fallback `0.98 - firstSidePrice`
- clamp with `maxSecondPrice = min(0.97, 0.98 - firstSidePrice)`
- ensures combined structure remains under 0.98 target envelope

Second-side fills are tracked asynchronously (`trackLimitOrderAsync`) with bounded polling/backoff.

Per-side limits:

- enforced before order placement
- when both sides hit configured cap, market key is paused

---

## 10) Learning & Adaptation

`learnFromPending()` performs online updates without leakage:

- evaluates previous prediction at next realized trigger
- directional correctness from `basePrice`
- asymmetric adaptation:
  - faster correction on wrong calls (`mult=8.0`, decay `0.85`)
  - gentler updates on right calls (`mult=2.5`, decay `0.97`)
- learning-rate bounds: `[0.005, 0.2]`

Also records:

- prediction diagnostics resolution
- regime diagnostics resolution (only when direction is non-flat)

---

## 11) Observability Agents

### Prediction diagnostics (`diagnostics.ts`)

Tracks prediction/trade quality and health.

Important health defaults:

- accuracy collapse threshold: `0.35`
- min samples for collapse: `15`
- max drawdown threshold: `-0.15`
- losing streak warning: `5`
- spread anomaly threshold: `0.08`

`executePredictionTrade()` checks `tradingAllowed`; if false, it skips trading.

### Regime diagnostics (`regime-diagnostics.ts`)

Tracks regime-level distribution and quality:

- frequency, transitions, avg duration
- per-regime trade/hold rate and hit rate
- safety blocks, edge quality
- close-margin and rapid-switch telemetry

Safety normalization anchors:

- spread safety rank: `0.80`
- depth safety rank: `0.25`

---

## 12) Cycle Management

Bot continuously handles 5-minute market rollover:

- detects slug change
- re-fetches token IDs
- updates WS subscriptions/callbacks
- resets predictor and strategy-hold state
- keeps session-level reporting coherent

On stop/shutdown:

- generates prediction summaries
- prints diagnostics and regime diagnostics snapshots

---

## 13) Practical Strategy Interpretation

- This is a **multi-agent layered system**, not a single classifier.
- Predictor provides a probabilistic edge proposal.
- Regime strategies enforce pattern-specific entry discipline.
- Global gates enforce capital protection under weak/hostile conditions.
- Execution logic enforces paired structure and side limits.
- Diagnostics can disable trading when model quality degrades.

In short: **trade only when signal quality, regime confidence, liquidity, and risk posture all agree**.

---

## 14) Current Known Constraints / TODO Surface

1. Snapshot currently uses placeholder depth/size values (`0` / `undefined`) in live bot.
2. `recentEventCount` is currently fixed at `1`; richer event-intensity input remains to be wired.
3. Full top-of-book size/depth stream integration will improve micro/regime quality.
4. Optional calibration can be done by replaying regime diagnostics histories.

---

## 15) Quick Reference of Main Constants

### Predictor / Edge

- `MAX_SPREAD_TO_TRADE = 0.06`
- `WARMUP_MIN_RESOLVED = 5`
- `MIN_EDGE`: 0.024 / 0.025 / 0.028 / 0.03 / 0.04 by regime
- `VOL_BREAKER`: 0.12 / 0.10 / 0.08 / 0.06 by regime family
- `LEARNING_RATE = 0.05` (bounded 0.005..0.2)
- noise floor components: tick floor 0.01, spread factor 0.5, vol factor 0.3

### Global bot risk gates

- low signal: `bestScore < 0.65` or `margin < 0.10`
- execution risk: spread rank >= 0.9 or depth rank <= 0.2
- execution-risk small-trade exception flow score: >= 0.8 (size <= 30%)
- expiry close window: < 20s (size <= 50% on strict exception)

### Strategy max-hold

- flow dominance: 15
- momentum: 10
- breakout: 12
- reversal: 10

---

## 16) Recommended Next Improvements

1. Wire true size/depth/event-flow fields from orderbook stream into snapshot.
2. Add backtest/replay tooling to score each strategy branch independently.
3. Add per-regime PnL attribution and Sharpe-like metrics to diagnostics.
4. Add runtime-configurable thresholds per strategy for safer live tuning.
5. Add feature/score export (JSONL) for offline calibration and threshold fitting.
