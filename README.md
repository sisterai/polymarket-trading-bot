# Polymarket Up/Down Prediction Trading Bot

**Polymarket prediction trading bot** for automated 15-minute Up/Down crypto market trading. Uses the CLOB API, WebSocket orderbook, and an adaptive price predictor to place directional + hedge paired trades.

---


## What this bot does

Automated **Polymarket** trading on **15-minute Up/Down markets** (BTC, ETH, SOL, etc.). It uses an adaptive price predictor to detect price poles (peaks/troughs), predict direction, then places a first-side limit order at best ask and a second-side hedge at `0.98 − firstSidePrice`. Built with TypeScript and Polymarket's CLOB API.


## Overview

- **Strategy**: Predict Up/Down from live orderbook via an adaptive price predictor; buy the predicted side at best ask (GTC), then place the opposite side at `0.98 − firstSidePrice` (GTC).
- **Markets**: Configurable list (e.g. `btc`, `eth`); slugs are resolved as `{market}-updown-15m-{startOf15mUnix}` via Polymarket Gamma API.
- **Stack**: TypeScript, Node (or Bun), `@polymarket/clob-client`, WebSocket orderbook, Ethers.js for allowances/redemption.

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
| `src/order-builder/updown-bot.ts` | **UpDownPredictionBot**: 15m slug resolution, WebSocket orderbook, predictor → first-side buy + second-side hedge; state in `src/data/bot-state.json`. |
| `src/providers/clobclient.ts` | Polymarket CLOB client singleton (credentials + `PRIVATE_KEY`). |
| `src/providers/websocketOrderbook.ts` | WebSocket to Polymarket CLOB market channel; best bid/ask by token ID. |
| `src/utils/pricePredictor.ts` | **AdaptivePricePredictor**: direction, confidence, signal (BUY_UP / BUY_DOWN / HOLD). |
| `src/utils/redeem.ts` | CTF redemption, resolution checks, auto-redeem from holdings or API. |
| `src/security/allowance.ts` | USDC and CTF approvals. |
| `src/data/token-holding.json` | Token holdings for redemption (generated). |
| `src/data/bot-state.json` | Per-slug state (prices, timestamps, buy counts). |

## Risk and disclaimer

Trading prediction markets involves significant risk. This software is provided as-is. Use at your own discretion and only with funds you can afford to lose.

## License

ISC
