import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrder } from "@polymarket/clob-client";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { config } from "../config";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction } from "../utils/pricePredictor";
import { BinanceWebSocket, marketToBinanceSymbol } from "../providers/binanceWebSocket";
import {
    EWMAVolatility,
    computeUpProbability,
    detectSuddenAskDrop,
    EXPIRY_CHEAP_LEG_ASK_THRESHOLD,
    EXPIRY_REMAINING_HOLD_MIN_BS_PROB,
    remainingLegBlackScholesSellOrHold,
} from "./strategies/expiryStrategy";
// Helper functions for market slug and token IDs
function slugForCurrent15m(market: string): string {
    const now = new Date();
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setMilliseconds(0);
    const m = d.getMinutes();
    const slotMin = Math.floor(m / 15) * 15;
    d.setMinutes(slotMin, 0, 0);
    // Get Unix timestamp in seconds for the start of this 15-minute slot
    const timestamp = Math.floor(d.getTime() / 1000);
    // Format: {market}-updown-15m-{timestamp}
    return `${market}-updown-15m-${timestamp}`;
}

function parseJsonArray<T>(raw: unknown, ctx: string): T[] {
    if (typeof raw !== "string") throw new Error(`${ctx}: expected JSON string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${ctx}: expected JSON array`);
    return parsed as T[];
}

async function fetchTokenIdsForSlug(
    slug: string
): Promise<{ upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }> {
    const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} ${response.statusText} for slug=${slug}`);
    }

    const data = (await response.json()) as any;
    const outcomes = parseJsonArray<string>(data.outcomes, "data.outcomes");
    const tokenIds = parseJsonArray<string>(data.clobTokenIds, "data.clobTokenIds");
    const conditionId = data.conditionId as string;

    const upIdx = outcomes.indexOf("Up");
    const downIdx = outcomes.indexOf("Down");
    if (upIdx < 0 || downIdx < 0) throw new Error(`Missing Up/Down outcomes for slug=${slug}`);
    if (!tokenIds[upIdx] || !tokenIds[downIdx]) throw new Error(`Missing token ids for slug=${slug}`);

    return { upTokenId: tokenIds[upIdx], downTokenId: tokenIds[downIdx], conditionId, upIdx, downIdx };
}

type SimpleStateRow = {
    previousUpPrice: number | null; // Previous cycle's UP token price
    lastUpdatedIso: string;
    // Holdings tracking (for redemption)
    conditionId?: string;
    slug?: string;
    market?: string;
    upIdx?: number;
    downIdx?: number;
};

type SimpleStateFile = Record<string, SimpleStateRow>;

type SimpleConfig = {
    markets: string[]; // e.g. ["btc","eth","sol","xrp"]
    sharesPerSide: number; // shares required per side (e.g., 5)
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    priceBuffer: number; // Price buffer in cents for order execution (e.g., 0.03 = 3 cents)
    fireAndForget: boolean; // Don't wait for order confirmation (fire-and-forget)
    // Risk management
    minBalanceUsdc: number; // Minimum balance before stopping
};

const STATE_FILE = "src/data/bot-state.json";

// Expiry strategy constants
const HPAC_WINDOW_SECONDS = 30;      // switch to HPAC in last N seconds
const HPAC_EDGE_THRESHOLD = 0.05;    // minimum P(UP) - mktPrice edge to buy
const FEES_BUFFER = 0.016;           // 1.6% fee reserve
const MARKET_DURATION_SECONDS = 900; // 15-minute markets
/** Phase 1 first leg only when this side's best ask is above 50¢ (implied prob > 50%). */
const PHASE1_FIRST_LEG_MIN_ASK = 0.5;
/** Between last 60s and last 30s: if signal ask exceeds this, post leg1 only (no leg2 GTC). */
const PHASE1_LEG2_SUPPRESS_WINDOW_SEC = 60;
const PHASE1_LEG2_SUPPRESS_MIN_ASK = 0.7;

function statePath(): string {
    return path.resolve(process.cwd(), STATE_FILE);
}

function emptyRow(): SimpleStateRow {
    return {
        previousUpPrice: null,
        lastUpdatedIso: new Date().toISOString(),
    };
}

function floorPriceToTick(price: number, tickSize: string): number {
    const tick = parseFloat(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    return Math.floor(price / tick) * tick;
}

function loadState(): SimpleStateFile {
    const p = statePath();
    try {
        if (fs.existsSync(p)) {
            const raw = fs.readFileSync(p, "utf8").trim();
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            // Normalize state
            const normalized: SimpleStateFile = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (typeof v !== "object" || !v) continue;
                const row = v as any;
                normalized[k] = {
                    previousUpPrice: typeof row.previousUpPrice === "number" ? row.previousUpPrice : null,
                    lastUpdatedIso: String(row.lastUpdatedIso ?? new Date().toISOString()),
                    conditionId: typeof row.conditionId === "string" ? row.conditionId : undefined,
                    slug: typeof row.slug === "string" ? row.slug : undefined,
                    market: typeof row.market === "string" ? row.market : undefined,
                    upIdx: Number.isFinite(Number(row.upIdx)) ? Number(row.upIdx) : undefined,
                    downIdx: Number.isFinite(Number(row.downIdx)) ? Number(row.downIdx) : undefined,
                };
            }
            return normalized;
        }
    } catch (e) {
        logger.error(`Failed to read state: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
}

// Debounced state save
let saveStateTimer: NodeJS.Timeout | null = null;
function saveState(state: SimpleStateFile): void {
    if (saveStateTimer) {
        clearTimeout(saveStateTimer);
    }
    saveStateTimer = setTimeout(() => {
        try {
            const p = statePath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(state, null, 2));
        } catch (e) {
            logger.error(`Failed to save state: ${e instanceof Error ? e.message : String(e)}`);
        }
        saveStateTimer = null;
    }, 500); // Debounce saves by 500ms
}

export class UpDownPredictionBot {
    private lastSlugByMarket: Record<string, string> = {};
    private tokenIdsByMarket: Record<
        string,
        { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number }
    > = {};
    private state: SimpleStateFile = loadState();
    private isStopped: boolean = false;
    private wsOrderBook: WebSocketOrderBook | null = null;
    private useWebSocket: boolean = true; // Toggle to use WebSocket or API
    private lastProcessedPrice: Map<string, number> = new Map();
    private pricePredictors: Map<string, AdaptivePricePredictor> = new Map();
    private lastPredictions: Map<string, { prediction: PricePrediction; actualPrice: number; timestamp: number }> = new Map();

    // Limit order second side strategy tracking
    private tokenCountsByMarket: Map<string, { upTokenCount: number; downTokenCount: number }> = new Map(); // Track token counts per market
    private pausedMarkets: Set<string> = new Set(); // Track paused markets (reached max tokens per side)
    private readonly MAX_BUY_COUNTS_PER_SIDE: number; // Maximum buy counts per side per market (from config)

