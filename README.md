# Polymarket Up/Down Prediction Trading Bot

**Polymarket prediction trading bot** for automated 15-minute Up/Down crypto market trading. Uses the CLOB API, WebSocket orderbook, an adaptive price predictor (Phase 1), and a Black–Scholes–style expiry phase (Phase 2 / HPAC) with Binance spot and EWMA volatility.

---

## What this bot does

Automated **Polymarket** trading on **15-minute Up/Down markets** (BTC, ETH, SOL, etc.). For most of each window it uses an **adaptive price predictor** at pole-like extrema, then places **passive GTC limit** buys: first leg at the signal side’s **best bid**, second leg at **`0.98 − firstLegLimit`** when allowed. In the **last 30 seconds**, it switches to **HPAC**: model-based edges/hedges from Binance vs strike, plus **FOK** exits on cheap legs or sudden drops. Built with TypeScript and Polymarket’s CLOB API.

---

## Trading strategy (detailed)

### 1. Big picture

Each **15-minute** window (`{asset}-updown-15m-{unixStart}`) is one **cycle**. The strategy is **two-phase**:

| Phase | Time remaining | Role |
|--------|----------------|------|
| **Phase 1** | **> 30 s** | AVMR-style predictor + **passive GTC** limits (lower fees; slower fills). |
| **Phase 2 (HPAC)** | **≤ 30 s** | No **new first legs**; **second legs** and **risk exits** only; **Black–Scholes–style** \(P(\mathrm{UP})\) from **Binance spot** \(S\), **strike** \(K\), **EWMA** \(\sigma\); aggressive limit prices where needed. |

### 2. Data sources

- **Polymarket CLOB WebSocket** — best **bid/ask** for UP and DOWN outcome tokens (signals, Phase 1 limits, Phase 2 asks).
- **Gamma API** — token IDs, condition ID; **strike \(K\)** parsed from market **question/title** (e.g. dollar amount). Preferred for BS; **Binance** can fallback if \(K\) is missing.
- **Binance WebSocket** (`aggTrade`) — live **spot \(S\)** and **EWMA volatility** (1-second bars, λ = 0.98 in code).

Cycle length is **900 s**; time left is derived from the slug’s start timestamp.

### 3. Phase 1 — predictor + passive pair

**When it runs:** If time remaining **> 30 s**, HPAC is skipped. Needs both UP/DOWN **asks** (filters) and **bids** (limit prices).

**Signal (`AdaptivePricePredictor`):** Short smoothed history, **pole** detection (local peaks/troughs), predictions only at poles. Outputs **direction** (`up` / `down`), **confidence**, **signal** (`BUY_UP` / `BUY_DOWN` / `HOLD`), and **features** (momentum, volatility, trend). Online gradient descent updates weights; learning uses reconstructed vol/trend from history.

**Trade filters (`executePredictionTrade`):**

- Confidence **≥ 0.50**; signal **≠ HOLD**.
- **Leg 1:** GTC limit at signal side’s **best bid** (tick-floored).
- **Leg 1 ask filter:** that side’s **best ask > 0.5** (`PHASE1_FIRST_LEG_MIN_ASK`).
- Market not **paused**; per-side count **< `TRADING_MAX_BUY_COUNTS_PER_SIDE`** (0 = no cap).
- **Imbalance:** if \(|UP - DOWN| \ge 2\), only buy the **lagging** side.
- **Cycle cap:** optional `TRADING_MAX_CYCLE_COST_USDC` — skip if cumulative cost would exceed cap.
- **Leg-2 suppress** (between **30 s and 60 s** left): if signal ask **> 0.7**, post **leg 1 only**; at most **one** such fire per direction per cycle.
- **Leg-2 sanity:** skip second leg if limit is **> 8¢ below** opposite **best ask** (unlikely fill).

**Leg 2 (when not suppressed):** GTC at **`0.98 − firstLegLimit`** on the opposite side.

**Locked box (for Phase 2):** If both sides have inventory and **avgUpCost + avgDownCost < 1**, HPAC treats this as a **profitable box** and **holds** to settlement.

### 4. Phase 2 — HPAC (last 30 s)

Runs on price updates and a **5 s** periodic scan. Per-cycle one-shot flags prevent duplicate HPAC actions.

**Black–Scholes (simplified, \(r=0\)):**  
\(d_2 = \frac{\ln(S/K) - (\sigma^2/2)\,T}{\sigma\sqrt{T}}\), \(P(\mathrm{UP}) = \Phi(d_2)\).  
**Edge:** `edge = P(UP) − upAsk − FEES_BUFFER` with **`FEES_BUFFER = 0.016`**.

**Decision order (conceptually):**

1. **Locked box** (both sides, avg costs sum **< 1**) → **hold**.
2. **Both sides, not locked** — if **UP ask ≤ 0.35** or **DOWN ask ≤ 0.35** → **FOK market sell** that leg (once per leg per cycle).
3. **Single leg, BS OK** — if ask **drops suddenly** (≥ **0.04** vs prior tick), compare BS prob of held outcome to **0.45** → **FOK sell** or **hold** (`expiryStrategy.ts`).
4. **Edge buy UP:** if **edge > 0.05** and **DOWN count > UP count** (second leg only) → aggressive limit **~ upAsk + 0.01** (GTC).
5. **Hedge DOWN:** if **P(UP) < 0.10** and **UP > DOWN** (once) → **~ downAsk + 0.01**.

If BS inputs are missing, cheap-leg exits may still run.

### 5. Orders summary

