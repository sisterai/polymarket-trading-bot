# Polymarket BTC Up/Down Trading Bot

Automated trading bot for Polymarket BTC 5-minute Up/Down pools with:

- event-driven WebSocket processing
- adaptive prediction + market-regime classification
- strategy-specific entry/exit logic
- layered risk controls
- diagnostics and health-based trade disabling

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Full Lifecycle](#full-lifecycle)
3. [Trading Pipeline](#trading-pipeline)
4. [Strategies by Regime](#strategies-by-regime)
5. [Risk and Safety Layers](#risk-and-safety-layers)
6. [Execution Model](#execution-model)
7. [Diagnostics and Monitoring](#diagnostics-and-monitoring)
8. [Market-Cycle Management](#market-cycle-management)
9. [Setup and Configuration](#setup-and-configuration)
10. [Runbook](#runbook)
11. [Project Structure](#project-structure)
12. [Important Notes](#important-notes)

---

## System Overview

This bot trades the current BTC 5-minute Up/Down market by continuously:

1. reading orderbook best bid/ask updates,
2. building a `MarketSnapshot`,
3. running `AdaptivePricePredictor`,
4. refining decisions with regime strategies,
5. applying global risk gates,
6. executing only when the final signal is tradable.

### Key characteristics

- **Market**: fixed to `btc`.
- **Cycle**: one market slug per 5-minute boundary.
- **Signal output**: `BUY_UP`, `BUY_DOWN`, or `HOLD`.
- **Execution model**: currently **single-leg execution** only (no legacy two-leg hedge path).
- **Stateful**: keeps per-market predictor state and cycle stats.

---

## Full Lifecycle

### 1) Boot lifecycle (`src/index.ts`)

Startup flow:

1. Setup console+file logging.
2. Create/load API credentials.
3. Initialize CLOB client.
4. Approve and sync on-chain allowances.
5. Wait until minimum USDC is available.
6. Optionally wait for next 5-minute market boundary.
7. Create and start `UpDownPredictionBot`.
8. Attach graceful shutdown handlers (SIGINT/SIGTERM).

### 2) Runtime lifecycle (`UpDownPredictionBot`)

At runtime the bot:

- initializes current slug + token IDs,
- subscribes to UP/DOWN token price streams,
- handles every significant price tick asynchronously,
- detects cycle changes and reinitializes market context,
- accumulates strategy and diagnostics telemetry,
- stops safely and emits final summaries on shutdown.

### 3) Market-cycle lifecycle

Every 5 minutes the bot transitions from old slug to new slug:

- fetches new token IDs,
- updates subscriptions/callbacks,
- resets predictor runtime state for new cycle,
- clears strategy hold/arming state,
- keeps long-session diagnostics/reporting output.

---

## Trading Pipeline

### Step A: Data ingest

`WebSocketOrderBook` streams token prices. Bot requires both UP and DOWN asks for a valid processing tick.

### Step B: Build `MarketSnapshot`

Bot builds snapshot fields including:

- bid/ask prices
- timestamp
- round start/end timing
- down ask
- event-count placeholders

### Step C: Prediction + regime classification

`AdaptivePricePredictor.updateAndPredictWithSnapshot(snapshot)` handles:

- adaptive noise gating
- smoothing
- microstructure feature updates
- 7-regime detection
- trigger policy (pole + regime-dependent bypass)
- model prediction
- edge-based signal gating

### Step D: Regime strategy overrides

Bot reads:

- `getLatestMicrostructure()`
- `getLatestRegimeResult()`

Then applies strategy modules for directional regimes.

### Step E: Global post-strategy gates

Even after a strategy says enter, bot can still force `HOLD` via:

- low-signal gate
- execution-risk gate
- expiry-close gate

### Step F: Trade execution

If final signal is tradable:

- execute one directional buy (`UP` for up, `DOWN` for down)
- enforce per-side caps
- record trade in score/diagnostic structures

---

## Strategies by Regime

Strategies are in `src/order-builder/strategies`.

### 1) `flow_dominance`

Aggressive continuation based on OFI + queue imbalance + persistence.

Typical characteristics:

- strong micro pressure required
- spread/depth quality required
- dynamic size scaling from entry score and regime confidence
- fast exit on pressure decay/flip or expiry proximity

### 2) `momentum`

Continuation strategy with stricter filters than flow dominance.

Typical characteristics:

- momentum score threshold
- persistence threshold
- volatility band and spread rank constraints
- pullback-entry logic to avoid chasing spike tops
- shorter max hold window

### 3) `breakout`

Two-stage breakout logic:

- **arm** on first qualified breakout setup
- **enter** only after confirmation tick

Typical characteristics:

- requires prior compression context
- expansion and range-break checks
- confirmation timeout window
- exit on failed breakout or micro deterioration

### 4) `reversal`

Two-stage mean-reversion logic:

- arm on trend-exhaustion/divergence setup
- enter only on later confirmation

Typical characteristics:

- requires trend strength + divergence + exhaustion
- exits when prior trend resumes or OFI realigns
- bounded hold duration

### Non-directional / safety regimes

- `liquidity_vacuum`: dangerous liquidity state; mostly no-trade with tiny exception path.
- `expiry`: close-to-expiry caution regime.
- `chop`: low-conviction/noise regime.

---

## Risk and Safety Layers

Risk is intentionally layered. A trade must pass all relevant checks.

### Predictor-level gating

- warmup minimum resolved predictions
- spread gate
- volatility breaker
- regime-conditioned minimum edge
- liquidity-vacuum exception gate

### Bot-level global gates

1. **Low-signal gate**
   - blocks chop / weak score / low score margin.
2. **Execution-risk gate**
   - blocks vacuum/thin/wide conditions.
   - optional tiny-size exception only under strong flow score.
3. **Expiry-close gate**
   - default no-trade in final seconds unless strict exception criteria pass.

### Health-based kill switch

`PredictionDiagnostics.getHealthStatus()` can disable trading when quality degrades (for example, collapse in recent accuracy or deep drawdown conditions).

---

## Execution Model

### Current implementation

This repository currently uses **single-leg execution** for each tradable signal:

- final direction `up` -> buy UP side
- final direction `down` -> buy DOWN side

The old two-leg immediate hedge path has been removed from the active execution flow.

### Per-side limits and pause

The bot tracks UP/DOWN buy counts per market key.

- if one side reaches configured max, that side is skipped
- when both sides reach max, market key is paused

---

## Diagnostics and Monitoring

### Prediction diagnostics (`src/utils/diagnostics.ts`)

Tracks:

- prediction counts, hold/trade rates
- directional hit rates
- confidence calibration buckets
- rolling edge estimates and PnL proxies
- health warnings and trade-allowed status

### Regime diagnostics (`src/utils/regime-diagnostics.ts`)

Tracks:

- regime frequencies and transitions
- run durations
- per-regime trade/hold behavior
- per-regime hit rates and safety blocks
- regime-level edge averages

### Logging

- colored runtime logs by info/warn/error/debug
- colored regime and strategy tags
- ANSI-stripped file logs with daily rotation support

---

## Market-Cycle Management

The bot continuously checks cycle boundaries and reinitializes market state.

During reinit it:

- switches token IDs to new slug
- refreshes WebSocket subscriptions/callbacks
- resets predictor state for the market
- clears regime strategy arm/hold state maps

This keeps the strategy aligned with the current 5-minute market contract.

---

## Setup and Configuration

### Requirements

- Node.js 18+
- Polygon wallet with USDC
- RPC endpoint for allowance/redeem utilities

### Install

```bash
git clone https://github.com/CrewSX/polymarket-trading-bot.git
cd polymarket-trading-bot
npm install
```

### Environment

Copy and edit env file:

```bash
cp .env.temp .env
```

Common variables:

- `PRIVATE_KEY` (required)
- `TRADING_SHARES`
- `TRADING_TICK_SIZE`
- `TRADING_WAIT_FOR_NEXT_MARKET_START`
- `TRADING_MAX_BUY_COUNTS_PER_SIDE`
- `BOT_MIN_USDC_BALANCE`
- `CLOB_API_URL`
- `CHAIN_ID`
- `RPC_URL`, `RPC_TOKEN`
- `LOG_DIR`, `LOG_FILE_PREFIX`, `LOG_FILE_PATH`

Credential artifact is stored in `src/data/credential.json`.

---

## Runbook

### Start bot

```bash
npm start
```

### Dev typecheck

```bash
npx tsc --noEmit
```

### Redemption flows

```bash
npm run redeem:holdings
npm run redeem
npm run redeem:auto -- --api --full --pools-within-hours 6 --no-redeemable-filter
```

### Operational checklist before live run

1. wallet funded with enough USDC
2. allowances synced successfully
3. log directory writable
4. env caps and share size validated
5. dry run in paper/small size first

---

## Project Structure

| Path | Role |
|------|------|
| `src/index.ts` | Boot + readiness gates + bot lifecycle start/stop |
| `src/order-builder/updown-bot.ts` | Runtime market agent, strategy orchestration, execution |
| `src/order-builder/strategies/*.ts` | Regime-specific entry/exit/size rules |
| `src/utils/pricePredictor.ts` | Adaptive predictor, edge decision, micro/regime integration |
| `src/utils/microstructure-regimes.ts` | Feature engine + regime detector |
| `src/utils/diagnostics.ts` | Prediction health and performance stats |
| `src/utils/regime-diagnostics.ts` | Regime transition/quality diagnostics |
| `src/utils/*-gate.ts` | Global risk/no-trade gates |
| `src/providers/websocketOrderbook.ts` | WebSocket market data ingestion |
| `src/providers/clobclient.ts` | CLOB client setup |
| `src/security/allowance.ts` | Allowance and balance-related setup |

---

## Important Notes

- This is a high-risk trading system; no profit guarantee.
- Keep trade size conservative while tuning strategy thresholds.
- Monitor diagnostics logs continuously; do not run unattended until stable.
- Use only capital you can afford to lose.

---

## License

ISC