    // Prediction scoring system
    private predictionScores: Map<string, {
        market: string;
        slug: string;
        startTime: number;
        endTime: number | null;
        upTokenCost: number; // Total cost of UP token purchases
        downTokenCost: number; // Total cost of DOWN token purchases
        upTokenCount: number; // Number of UP token purchases
        downTokenCount: number; // Number of DOWN token purchases
        totalPredictions: number;
        correctPredictions: number;
        trades: Array<{
            prediction: "up" | "down";
            predictedPrice: number;
            actualPrice: number;
            buyToken: "UP" | "DOWN";
            buyPrice: number;
            buyCost: number;
            timestamp: number;
            wasCorrect: boolean | null; // null = not evaluated yet
        }>;
        // Removed: lastBuyToken tracking - no longer alternating between sides
    }> = new Map();

    private initializationPromise: Promise<void> | null = null;

    // Expiry / HPAC state
    private binanceWs: BinanceWebSocket | null = null;
    private strikePrice: Map<string, number> = new Map();       // market → K at cycle start
    private ewmaVolatility: Map<string, EWMAVolatility> = new Map();
    private hpacBoughtUp: Set<string> = new Set();              // scoreKeys where HPAC fired BUY UP
    private hpacHedged: Set<string> = new Set();                // scoreKeys where HPAC fired HEDGE DOWN
    private hpacLiquidatedCheapUp: Set<string> = new Set();     // cheap-leg FOK sell UP done for scoreKey
    private hpacLiquidatedCheapDown: Set<string> = new Set();   // cheap-leg FOK sell DOWN done for scoreKey
    /** Prior best ask on the single remaining leg (for sudden-drop detection). */
    private hpacRemainingLegPrevAsk: Map<string, number> = new Map();
    private hpacPhaseLocks: Set<string> = new Set();

    constructor(private client: ClobClient, private cfg: SimpleConfig) {
        // Initialize MAX_BUY_COUNTS_PER_SIDE from config
        this.MAX_BUY_COUNTS_PER_SIDE = config.trading.maxBuyCountsPerSide;
        // Initialize WebSocket orderbook (store promise for later awaiting)
        this.initializationPromise = this.initializeWebSocket();
    }

    static async fromEnv(client: ClobClient): Promise<UpDownPredictionBot> {
        const {
            markets, sharesPerSide, tickSize, negRisk,
            priceBuffer, fireAndForget, minBalanceUsdc
        } = config.trading;
        const bot = new UpDownPredictionBot(client, {
            markets, sharesPerSide, tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk, priceBuffer, fireAndForget, minBalanceUsdc,
        });
        await bot.initializationPromise; // Await Polymarket WebSocket initialization

        // Connect Binance WebSocket for underlying spot prices (HPAC phase)
        const binanceWs = new BinanceWebSocket(bot.cfg.markets);
        try {
            await binanceWs.connect();
            bot.binanceWs = binanceWs;

            for (const market of bot.cfg.markets) {
                const symbol = marketToBinanceSymbol(market);
                if (!symbol) continue;

                const ewma = new EWMAVolatility();
                bot.ewmaVolatility.set(market, ewma);

                binanceWs.onPriceUpdate(symbol, (price) => {
                    ewma.update(price, Date.now());
                    // Capture the first tick as strike price for this cycle
                    if (!bot.strikePrice.has(market)) {
                        bot.strikePrice.set(market, price);
                        logger.info(`⚡ Strike price set [${market}]: ${price}`);
                    }
                });
            }
            logger.info("BinanceWebSocket ready – HPAC strategy enabled");
        } catch (e) {
            logger.error(
                `BinanceWebSocket failed (HPAC disabled): ${e instanceof Error ? e.message : String(e)}`
            );
        }

        return bot;
    }