| Context | Side | Style |
|---------|------|--------|
| Phase 1 leg 1 | BUY | GTC @ **best bid** (signal side) |
| Phase 1 leg 2 | BUY | GTC @ **`0.98 − leg1`** |
| HPAC urgency | BUY | GTC @ **ask + 0.01** |
| HPAC / expiry exit | SELL | **FOK** market sell |

### 6. Risk, state, lifecycle

- **`cancelAll()`** on cycle rollover (debounced) clears stale GTCs — cancels **all** open orders for that **API key**; use a **dedicated** key if you trade elsewhere.
- **Inventory** is bot-tracked (counts/costs + async fills); can drift from the exchange.
- **Strike parsing** depends on Gamma question text; format changes may require code updates.
- State: `src/data/bot-state.json` (debounced saves). Timers cleared on **`stop()`**; final prediction summaries flush on shutdown.

### 7. Key source files

| File | Role |
|------|------|
| `src/order-builder/updown-bot.ts` | Phases, orders, HPAC, rollover, caps |
| `src/order-builder/strategies/expiryStrategy.ts` | BS \(P(\mathrm{UP})\), EWMA, expiry thresholds |
| `src/utils/pricePredictor.ts` | `AdaptivePricePredictor` |
| `src/providers/binanceWebSocket.ts` | Binance spot for \(S\) and EWMA |

---

## Overview

- **Strategy**: Two-phase — Phase 1: adaptive predictor + passive GTC pair building; Phase 2: HPAC (BS + exits) in the last 30 s.
- **Markets**: Configurable (e.g. `btc`, `eth`); slugs `{market}-updown-15m-{startOf15mUnix}` via Gamma API.
- **Stack**: TypeScript, Node (or Bun), `@polymarket/clob-client`, WebSocket orderbook, Binance WS, Ethers.js for allowances/redemption.

## Requirements

- Node.js 18+ (or Bun)
- Polygon wallet with USDC
- RPC URL for Polygon (e.g. Alchemy) for allowances and redemption

## Install

```bash
git clone https://github.com/CrewSX/polymarket-trading-bot.git
cd polymarket-trading-bot
npm install
```

## Configuration

Copy the example env and set at least `PRIVATE_KEY` and `TRADING_MARKETS`:

```bash
cp .env.temp .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet private key | **required** |
| `TRADING_MARKETS` | Comma-separated markets (e.g. `btc`) | `btc` |
| `TRADING_SHARES` | Shares per side per trade | `5` |
| `TRADING_TICK_SIZE` | Price precision | `0.01` |
| `TRADING_PRICE_BUFFER` | Price buffer for execution | `0` |
| `TRADING_WAIT_FOR_NEXT_MARKET_START` | Wait for next 15m boundary before starting | `false` |
| `TRADING_MAX_BUY_COUNTS_PER_SIDE` | Max buys per side per market (0 = no cap) | `0` |
| `TRADING_MAX_CYCLE_COST_USDC` | Max gross USDC spend per 15m cycle (0 = unlimited) | `0` |
| `CHAIN_ID` | Chain ID (Polygon) | `137` |
| `CLOB_API_URL` | Polymarket CLOB API base URL | `https://clob.polymarket.com` |
| `RPC_URL` / `RPC_TOKEN` | RPC for allowances/redemption | — |
| `BOT_MIN_USDC_BALANCE` | Min USDC to start | `1` |
| `LOG_DIR` / `LOG_FILE_PREFIX` | Log directory and file prefix | `logs` / `bot` |

> Legacy `COPYTRADE_*` env vars are still supported as fallback for backward compatibility.

API credentials are created on first run and stored in `src/data/credential.json`.

## Usage

**Run the prediction trading bot**

```bash
npm start
# or: bun src/index.ts
```

**Redemption**

```bash
# Auto-redeem resolved markets (holdings file)
npm run redeem:holdings

# Redeem by condition ID
npm run redeem

npm run redeem:auto -- --api --full --pools-within-hours 6 --no-redeemable-filter

```

**Development**

```bash
npx tsc --noEmit
bun --watch src/index.ts
```

## Project structure

| Path | Role |
|------|------|
| `src/index.ts` | Entry: credentials, CLOB, allowances, min balance, start `UpDownPredictionBot`. |
| `src/config/index.ts` | Loads `.env` and exposes config (chain, CLOB, trading, logging). |
| `src/order-builder/updown-bot.ts` | **UpDownPredictionBot**: 15m slug, WS orderbook, Phase 1 + Phase 2 (HPAC), rollover, state. |
| `src/order-builder/strategies/expiryStrategy.ts` | BS \(P(\mathrm{UP})\), EWMA vol, expiry thresholds, sudden-drop logic. |
| `src/providers/clobclient.ts` | Polymarket CLOB client singleton (credentials + `PRIVATE_KEY`). |
| `src/providers/websocketOrderbook.ts` | WebSocket to Polymarket CLOB; best bid/ask by token ID. |
| `src/providers/binanceWebSocket.ts` | Binance aggTrade stream for spot and EWMA input. |
| `src/utils/pricePredictor.ts` | **AdaptivePricePredictor**: direction, confidence, signal. |
| `src/utils/redeem.ts` | CTF redemption, resolution checks, auto-redeem from holdings or API. |
| `src/security/allowance.ts` | USDC and CTF approvals. |
| `src/data/token-holding.json` | Token holdings for redemption (generated). |
| `src/data/bot-state.json` | Per-slug state (prices, timestamps, metadata). |

## Risk and disclaimer

Trading prediction markets involves significant risk. This software is provided as-is. Use at your own discretion and only with funds you can afford to lose. **`cancelAll()`** on cycle rollover affects every open order for the configured API key.

## License

ISC