    async initializeWebSocket(): Promise<void> {
        if (!this.useWebSocket) {
            logger.error("WebSocket disabled in config");
            return;
        }
        try {
            this.wsOrderBook = new WebSocketOrderBook("market", [], null);
            await this.wsOrderBook.connect();
            logger.info("WebSocket orderbook initialized");
        } catch (e) {
            logger.error(`Failed to initialize WebSocket: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }
    }

    async start(): Promise<void> {
        if (this.isStopped) {
            logger.error("Bot is stopped, cannot start");
            return;
        }

        if (!this.wsOrderBook) {
            logger.error("Fatal error: WebSocket orderbook not initialized - cannot start bot");
            return;
        }

        logger.info(`Starting UpDownPredictionBot for markets: ${this.cfg.markets.join(", ")}`);
        await this.initializeMarkets();

        // Set up periodic summary generation - only at quarter-hour boundaries (0m, 15m, 30m, 45m)
        // Check every minute to catch quarter-hour boundaries precisely
        setInterval(() => {
            const now = new Date();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();

            // Only generate summaries at quarter-hour boundaries (0m, 15m, 30m, 45m)
            // Check within the first 5 seconds of the minute to avoid duplicates
            if ((minutes === 0 || minutes === 15 || minutes === 30 || minutes === 45) && seconds < 5) {
                this.generateAllPredictionSummaries();
            }
        }, 60 * 1000); // Check every minute

        // Set up periodic market cycle check (every 10 seconds to catch quarter-hour boundaries)
        // This ensures we detect market cycle changes even if there are no price updates
        setInterval(() => {
            this.checkAndHandleMarketCycleChanges();
        }, 10 * 1000); // Check every 10 seconds

        // Periodic HPAC check – fires every 5 s to catch quiet periods in last 30 s
        setInterval(() => {
            void this.checkHPACAllMarkets();
        }, 5 * 1000);
    }

    stop(): void {
        this.isStopped = true;

        // Generate summaries for all active markets before stopping
        logger.info("\n🛑 Generating final prediction summaries...");
        this.generateAllPredictionSummaries();

        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        if (this.binanceWs) {
            this.binanceWs.disconnect();
        }
        logger.info("UpDownPredictionBot stopped");
    }

    private async initializeMarkets(): Promise<void> {
        for (const market of this.cfg.markets) {
            await this.initializeMarket(market);
        }
    }

    private async initializeMarket(market: string): Promise<void> {
        try {
            const slug = slugForCurrent15m(market);
            logger.info(`Initializing market ${market} with slug ${slug}`);
            const tokenIds = await fetchTokenIdsForSlug(slug);
            this.tokenIdsByMarket[market] = { slug, ...tokenIds };
            this.lastSlugByMarket[market] = slug;

            // Seed strike price from Binance if available
            const bSymbol = marketToBinanceSymbol(market);
            if (bSymbol && this.binanceWs) {
                const spotPrice = this.binanceWs.getPrice(bSymbol);
                if (spotPrice && !this.strikePrice.has(market)) {
                    this.strikePrice.set(market, spotPrice);
                    logger.info(`⚡ Strike price initialized [${market}]: ${spotPrice}`);
                }
            }

            // Subscribe to WebSocket prices for these tokens
            if (this.wsOrderBook) {
                this.wsOrderBook.subscribeToTokenIds([tokenIds.upTokenId, tokenIds.downTokenId]);

                // Set token labels for logging
                this.wsOrderBook.setTokenLabel(tokenIds.upTokenId, "Up");
                this.wsOrderBook.setTokenLabel(tokenIds.downTokenId, "Down");

                // Set up price update callbacks - trigger trading logic on price updates
                this.wsOrderBook.onPriceUpdate(tokenIds.upTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug, ...tokenIds }, price, "YES");
                });

                this.wsOrderBook.onPriceUpdate(tokenIds.downTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug, ...tokenIds }, price, "NO");
                });
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            const slug = slugForCurrent15m(market);
            logger.error(`⚠️  Market ${market} not available yet (${slug}): ${errorMsg}. Will retry on next price update.`);
            // Don't throw - allow the bot to continue and retry later
        }
    }

    /**
     * Handle price updates from WebSocket - core trading logic
     * Uses queueMicrotask to prevent blocking WebSocket message loop
     */
    private async handlePriceUpdate(
        market: string,
        tokenIds: { slug: string; upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        price: TokenPrice,
        _leg: "YES" | "NO"
    ): Promise<void> {
        if (this.isStopped) return;
        if (!price.bestAsk || !Number.isFinite(price.bestAsk)) return; // Use bestAsk

        // Defer heavy processing to prevent blocking WebSocket message loop
        queueMicrotask(async () => {
            // Get slug for current 15m cycle (with caching)
            const slug = this.getSlugForMarket(market);
            if (!slug) {
                // Market not initialized yet - initialize it
                void this.initializeMarket(market);
                return;
            }

            // Check if we have cached tokenIds for this market, and if slug matches
            let currentTokenIds = tokenIds;
            const cachedTokenIds = this.tokenIdsByMarket[market];
            if (cachedTokenIds && cachedTokenIds.slug === slug) {
                // Use cached tokenIds if slug matches
                currentTokenIds = cachedTokenIds;
            }
            // If slug doesn't match, we'll handle re-initialization in the market cycle check below

            // Get both prices (we need UP ask price for comparison) - fast cache lookup
            const upPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
            const downPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);

            // Use bestAsk price for limit orders (required for order placement)
            if (!upPrice?.bestAsk || !downPrice?.bestAsk ||
                !Number.isFinite(upPrice.bestAsk) || !Number.isFinite(downPrice.bestAsk)) {
                return; // Wait for both ask prices
            }

            let upAsk = upPrice.bestAsk;
            let downAsk = downPrice.bestAsk;
            let upBid = upPrice.bestBid;
            let downBid = downPrice.bestBid;

            // Debounce: Only process if ask price changed significantly (avoid processing every tick)
            const lastPrice = this.lastProcessedPrice.get(market);
            const minPriceChange = 0.0001; // Minimum change to trigger processing
            if (lastPrice !== undefined && Math.abs(upAsk - lastPrice) < minPriceChange) {
                return; // Price change too small, skip processing
            }
            this.lastProcessedPrice.set(market, upAsk);

            // Get state (fast lookup)
            const state = this.state;
            const k = slug;
            const row = state[k] ?? emptyRow();
            state[k] = row;

            // Check for market cycle change (new 15m period)
            // Initialize lastSlugByMarket if not set (first time)
            if (!this.lastSlugByMarket[market]) {
                this.lastSlugByMarket[market] = slug;
            }

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== slug) {
                logger.info(`🔄 New market cycle detected for ${market}: ${prevSlug} → ${slug}`);
                await this.reinitializeMarketForNewCycle(market, prevSlug, slug);

                // Refresh tokenIds after re-init
                const refreshed = this.tokenIdsByMarket[market];
                if (!refreshed || refreshed.slug !== slug) return;
                currentTokenIds = refreshed;

                const newUpPrice = this.wsOrderBook?.getPrice(currentTokenIds.upTokenId);
                const newDownPrice = this.wsOrderBook?.getPrice(currentTokenIds.downTokenId);
                if (!newUpPrice?.bestAsk || !newDownPrice?.bestAsk ||
                    !Number.isFinite(newUpPrice.bestAsk) || !Number.isFinite(newDownPrice.bestAsk)) {
                    return;
                }
                upAsk = newUpPrice.bestAsk;
                downAsk = newDownPrice.bestAsk;
                upBid = newUpPrice.bestBid;
                downBid = newDownPrice.bestBid;
            }

            // Update metadata (only if we're going to process)
            row.conditionId = currentTokenIds.conditionId;
            row.slug = slug;
            row.market = market;
            row.upIdx = currentTokenIds.upIdx;
            row.downIdx = currentTokenIds.downIdx;
            row.lastUpdatedIso = new Date().toISOString();

            // Phase 2 (HPAC): last 30 seconds – bypass AVMR predictor entirely
            const timeRemaining = this.getTimeRemainingForSlug(slug);
            if (timeRemaining > 0 && timeRemaining <= HPAC_WINDOW_SECONDS) {
                void this.executeHPACPhase(
                    market, slug, upAsk, downAsk, currentTokenIds,
                    `${market}-${slug}`, timeRemaining
                );
                return;
            }

            // Phase 1 passive pair: need both bids for maker-style limit prices
            if (
                upBid === null || downBid === null ||
                !Number.isFinite(upBid) || !Number.isFinite(downBid)
            ) {
                return;
            }

            // Get or create price predictor for this market
            let predictor = this.pricePredictors.get(market);
            if (!predictor) {
                predictor = new AdaptivePricePredictor();
                this.pricePredictors.set(market, predictor);
            }

            // Get prediction for UP token - ONLY returns prediction at pole values, null otherwise
            const prediction = predictor.updateAndPredict(upAsk, Date.now());

            // Only process if we have a prediction (at pole value)
            if (!prediction) {
                // No prediction - price change too small or not at pole, skip
                row.previousUpPrice = upAsk;
                return;
            }

            // Track prediction for accuracy calculation
            const lastPred = this.lastPredictions.get(market);
            if (lastPred) {
                // Calculate if previous prediction was correct
                // Actual direction - use 0.02 threshold (same as noise threshold)
                const priceDiff = upAsk - lastPred.actualPrice;
                // Only consider significant changes (>= 0.02) for direction evaluation
                const actualDirection = Math.abs(priceDiff) >= 0.02
                    ? (priceDiff > 0 ? "up" : "down")
                    : (priceDiff >= 0 ? "up" : "down"); // If change < 0.02, use trend (neutral+up → up)
                const wasCorrect = lastPred.prediction.direction === actualDirection;
                const timeDiff = Date.now() - lastPred.timestamp;

                logger.info(`🔮 Prediction: ${lastPred.prediction.direction.toUpperCase()} (conf: ${lastPred.prediction.confidence.toFixed(2)}) | Actual: ${actualDirection.toUpperCase()} | ${wasCorrect ? "✅ CORRECT" : "❌ WRONG"} | Time: ${timeDiff}ms`);

                // Update prediction score with previous prediction result
                this.updatePredictionScore(market, slug, lastPred.prediction, lastPred.actualPrice, upAsk, wasCorrect);
            }

            // Store current prediction for next evaluation
            this.lastPredictions.set(market, {
                prediction,
                actualPrice: upAsk,
                timestamp: Date.now(),
            });

            // Log prediction details (only at pole values)
            logger.info(`🔮 PREDICT [POLE]: ${prediction.predictedPrice.toFixed(4)} (current: ${upAsk.toFixed(4)}) | Direction: ${prediction.direction.toUpperCase()} | Confidence: ${(prediction.confidence * 100).toFixed(1)}% | Signal: ${prediction.signal} | Momentum: ${prediction.features.momentum.toFixed(3)} | Vol: ${prediction.features.volatility.toFixed(3)} | Trend: ${prediction.features.trend.toFixed(3)}`);

            // Execute prediction-based trading strategy (both legs: GTC limits at bid / complement)
            const phase1TimeRemaining = this.getTimeRemainingForSlug(slug);
            this.executePredictionTrade(
                market, slug, prediction, upAsk, downAsk, upBid, downBid, currentTokenIds,
                phase1TimeRemaining
            );

            // Log accuracy stats periodically (every 25 predictions, and at milestones)
            const stats = predictor.getAccuracyStats();
            if (stats.totalPredictions > 0) {
                // Log every 25 predictions
                if (stats.totalPredictions % 25 === 0) {
                    logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
                }
                // Also log at key milestones (10, 50, 100, 200, etc.)
                else if ([10, 50, 100, 200, 500, 1000].includes(stats.totalPredictions)) {
                    logger.info(`📊 Prediction Accuracy: ${(stats.accuracy * 100).toFixed(1)}% (${stats.correctPredictions}/${stats.totalPredictions})`);
                }
            }

            // Update previous UP ask price (always update for next comparison)
            row.previousUpPrice = upAsk;
            // State will be saved by debounced saveState automatically
        });
    }

    private getSlugForMarket(market: string): string {
        return slugForCurrent15m(market);
    }

    /**
     * Periodically check for market cycle changes and handle them
     * This ensures we detect cycle changes even when there are no price updates
     */
    private async checkAndHandleMarketCycleChanges(): Promise<void> {
        if (this.isStopped) return;

        for (const market of this.cfg.markets) {
            const currentSlug = this.getSlugForMarket(market);
            if (!currentSlug) continue;

            const prevSlug = this.lastSlugByMarket[market];
            if (prevSlug && prevSlug !== currentSlug) {
                logger.info(`🔄 Market cycle change detected via periodic check for ${market}: ${prevSlug} → ${currentSlug}`);

                // Directly re-initialize to avoid duplicate work
                await this.reinitializeMarketForNewCycle(market, prevSlug, currentSlug);
            }
        }
    }

    /**
     * Re-initialize market for a new cycle
     */
    private async reinitializeMarketForNewCycle(market: string, prevSlug: string, newSlug: string): Promise<void> {
        logger.info(`🔄 Re-initializing market ${market} with new slug ${newSlug} (from periodic check)`);

        // Generate prediction score summary for previous market
        this.generatePredictionScoreSummary(prevSlug, market);

        // Reset token counts and paused state for previous market
        const prevScoreKey = `${market}-${prevSlug}`;
        this.tokenCountsByMarket.delete(prevScoreKey);
        this.pausedMarkets.delete(prevScoreKey);

        try {
            const newTokenIds = await fetchTokenIdsForSlug(newSlug);
            this.tokenIdsByMarket[market] = { slug: newSlug, ...newTokenIds };

            // Update WebSocket subscriptions for new tokens
            if (this.wsOrderBook) {
                // Subscribe to new tokens
                this.wsOrderBook.subscribeToTokenIds([newTokenIds.upTokenId, newTokenIds.downTokenId]);

                // Set token labels for logging
                this.wsOrderBook.setTokenLabel(newTokenIds.upTokenId, "Up");
                this.wsOrderBook.setTokenLabel(newTokenIds.downTokenId, "Down");

                // Update callbacks with new token IDs
                this.wsOrderBook.onPriceUpdate(newTokenIds.upTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug: newSlug, ...newTokenIds }, price, "YES");
                });

                this.wsOrderBook.onPriceUpdate(newTokenIds.downTokenId, (tokenId, price) => {
                    void this.handlePriceUpdate(market, { slug: newSlug, ...newTokenIds }, price, "NO");
                });
            }

            this.lastSlugByMarket[market] = newSlug;

            // Update strike price for the new cycle
            const bSymbol = marketToBinanceSymbol(market);
            if (bSymbol && this.binanceWs) {
                const spotPrice = this.binanceWs.getPrice(bSymbol);
                if (spotPrice) {
                    this.strikePrice.set(market, spotPrice);
                    logger.info(`⚡ New strike price [${market}] cycle ${newSlug}: ${spotPrice}`);
                }
            }

            // Clear HPAC one-shot flags from the previous cycle
            const prevHpacKey = `${market}-${prevSlug}`;
            this.hpacBoughtUp.delete(prevHpacKey);
            this.hpacHedged.delete(prevHpacKey);
            this.hpacLiquidatedCheapUp.delete(prevHpacKey);
            this.hpacLiquidatedCheapDown.delete(prevHpacKey);
            this.hpacRemainingLegPrevAsk.delete(prevHpacKey);

            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }

            logger.info(`✅ Market ${market} re-initialized with new token IDs for cycle ${newSlug}`);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    /**
     * GTC limit buy at the given price (caller sets passive vs aggressive).
     * Phase 1 uses best bid; HPAC passes ask + spread when urgency matters.
     */
    private async buyShares(
        leg: "YES" | "NO",
        tokenID: string,
        limitPrice: number,
        size: number,
    ): Promise<boolean> {
        const limitOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size,
        };

        const orderAmount = limitPrice * size;

        logger.info(`BUY: ${leg} ~${size} shares @ GTC limit ${limitPrice.toFixed(4)} (${orderAmount.toFixed(2)} USDC)`);

        try {
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC
            );

            const orderID = response?.orderID;
            if (!orderID) {
                logger.error(`BUY failed for ${leg} - no orderID returned`);
                return false;
            }
            logger.info(`✅ Limit BUY placed: ${leg} orderID ${orderID.substring(0, 10)}... @ ${limitPrice.toFixed(4)}`);
            return true;
        } catch (e) {
            logger.error(`BUY failed for ${leg}: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Phase 1: place **both** legs as GTC limit orders (maker-friendly, lower taker fees).
     * First leg only if that side's **best ask > PHASE1_FIRST_LEG_MIN_ASK** (0.5).
     * In **(30s, 60s]** remaining, if signal ask **> PHASE1_LEG2_SUPPRESS_MIN_ASK** (0.7), leg2 is skipped.
     * First leg at **best bid** on the signal side (tick-floored); second at `0.98 - firstLegLimit`.
     * Posted together via `Promise.all` when leg2 is used.
     */
    private executePredictionTrade(
        market: string,
        slug: string,
        prediction: PricePrediction,
        upAsk: number,
        downAsk: number,
        upBid: number,
        downBid: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        timeRemainingSeconds: number,
    ): void {
        // Initialize prediction score for this market/slug if not exists
        const scoreKey = `${market}-${slug}`;
        if (!this.predictionScores.has(scoreKey)) {
            this.predictionScores.set(scoreKey, {
                market,
                slug,
                startTime: Date.now(),
                endTime: null,
                upTokenCost: 0,
                downTokenCost: 0,
                upTokenCount: 0,
                downTokenCount: 0,
                totalPredictions: 0,
                correctPredictions: 0,
                trades: [],
            });
        }

        const score = this.predictionScores.get(scoreKey)!;

        // CRITICAL: Only trade on high-confidence predictions to improve success rate
        // Wrong predictions have avg confidence ~48%, correct ones ~65%
        // Filter out low-confidence predictions to reduce losses
        // Reduced threshold to 50% to allow more trades with limit order second side strategy
        const minConfidenceForTrade = 0.50; // Reduced from 60% to 50% to allow more trades

        // Check confidence and signal before trading
        if (prediction.confidence < minConfidenceForTrade) {
            return; // Skip silently to reduce log noise
        }

        // Skip if signal is HOLD (indicates uncertainty)
        if (prediction.signal === "HOLD") {
            return; // Skip silently to reduce log noise
        }

        // Only increment totalPredictions when we actually make a trade
        score.totalPredictions++;

        // Determine which token to buy based on prediction direction only
        // Always follow prediction direction - no alternating logic
        let buyToken: "UP" | "DOWN" | null = null;
        let buyPrice = 0;
        let tokenId = "";

        if (prediction.direction === "up") {
            buyToken = "UP";
            buyPrice = floorPriceToTick(upBid, String(this.cfg.tickSize));
            tokenId = tokenIds.upTokenId;
        } else if (prediction.direction === "down") {
            buyToken = "DOWN";
            buyPrice = floorPriceToTick(downBid, String(this.cfg.tickSize));
            tokenId = tokenIds.downTokenId;
        }

        if (!buyToken) {
            score.totalPredictions--;
            return;
        }

        if (buyPrice <= 0 || buyPrice >= 1) {
            logger.error(`⚠️  Invalid passive first-leg limit ${buyPrice.toFixed(4)} — skip`);
            score.totalPredictions--;
            return;
        }

        const signalAsk = buyToken === "UP" ? upAsk : downAsk;
        if (signalAsk <= PHASE1_FIRST_LEG_MIN_ASK) {
            logger.info(
                `⏭️  Phase1 skip first leg: ${buyToken} ask ${signalAsk.toFixed(4)} ≤ ${PHASE1_FIRST_LEG_MIN_ASK} ` +
                `(need ask > ${PHASE1_FIRST_LEG_MIN_ASK})`
            );
            score.totalPredictions--;
            return;
        }

        const suppressLeg2 =
            timeRemainingSeconds > HPAC_WINDOW_SECONDS &&
            timeRemainingSeconds <= PHASE1_LEG2_SUPPRESS_WINDOW_SEC &&
            signalAsk > PHASE1_LEG2_SUPPRESS_MIN_ASK;

        // Check if market is paused (reached 50 UP + 50 DOWN)
        if (this.pausedMarkets.has(scoreKey)) {
            score.totalPredictions--;
            return;
        }

        // Get or initialize token counts for this market
        let tokenCounts = this.tokenCountsByMarket.get(scoreKey);
        if (!tokenCounts) {
            tokenCounts = { upTokenCount: 0, downTokenCount: 0 };
            this.tokenCountsByMarket.set(scoreKey, tokenCounts);
        }

        // Check if we've reached the limit for this side BEFORE placing order
        // Use > instead of >= to prevent exceeding limit (if count is already at limit, don't place order)
        if (buyToken === "UP" && tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            logger.info(`⛔ LIMIT REACHED: UP count is ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} - skipping trade`);
            score.totalPredictions--;
            return;
        }
        if (buyToken === "DOWN" && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            logger.info(`⛔ LIMIT REACHED: DOWN count is ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} - skipping trade`);
            score.totalPredictions--;
            return;
        }

        // Increment count for the side we're buying ONLY (before calling buySharesWithRetry to prevent race conditions)
        if (buyToken === "UP") {
            tokenCounts.upTokenCount++;
            score.upTokenCount++;
        } else {
            tokenCounts.downTokenCount++;
            score.downTokenCount++;
        }

        // Execute the buy
        const buyCost = buyPrice * this.cfg.sharesPerSide;
        logger.info(
            `🎯 PHASE1 ${suppressLeg2 ? "leg1 only" : "passive pair"}: ${buyToken} leg1 GTC @ bid ${buyPrice.toFixed(4)} ` +
            `(ask ${signalAsk.toFixed(4)}) T≈${timeRemainingSeconds}s` +
            (suppressLeg2
                ? ` | leg2 suppressed (>${PHASE1_LEG2_SUPPRESS_MIN_ASK} in ${HPAC_WINDOW_SECONDS + 1}–${PHASE1_LEG2_SUPPRESS_WINDOW_SEC}s window)`
                : "") +
            ` | ${buyCost.toFixed(2)} USDC est | UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, ` +
            `DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`
        );

        if (suppressLeg2) {
            void this.buyShares(
                buyToken === "UP" ? "YES" : "NO",
                tokenId,
                buyPrice,
                this.cfg.sharesPerSide,
            ).catch((e) => {
                logger.error(`Phase1 leg1-only post failed: ${e instanceof Error ? e.message : String(e)}`);
            });
        } else {
            const secondLimit = 0.98 - buyPrice;
            if (secondLimit <= 0 || secondLimit >= 1) {
                logger.error(`⚠️  Invalid second-leg limit ${secondLimit.toFixed(4)} — skip pair`);
                if (buyToken === "UP") {
                    tokenCounts.upTokenCount--;
                    score.upTokenCount--;
                } else {
                    tokenCounts.downTokenCount--;
                    score.downTokenCount--;
                }
                score.totalPredictions--;
                return;
            }

            void Promise.all([
                this.buyShares(
                    buyToken === "UP" ? "YES" : "NO",
                    tokenId,
                    buyPrice,
                    this.cfg.sharesPerSide,
                ),
                this.placeSecondSideLimitOrder(
                    buyToken,
                    buyPrice,
                    tokenIds,
                    market,
                    slug,
                    scoreKey,
                    tokenCounts
                ),
            ]).catch((e) => {
                logger.error(`Phase1 pair post failed: ${e instanceof Error ? e.message : String(e)}`);
            });
        }

        // Track the trade cost for the side we actually bought only
        if (buyToken === "UP") {
            score.upTokenCost += buyCost;
        } else {
            score.downTokenCost += buyCost;
        }

        score.trades.push({
            prediction: prediction.direction,
            predictedPrice: prediction.predictedPrice,
            actualPrice: buyPrice,
            buyToken,
            buyPrice,
            buyCost,
            timestamp: Date.now(),
            wasCorrect: null, // Will be evaluated at next prediction
        });

        // Check if we've reached the limit (max UP + max DOWN)
        if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            this.pausedMarkets.add(scoreKey);
            logger.info(`⏸️  Market ${scoreKey} PAUSED: Reached limit (UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
        }
    }

    /**
     * Second leg GTC limit at `0.98 - firstSideLimit` (firstSide = passive bid used for leg 1).
     */
    private async placeSecondSideLimitOrder(
        firstSide: "UP" | "DOWN",
        firstSidePrice: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        market: string,
        slug: string,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        // Determine opposite side
        const oppositeSide = firstSide === "UP" ? "DOWN" : "UP";
        const oppositeTokenId = firstSide === "UP" ? tokenIds.downTokenId : tokenIds.upTokenId;

        // CRITICAL: Check if market is paused FIRST
        if (this.pausedMarkets.has(scoreKey)) {
            return; // Market is paused, don't place limit orders
        }

        // Calculate limit price: (0.99 - firstSidePrice)
        const limitPrice = 0.98 - firstSidePrice;

        // Ensure limit price is valid (between 0 and 1)
        if (limitPrice <= 0 || limitPrice >= 1) {
            logger.error(`⚠️  Invalid limit price calculated: ${limitPrice.toFixed(4)} (from first side price ${firstSidePrice.toFixed(4)})`);
            return;
        }

        const limitOrder: UserOrder = {
            tokenID: oppositeTokenId,
            side: Side.BUY,
            price: limitPrice,
            size: this.cfg.sharesPerSide,
        };

        try {
            // Place order IMMEDIATELY (await to ensure it's placed within 50ms of first order)
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC // Good-Till-Cancel for limit orders
            );
            
            const orderID = response?.orderID;
            // Log second-side limit order placement clearly with limit info
            const limitCost = limitPrice * this.cfg.sharesPerSide;
            if (orderID) {
                logger.info(`📋 SECOND-SIDE Limit Order: ${oppositeSide} @ ${limitPrice.toFixed(4)} (${limitCost.toFixed(2)} USDC) | First-Side: ${firstSide} @ ${firstSidePrice.toFixed(4)} | Current: UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} | Limit: ${this.MAX_BUY_COUNTS_PER_SIDE} per side | OrderID: ${orderID.substring(0, 10)}...`);
                // Track second-side limit so fills update score (downTokenCost/upTokenCost and counts)
                const leg = oppositeSide === "UP" ? "YES" : "NO";
                this.trackLimitOrderAsync(
                    orderID,
                    leg,
                    oppositeTokenId,
                    tokenIds.conditionId,
                    this.cfg.sharesPerSide,
                    limitPrice,
                    market,
                    slug,
                    tokenIds.upIdx,
                    tokenIds.downIdx,
                    scoreKey,
                    tokenCounts
                ).catch(() => { /* fire-and-forget */ });
            } else {
                logger.error(`⚠️  Second-side limit order placement returned no orderID`);
            }
        } catch (e) {
            logger.error(`❌ Failed to place limit order for ${oppositeSide} token: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Track limit order asynchronously and update token counts when filled
     */
    private async trackLimitOrderAsync(
        orderID: string,
        leg: "YES" | "NO",
        tokenID: string,
        conditionId: string,
        estimatedShares: number,
        limitPrice: number,
        market: string,
        slug: string,
        upIdx: number,
        downIdx: number,
        scoreKey: string,
        tokenCounts: { upTokenCount: number; downTokenCount: number }
    ): Promise<void> {
        try {
            // Optimized polling with exponential backoff
            let attempts = 0;
            const maxAttempts = 30; // Reduced from 60 to 30 (30 seconds max)
            let pollInterval = 500; // Start with 500ms, increase gradually
            const maxInterval = 3000; // Max 3 seconds between checks

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                attempts++;

                try {
                    const order = await this.client.getOrder(orderID);

                    if (order && order.status === "FILLED") {
                        // CRITICAL: Check limit BEFORE incrementing to prevent exceeding limit
                        // This prevents race conditions where multiple limit orders fill simultaneously
                        const wouldExceedLimit = (leg === "YES" && tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) ||
                            (leg === "NO" && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE);

                        if (wouldExceedLimit) {
                            logger.error(`⚠️  Limit order ${orderID} filled but would exceed limit - cancelling count update (${leg}: ${leg === "YES" ? tokenCounts.upTokenCount : tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE})`);
                            return; // Don't increment count if it would exceed limit
                        }

                        // Order filled - update token counts
                        const fillCost = limitPrice * estimatedShares;

                        if (leg === "YES") {
                            tokenCounts.upTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.upTokenCost += fillCost;
                                score.upTokenCount++;
                            }
                        } else {
                            tokenCounts.downTokenCount++;
                            const score = this.predictionScores.get(scoreKey);
                            if (score) {
                                score.downTokenCost += fillCost;
                                score.downTokenCount++;
                            }
                        }

                        logger.info(`✅ Limit order filled: ${leg} @ ${limitPrice.toFixed(4)} | UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);

                        if (tokenCounts.upTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
                            this.pausedMarkets.add(scoreKey);
                            logger.info(`⏸️  Market ${scoreKey} PAUSED after limit order fill: UP: ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN: ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}`);
                        }

                        return; // Order filled, stop tracking
                    } else if (order && (order.status === "CANCELLED" || order.status === "REJECTED")) {
                        return; // Order cancelled/rejected, stop tracking silently
                    }
                } catch (e) {
                    // Order might not be found yet, continue polling with backoff
                    // Increase interval gradually (exponential backoff)
                    if (pollInterval < maxInterval) {
                        pollInterval = Math.min(pollInterval * 1.5, maxInterval);
                    }
                    // Silent polling - no logging to reduce noise
                }
            }

            // Silent timeout - limit orders may fill later, no need to log
        } catch (e) {
            logger.error(`❌ Error tracking limit order ${orderID}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Update prediction score with previous prediction result
     * Only evaluates trades that were actually made (not skipped)
     */
    private updatePredictionScore(
        market: string,
        slug: string,
        prediction: PricePrediction,
        previousPrice: number,
        currentPrice: number,
        wasCorrect: boolean
    ): void {
        const scoreKey = `${market}-${slug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) return;

        // Find the last trade that hasn't been evaluated yet
        const lastTrade = score.trades[score.trades.length - 1];
        if (lastTrade && lastTrade.wasCorrect === null) {
            lastTrade.wasCorrect = wasCorrect;
            if (wasCorrect) {
                score.correctPredictions++;
            }
            // Note: totalPredictions already incremented when trade was made
            // correctPredictions is updated here based on actual result
        }
    }

    /**
     * Generate prediction score summary when market cycle ends
     */
    private generatePredictionScoreSummary(prevSlug: string, market: string): void {
        const scoreKey = `${market}-${prevSlug}`;
        const score = this.predictionScores.get(scoreKey);
        if (!score) {
            logger.error(`⚠️  No prediction score found for ${scoreKey} - cannot generate summary`);
            return;
        }

        // Don't generate summary if already generated
        if (score.endTime !== null) {
            return;
        }

        score.endTime = Date.now();
        const duration = (score.endTime - score.startTime) / 1000; // seconds

        const successRate = score.totalPredictions > 0
            ? (score.correctPredictions / score.totalPredictions) * 100
            : 0;

        const totalCost = score.upTokenCost + score.downTokenCost;

        logger.info(`\n${"=".repeat(80)}`);
        logger.info(`📊 PREDICTION SCORE SUMMARY - Market: ${market} | Slug: ${prevSlug}`);
        logger.info(`${"=".repeat(80)}`);
        logger.info(`⏱️  Duration: ${(duration / 60).toFixed(2)} minutes`);
        logger.info(`📈 Total Predictions: ${score.totalPredictions}`);
        logger.info(`✅ Correct Predictions: ${score.correctPredictions}`);
        logger.info(`❌ Wrong Predictions: ${score.totalPredictions - score.correctPredictions}`);
        logger.info(`🎯 Success Rate: ${successRate.toFixed(2)}%`);
        logger.info(`\n💰 TOKEN PURCHASES:`);
        logger.info(`   UP Token:`);
        logger.info(`      - Buy Count: ${score.upTokenCount}`);
        logger.info(`      - Total Cost: ${score.upTokenCost.toFixed(2)} USDC`);
        logger.info(`   DOWN Token:`);
        logger.info(`      - Buy Count: ${score.downTokenCount}`);
        logger.info(`      - Total Cost: ${score.downTokenCost.toFixed(2)} USDC`);
        logger.info(`\n💵 TOTAL COST: ${totalCost.toFixed(2)} USDC`);
        logger.info(`${"=".repeat(80)}\n`);

        // Remove from active tracking (summary generated)
        this.predictionScores.delete(scoreKey);
    }

    private getInventoryCounts(scoreKey: string): { upN: number; downN: number } {
        const score = this.predictionScores.get(scoreKey);
        const tc = this.tokenCountsByMarket.get(scoreKey);
        return {
            upN: score?.upTokenCount ?? tc?.upTokenCount ?? 0,
            downN: score?.downTokenCount ?? tc?.downTokenCount ?? 0,
        };
    }

    private applyFullExitUp(scoreKey: string): void {
        const score = this.predictionScores.get(scoreKey);
        if (score) {
            score.upTokenCount = 0;
            score.upTokenCost = 0;
        }
        const tc = this.tokenCountsByMarket.get(scoreKey);
        if (tc) tc.upTokenCount = 0;
    }

    private applyFullExitDown(scoreKey: string): void {
        const score = this.predictionScores.get(scoreKey);
        if (score) {
            score.downTokenCount = 0;
            score.downTokenCost = 0;
        }
        const tc = this.tokenCountsByMarket.get(scoreKey);
        if (tc) tc.downTokenCount = 0;
    }

    /** Aggressive exit: FOK market sell (amount = conditional shares). */
    private async sellAllSharesMarketFOK(
        tokenID: string,
        totalShares: number,
        label: string,
    ): Promise<boolean> {
        if (totalShares <= 0 || !Number.isFinite(totalShares)) return false;
        try {
            const res = (await this.client.createAndPostMarketOrder(
                { tokenID, side: Side.SELL, amount: totalShares },
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.FOK
            )) as { success?: boolean; errorMsg?: string };
            if (res && res.success === false) {
                logger.error(`FOK sell ${label}: ${res.errorMsg ?? "rejected"}`);
                return false;
            }
            logger.info(`✅ FOK sell ${label}: ${totalShares} shares`);
            return true;
        } catch (e) {
            logger.error(`FOK sell ${label}: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Derive seconds remaining until settlement from the slug timestamp.
     * Slug format: `{market}-updown-15m-{unixStartSeconds}`
     */
    private getTimeRemainingForSlug(slug: string): number {
        const match = slug.match(/-updown-15m-(\d+)$/);
        if (!match) return Infinity;
        const startTs = parseInt(match[1], 10);
        return (startTs + MARKET_DURATION_SECONDS) - Math.floor(Date.now() / 1000);
    }

    /**
     * Phase 2 – High-Probability Auto-Compounding (HPAC).
     *
     * Triggered in the last 30 s of each 15-minute window.
     * Uses a simplified Black-Scholes d2 model to estimate P(UP) from live
     * Binance spot price, the cycle's strike price, and EWMA volatility.
     *
     * Decision rules (last 30s — no new first legs; second legs only):
     *   1. Box locked in Phase 1 (avgUP + avgDOWN < 1)  → hold, do nothing.
     *   2. Both legs held (not locked): if either leg’s ask ≤ EXPIRY_CHEAP_LEG_ASK_THRESHOLD,
     *      FOK market-sell the entire position on that leg (see expiryStrategy.ts).
     *   3. Single leg left: if best ask drops suddenly vs prior tick, compare BS outcome prob
     *      to EXPIRY_REMAINING_HOLD_MIN_BS_PROB → SELL (FOK) or HOLD.
     *   4. edge = P(UP) - mktPriceUP - FEES_BUFFER > 0.05 → market-buy UP **only if**
     *      DOWN > UP (second leg only).
     *   5. P(UP) < 0.10 AND UP > DOWN → hedge with DOWN (once).
     *   Resting GTC second-side orders from Phase 1 may still fill on the exchange.
     */
    private async executeHPACPhase(
        market: string,
        slug: string,
        upAsk: number,
        downAsk: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        scoreKey: string,
        timeRemaining: number,
    ): Promise<void> {
        if (this.hpacPhaseLocks.has(scoreKey)) return;
        this.hpacPhaseLocks.add(scoreKey);
        try {
            let { upN, downN } = this.getInventoryCounts(scoreKey);
            const score = this.predictionScores.get(scoreKey);

            // Rule 1: profitable box already built in Phase 1 → hold to settlement
            if (score && score.upTokenCount > 0 && score.downTokenCount > 0) {
                const avgUpCost = score.upTokenCost / score.upTokenCount;
                const avgDownCost = score.downTokenCost / score.downTokenCount;
                if (avgUpCost + avgDownCost < 1.0) {
                    logger.info(
                        `🔒 HPAC [${market}] T=${timeRemaining.toFixed(1)}s: box locked ` +
                        `(UP ${avgUpCost.toFixed(4)} + DOWN ${avgDownCost.toFixed(4)} = ` +
                        `${(avgUpCost + avgDownCost).toFixed(4)}) – holding`
                    );
                    return;
                }
            }

            // Cheap-leg dump: both legs, not locked (Rule 1 returned only when locked)
            if (upN > 0 && downN > 0) {
                this.hpacRemainingLegPrevAsk.delete(scoreKey);
                const per = this.cfg.sharesPerSide;

                if (upAsk <= EXPIRY_CHEAP_LEG_ASK_THRESHOLD && !this.hpacLiquidatedCheapUp.has(scoreKey)) {
                    const shares = upN * per;
                    const ok = await this.sellAllSharesMarketFOK(tokenIds.upTokenId, shares, `${market} UP cheap`);
                    if (ok) {
                        this.applyFullExitUp(scoreKey);
                        this.hpacLiquidatedCheapUp.add(scoreKey);
                        this.hpacRemainingLegPrevAsk.delete(scoreKey);
                    }
                }

                ({ upN, downN } = this.getInventoryCounts(scoreKey));

                if (downAsk <= EXPIRY_CHEAP_LEG_ASK_THRESHOLD && !this.hpacLiquidatedCheapDown.has(scoreKey)) {
                    const shares = downN * per;
                    const ok = await this.sellAllSharesMarketFOK(tokenIds.downTokenId, shares, `${market} DOWN cheap`);
                    if (ok) {
                        this.applyFullExitDown(scoreKey);
                        this.hpacLiquidatedCheapDown.add(scoreKey);
                        this.hpacRemainingLegPrevAsk.delete(scoreKey);
                    }
                }

                ({ upN, downN } = this.getInventoryCounts(scoreKey));
            }

            const binanceSymbol = marketToBinanceSymbol(market);
            const S = binanceSymbol ? this.binanceWs?.getPrice(binanceSymbol) : undefined;
            const K = this.strikePrice.get(market);
            const ewma = this.ewmaVolatility.get(market);
            const bsOk = !!(binanceSymbol && S && K && ewma);

            let pUp = 0.5;
            let sigma = 0;
            let edge = 0;
            if (bsOk) {
                sigma = ewma!.getAnnualizedVolatility();
                pUp = computeUpProbability(S!, K!, timeRemaining, sigma);
                edge = pUp - upAsk - FEES_BUFFER;
                logger.info(
                    `📐 HPAC [${market}] T=${timeRemaining.toFixed(1)}s ` +
                    `S=${S!.toFixed(4)} K=${K!.toFixed(4)} σ=${sigma.toFixed(4)} ` +
                    `P(UP)=${pUp.toFixed(4)} mkt=${upAsk.toFixed(4)} edge=${edge.toFixed(4)}`
                );
            } else {
                logger.error(
                    `⚠️  HPAC [${market}]: missing BS inputs (cheap-leg exits still allowed) ` +
                    `sym=${binanceSymbol ?? "?"} S=${S ?? "?"} K=${K ?? "?"} ewma=${!!ewma}`
                );
            }

            ({ upN, downN } = this.getInventoryCounts(scoreKey));

            // Remaining leg: sudden ask drop + BS threshold → FOK sell or hold
            if (bsOk && upN > 0 && downN === 0) {
                const prev = this.hpacRemainingLegPrevAsk.get(scoreKey);
                const sudden = detectSuddenAskDrop(upAsk, prev);
                this.hpacRemainingLegPrevAsk.set(scoreKey, upAsk);
                const decision = remainingLegBlackScholesSellOrHold("UP", pUp, sudden);
                if (decision === "SELL") {
                    const shares = upN * this.cfg.sharesPerSide;
                    const ok = await this.sellAllSharesMarketFOK(tokenIds.upTokenId, shares, `${market} UP BS exit`);
                    if (ok) this.applyFullExitUp(scoreKey);
                } else if (sudden) {
                    logger.info(
                        `📌 HPAC [${market}] hold UP: sudden drop but P(UP)=${pUp.toFixed(4)} ≥ ` +
                        `${EXPIRY_REMAINING_HOLD_MIN_BS_PROB} (min-hold)`
                    );
                }
                ({ upN, downN } = this.getInventoryCounts(scoreKey));
            } else if (bsOk && downN > 0 && upN === 0) {
                const prev = this.hpacRemainingLegPrevAsk.get(scoreKey);
                const sudden = detectSuddenAskDrop(downAsk, prev);
                this.hpacRemainingLegPrevAsk.set(scoreKey, downAsk);
                const decision = remainingLegBlackScholesSellOrHold("DOWN", pUp, sudden);
                if (decision === "SELL") {
                    const shares = downN * this.cfg.sharesPerSide;
                    const ok = await this.sellAllSharesMarketFOK(tokenIds.downTokenId, shares, `${market} DOWN BS exit`);
                    if (ok) this.applyFullExitDown(scoreKey);
                } else if (sudden) {
                    const pDn = 1 - pUp;
                    logger.info(
                        `📌 HPAC [${market}] hold DOWN: sudden drop but P(DOWN)=${pDn.toFixed(4)} ≥ ` +
                        `${EXPIRY_REMAINING_HOLD_MIN_BS_PROB} (min-hold)`
                    );
                }
                ({ upN, downN } = this.getInventoryCounts(scoreKey));
            } else if (upN > 0 && downN > 0) {
                this.hpacRemainingLegPrevAsk.delete(scoreKey);
            }

            // Rule 4: edge buy UP only as second leg
            if (bsOk && edge > HPAC_EDGE_THRESHOLD && !this.hpacBoughtUp.has(scoreKey)) {
                if (downN > upN) {
                    this.hpacBoughtUp.add(scoreKey);
                    logger.info(
                        `⚡ HPAC BUY UP [${market}] (second leg): edge ${edge.toFixed(4)} > ${HPAC_EDGE_THRESHOLD} ` +
                        `| UP ${upN} / DOWN ${downN}`
                    );
                    await this.buyShares("YES", tokenIds.upTokenId, upAsk + 0.01, this.cfg.sharesPerSide);
                    return;
                }
                logger.info(
                    `⏭️  HPAC [${market}]: skip edge BUY UP — first leg of new pair disallowed in last ${HPAC_WINDOW_SECONDS}s ` +
                    `(UP ${upN}, DOWN ${downN}, edge ${edge.toFixed(4)})`
                );
            }

            // Rule 5: hedge / second-leg DOWN only when net long UP
            if (bsOk && pUp < 0.10 && upN > downN && !this.hpacHedged.has(scoreKey)) {
                this.hpacHedged.add(scoreKey);
                logger.info(
                    `🛡️  HPAC HEDGE DOWN [${market}]: P(UP)=${pUp.toFixed(4)} < 0.10 ` +
                    `| UP ${upN} > DOWN ${downN}`
                );
                await this.buyShares("NO", tokenIds.downTokenId, downAsk + 0.01, this.cfg.sharesPerSide);
            }
        } finally {
            this.hpacPhaseLocks.delete(scoreKey);
        }
    }

    /**
     * Periodic scan – ensures HPAC fires even during quiet (no-price-update) periods
     * in the final 30 seconds.
     */
    private async checkHPACAllMarkets(): Promise<void> {
        if (this.isStopped) return;

        for (const market of this.cfg.markets) {
            const slug = this.getSlugForMarket(market);
            if (!slug) continue;

            const timeRemaining = this.getTimeRemainingForSlug(slug);
            if (timeRemaining <= 0 || timeRemaining > HPAC_WINDOW_SECONDS) continue;

            const tokenIds = this.tokenIdsByMarket[market];
            if (!tokenIds || tokenIds.slug !== slug) continue;

            const upPrice = this.wsOrderBook?.getPrice(tokenIds.upTokenId);
            const downPrice = this.wsOrderBook?.getPrice(tokenIds.downTokenId);
            if (!upPrice?.bestAsk || !downPrice?.bestAsk) continue;

            await this.executeHPACPhase(
                market, slug, upPrice.bestAsk, downPrice.bestAsk,
                tokenIds, `${market}-${slug}`, timeRemaining
            );
        }
    }

    /**
     * Generate prediction score summaries for all active markets
     * Called on shutdown or periodically
     */
    private generateAllPredictionSummaries(): void {
        const now = new Date();
        const minutes = now.getMinutes();

        // Only generate summaries at quarter-hour boundaries (0m, 15m, 30m, 45m)
        if (minutes !== 0 && minutes !== 15 && minutes !== 30 && minutes !== 45) {
            return; // Not at a quarter-hour boundary, skip
        }

        // Generate summary for each active market/slug
        const scores = Array.from(this.predictionScores.entries());
        for (const [scoreKey, score] of scores) {
            if (score.endTime === null && score.totalPredictions > 0) {
                // Market is still active and has predictions, generate summary now
                // Use stored market and slug from score object
                this.generatePredictionScoreSummary(score.slug, score.market);
            }
        }
    }

}
