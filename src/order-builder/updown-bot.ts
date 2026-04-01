import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrder } from "@polymarket/clob-client";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { logger, colorRegime, colorStrategy, colorSignal } from "../utils/logger";
import { config } from "../config";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { AdaptivePricePredictor, PricePrediction, MarketSnapshot } from "../utils/pricePredictor";
import { lowSignalBlocksTrade, formatLowSignalBlockReason, formatChopMicroMetrics } from "../utils/low-signal-gate";
import {
    executionRiskDanger,
    executionRiskSmallTradeAllowed,
    capExecutionRiskSmallTradeSize,
    formatExecutionRiskBlockReason,
} from "../utils/execution-risk-gate";
import {
    expiryCloseWindow,
    expiryCloseAllowsTrade,
    capExpiryCloseSize,
    formatExpiryCloseBlockReason,
} from "../utils/expiry-close-gate";
import {
    evaluateFlowDominanceEntry,
    computeFlowDominancePositionSize,
    shouldExitFlowDominancePosition,
    shouldForceExitByHoldDuration,
    type FlowDominanceEntrySnapshot,
} from "./strategies/flow-dominance";
import {
    evaluateMomentumEntry,
    computeMomentumPositionSize,
    shouldExitMomentumPosition,
    shouldForceExitMomentumByHoldDuration,
    type MomentumEntrySnapshot,
} from "./strategies/momentum";
import {
    evaluateBreakoutEntry,
    computeBreakoutPositionSize,
    shouldExitBreakoutPosition,
    shouldForceExitBreakoutByHoldDuration,
    hadCompressionInRecentWindow,
    COMPRESSION_LOOKBACK_EVENTS,
    isCompression,
    type BreakoutEntrySnapshot,
    type BreakoutArmPending,
} from "./strategies/breakout";
import {
    evaluateReversalEntry,
    computeReversalPositionSize,
    shouldExitReversalPosition,
    shouldForceExitReversalByHoldDuration,
    type ReversalEntrySnapshot,
    type ReversalArmPending,
} from "./strategies/reversal";

type RegimeStrategyExec =
    | { kind: "flow_dominance"; entrySnapshot: FlowDominanceEntrySnapshot; processTick: number }
    | { kind: "momentum"; entrySnapshot: MomentumEntrySnapshot; processTick: number }
    | { kind: "breakout"; entrySnapshot: BreakoutEntrySnapshot; processTick: number }
    | { kind: "reversal"; entrySnapshot: ReversalEntrySnapshot; processTick: number };

type RuntimeRegimeState = {
    confirmed: PricePrediction["regime"] | null;
    candidate: PricePrediction["regime"] | null;
    candidateCount: number;
    cooldownUntilTick: number;
    chopSeenTick: number | null;
};
// Helper functions for market slug and token IDs
/** Returns the ms epoch of the current 5-minute slot's start boundary. */
function current5mSlotStartMs(): number {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMilliseconds(0);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
    return d.getTime();
}

function slugForCurrent5m(market: string): string {
    const startMs = current5mSlotStartMs();
    const timestamp = Math.floor(startMs / 1000);
    return `${market}-updown-5m-${timestamp}`;
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
    market: "btc";
    sharesPerSide: number; // shares required per side (e.g., 5)
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    priceBuffer: number; // Price buffer in cents for order execution (e.g., 0.03 = 3 cents)
    fireAndForget: boolean; // Don't wait for order confirmation (fire-and-forget)
    // Risk management
    minBalanceUsdc: number; // Minimum balance before stopping
};

const STATE_FILE = "src/data/bot-state.json";

function statePath(): string {
    return path.resolve(process.cwd(), STATE_FILE);
}

function emptyRow(): SimpleStateRow {
    return {
        previousUpPrice: null,
        lastUpdatedIso: new Date().toISOString(),
    };
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

    /** Increments on each call to updateAndPredictWithSnapshot (per market). Used for flow_dominance hold window. */
    private marketProcessTick: Map<string, number> = new Map();
    /** Active flow_dominance position: no pyramid until exit or max hold events. */
    private flowDominanceHold: Map<string, { entryTick: number; snapshot: FlowDominanceEntrySnapshot }> = new Map();
    /** Active momentum position: no pyramid until exit or max hold events (shorter window than flow). */
    private momentumHold: Map<string, { entryTick: number; snapshot: MomentumEntrySnapshot }> = new Map();
    /** Recent UP token asks for pullback filter (per market). */
    private upAskHistory: Map<string, number[]> = new Map();
    /** Recent compression flags for breakout (per market). */
    private compressionHistory: Map<string, boolean[]> = new Map();
    private breakoutHold: Map<string, { entryTick: number; snapshot: BreakoutEntrySnapshot }> = new Map();
    /** Armed first spike; entry only after confirmation tick. */
    private breakoutArmPending: Map<string, BreakoutArmPending> = new Map();

    private reversalHold: Map<string, { entryTick: number; snapshot: ReversalEntrySnapshot }> = new Map();
    private reversalArmPending: Map<string, ReversalArmPending> = new Map();
    /** Per-market return1 series for reversal trend sum (microstructure). */
    private return1History: Map<string, number[]> = new Map();
    /** Prior tick |z| for exhaustion (ofi + microprice edge). */
    private reversalPrevExhaustionZ: Map<string, { absOfiZ: number; absMicroZ: number }> = new Map();
    /** Regime transition controller state (per market). */
    private regimeStateByMarket: Map<string, RuntimeRegimeState> = new Map();

    private static readonly REGIME_CONFIRM_TICKS = 2;
    private static readonly CHOP_FORCE_EXIT_GRACE_TICKS = 1;
    private static readonly COOLDOWN_TICKS_AFTER_DERISK = 4;

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

    constructor(private client: ClobClient, private cfg: SimpleConfig) {
        // Initialize MAX_BUY_COUNTS_PER_SIDE from config
        this.MAX_BUY_COUNTS_PER_SIDE = config.trading.maxBuyCountsPerSide;
        // Initialize WebSocket orderbook (store promise for later awaiting)
        this.initializationPromise = this.initializeWebSocket();
    }

    static async fromEnv(client: ClobClient): Promise<UpDownPredictionBot> {
        const {
            sharesPerSide, tickSize, negRisk,
            priceBuffer, fireAndForget, minBalanceUsdc
        } = config.trading;
        const bot = new UpDownPredictionBot(client, {
            market: "btc",
            sharesPerSide,
            tickSize: tickSize as CreateOrderOptions["tickSize"],
            negRisk, priceBuffer, fireAndForget, minBalanceUsdc,
        });
        await bot.initializationPromise; // Await WebSocket initialization
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

        logger.info(`Starting UpDownPredictionBot for BTC updown-5m pools`);
        await this.initializeMarket(this.cfg.market);

        // Set up periodic summary generation - only at 5-minute boundaries
        // Check every minute to catch boundaries precisely
        setInterval(() => {
            const now = new Date();
            const minutes = now.getMinutes();
            const seconds = now.getSeconds();

            // Only generate summaries at 5-minute boundaries (..:00, ..:05, ..:10, ...)
            // Check within the first 5 seconds of the minute to avoid duplicates
            if (minutes % 5 === 0 && seconds < 5) {
                this.generateAllPredictionSummaries();
            }
        }, 60 * 1000); // Check every minute

        // Set up periodic market cycle check (every 10 seconds to catch 5-minute boundaries)
        // This ensures we detect market cycle changes even if there are no price updates
        setInterval(() => {
            this.checkAndHandleMarketCycleChanges();
        }, 10 * 1000); // Check every 10 seconds
    }

    stop(): void {
        this.isStopped = true;

        // Generate summaries for all active markets before stopping
        logger.info("\n🛑 Generating final prediction summaries...");
        this.generateAllPredictionSummaries();

        if (this.wsOrderBook) {
            this.wsOrderBook.disconnect();
        }
        logger.info("UpDownPredictionBot stopped");
    }

    private getRuntimeRegimeState(market: string): RuntimeRegimeState {
        let st = this.regimeStateByMarket.get(market);
        if (!st) {
            st = {
                confirmed: null,
                candidate: null,
                candidateCount: 0,
                cooldownUntilTick: 0,
                chopSeenTick: null,
            };
            this.regimeStateByMarket.set(market, st);
        }
        return st;
    }

    private updateConfirmedRegime(
        market: string,
        detected: PricePrediction["regime"],
    ): PricePrediction["regime"] {
        const st = this.getRuntimeRegimeState(market);
        const immediate = detected === "liquidity_vacuum" || detected === "expiry";
        if (immediate) {
            st.confirmed = detected;
            st.candidate = null;
            st.candidateCount = 0;
            return detected;
        }

        if (st.confirmed === null) {
            st.confirmed = detected;
            st.candidate = null;
            st.candidateCount = 0;
            return detected;
        }

        if (detected === st.confirmed) {
            st.candidate = null;
            st.candidateCount = 0;
            return st.confirmed;
        }

        if (st.candidate === detected) {
            st.candidateCount++;
        } else {
            st.candidate = detected;
            st.candidateCount = 1;
        }

        if (st.candidateCount >= UpDownPredictionBot.REGIME_CONFIRM_TICKS) {
            st.confirmed = detected;
            st.candidate = null;
            st.candidateCount = 0;
        }

        return st.confirmed;
    }

    private hasAnyDirectionalHold(market: string): boolean {
        return this.flowDominanceHold.has(market) ||
            this.momentumHold.has(market) ||
            this.breakoutHold.has(market) ||
            this.reversalHold.has(market);
    }

    private clearDirectionalState(market: string): void {
        this.flowDominanceHold.delete(market);
        this.momentumHold.delete(market);
        this.breakoutHold.delete(market);
        this.reversalHold.delete(market);
        this.breakoutArmPending.delete(market);
        this.reversalArmPending.delete(market);
    }

    private async initializeMarket(market: string): Promise<void> {
        try {
            const slug = slugForCurrent5m(market);
            logger.info(`Initializing market ${market} with slug ${slug}`);
            const tokenIds = await fetchTokenIdsForSlug(slug);
            this.tokenIdsByMarket[market] = { slug, ...tokenIds };
            this.lastSlugByMarket[market] = slug;

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
            const slug = slugForCurrent5m(market);
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
            // Get slug for current 5m cycle
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

            // Check for market cycle change (new 5m period)
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
            }

            // Update metadata (only if we're going to process)
            row.conditionId = currentTokenIds.conditionId;
            row.slug = slug;
            row.market = market;
            row.upIdx = currentTokenIds.upIdx;
            row.downIdx = currentTokenIds.downIdx;
            row.lastUpdatedIso = new Date().toISOString();

            // Get or create price predictor for this market
            let predictor = this.pricePredictors.get(market);
            if (!predictor) {
                predictor = new AdaptivePricePredictor();
                this.pricePredictors.set(market, predictor);
            }

            // Build rich snapshot from available WebSocket data.
            // Event-time features prefer orderbook/flow state over price-only transforms.
            const nowTs = Date.now();
            const roundStart = current5mSlotStartMs();
            const roundEnd = roundStart + 5 * 60 * 1000;
            const snapshot: MarketSnapshot = {
                bestBid: upPrice.bestBid ?? upAsk,
                bestAsk: upAsk,
                bestBidSize: 0, // TODO: populate from top-of-book size stream
                bestAskSize: 0, // TODO: populate from top-of-book size stream
                bidDepthTop3: undefined, // TODO: populate from orderbook depth events
                askDepthTop3: undefined, // TODO: populate from orderbook depth events
                timestamp: nowTs,
                recentEventCount: 1,
                roundEndTimestamp: roundEnd,
                downAsk: downAsk,
                roundStartTime: roundStart,
            };

            // Returns a prediction when a trigger fires (pole, momentum, or expiry regime)
            const prediction = predictor.updateAndPredictWithSnapshot(snapshot);
            const prevTick = this.marketProcessTick.get(market) ?? 0;
            const processTick = prevTick + 1;
            this.marketProcessTick.set(market, processTick);

            if (!prediction) {
                row.previousUpPrice = upAsk;
                return;
            }

            let effectivePrediction: PricePrediction = prediction;
            let shareSize = this.cfg.sharesPerSide;
            let regimeExec: RegimeStrategyExec | undefined;

            let nextHist = this.upAskHistory.get(market);
            if (!nextHist) {
                nextHist = [];
                this.upAskHistory.set(market, nextHist);
            }
            nextHist.push(upAsk);
            if (nextHist.length > 24) nextHist.shift();

            const micro = predictor.getLatestMicrostructure();
            const rr = predictor.getLatestRegimeResult();
            const detectedRegime = (rr?.regime ?? effectivePrediction.regime) as PricePrediction["regime"];
            const confirmedRegime = this.updateConfirmedRegime(market, detectedRegime);
            const regimeState = this.getRuntimeRegimeState(market);

            if (micro) {
                let nextComp = this.compressionHistory.get(market);
                if (!nextComp) {
                    nextComp = [];
                    this.compressionHistory.set(market, nextComp);
                }
                nextComp.push(isCompression(micro));
                if (nextComp.length > 48) nextComp.shift();

                let nextRet = this.return1History.get(market);
                if (!nextRet) {
                    nextRet = [];
                    this.return1History.set(market, nextRet);
                }
                nextRet.push(micro.raw.return1);
                if (nextRet.length > 48) nextRet.shift();
            }
            if (!rr || rr.regime !== "breakout") {
                this.breakoutArmPending.delete(market);
            }
            if (!rr || rr.regime !== "reversal") {
                this.reversalArmPending.delete(market);
            }

            // Transition safety actions: de-risk quickly on hostile regime flips.
            let forcedTransitionBlockReason: string | undefined;
            const hasHold = this.hasAnyDirectionalHold(market);
            if (confirmedRegime === "liquidity_vacuum" && hasHold) {
                this.clearDirectionalState(market);
                regimeState.cooldownUntilTick = processTick + UpDownPredictionBot.COOLDOWN_TICKS_AFTER_DERISK;
                regimeState.chopSeenTick = null;
                forcedTransitionBlockReason = "transition: liquidity_vacuum de-risk";
                logger.warning(`🛑 TRANSITION EXIT: liquidity_vacuum -> clear holds, cooldown=${UpDownPredictionBot.COOLDOWN_TICKS_AFTER_DERISK} ticks`);
            } else if (confirmedRegime === "chop" && hasHold) {
                if (regimeState.chopSeenTick === null) {
                    regimeState.chopSeenTick = processTick;
                }
                const chopAge = processTick - regimeState.chopSeenTick;
                if (chopAge >= UpDownPredictionBot.CHOP_FORCE_EXIT_GRACE_TICKS) {
                    this.clearDirectionalState(market);
                    regimeState.cooldownUntilTick = processTick + UpDownPredictionBot.COOLDOWN_TICKS_AFTER_DERISK;
                    forcedTransitionBlockReason = "transition: chop persistence de-risk";
                    logger.info(`🛑 TRANSITION EXIT: chop persisted (${chopAge} ticks) -> clear holds, cooldown=${UpDownPredictionBot.COOLDOWN_TICKS_AFTER_DERISK} ticks`);
                }
            } else if (confirmedRegime !== "chop") {
                regimeState.chopSeenTick = null;
            }

            const directionalRegime =
                confirmedRegime === "flow_dominance" ||
                confirmedRegime === "momentum" ||
                confirmedRegime === "breakout" ||
                confirmedRegime === "reversal";
            const cooldownActive = processTick < regimeState.cooldownUntilTick;
            const blockedByCooldown = cooldownActive && directionalRegime;
            const strategyRegime: PricePrediction["regime"] = blockedByCooldown ? "chop" : confirmedRegime;
            effectivePrediction = {
                ...effectivePrediction,
                regime: strategyRegime,
            };
            if (forcedTransitionBlockReason) {
                effectivePrediction = {
                    ...effectivePrediction,
                    signal: "HOLD",
                    blockedBySafetyGate: true,
                    safetyBlockReason: forcedTransitionBlockReason,
                };
            } else if (blockedByCooldown) {
                effectivePrediction = {
                    ...effectivePrediction,
                    signal: "HOLD",
                    blockedBySafetyGate: true,
                    safetyBlockReason: `transition: cooldown ${regimeState.cooldownUntilTick - processTick} ticks`,
                };
            }

            if (!blockedByCooldown && !forcedTransitionBlockReason && strategyRegime === "flow_dominance" && micro && rr) {
                let blockedByActiveHold = false;
                if (this.flowDominanceHold.has(market)) {
                    const h = this.flowDominanceHold.get(market)!;
                    const ev = processTick - h.entryTick;
                    const ex = shouldExitFlowDominancePosition(micro, h.snapshot);
                    const force = shouldForceExitByHoldDuration(ev);
                    if (ex.exit || force) {
                        logger.info(
                            `📉 ${colorStrategy("flow_dominance")} EXIT: ${ex.reason ?? "max hold events"} (eventsHeld=${ev})`,
                        );
                        this.flowDominanceHold.delete(market);
                    } else {
                        blockedByActiveHold = true;
                    }
                }

                if (blockedByActiveHold) {
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: "flow_dominance: active position (no pyramid)",
                    };
                } else {
                    const fd = evaluateFlowDominanceEntry(micro, rr);
                    if (fd.shouldEnter) {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: fd.signal,
                            direction: fd.direction,
                            confidence: fd.confidence,
                            blockedBySafetyGate: undefined,
                            safetyBlockReason: undefined,
                        };
                        shareSize = computeFlowDominancePositionSize(
                            this.cfg.sharesPerSide,
                            fd.entryScore,
                            rr.bestScore,
                        );
                        regimeExec = { kind: "flow_dominance", entrySnapshot: fd.entrySnapshot, processTick };
                        logger.info(`📈 ${colorStrategy("flow_dominance")} ENTRY: ${fd.reason}`);
                    } else {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: "HOLD",
                            blockedBySafetyGate: true,
                            safetyBlockReason: fd.blockReason ?? "flow_dominance: entry not met",
                        };
                    }
                }
            } else if (!blockedByCooldown && !forcedTransitionBlockReason && strategyRegime === "momentum" && micro && rr) {
                let blockedByMomentumHold = false;
                if (this.momentumHold.has(market)) {
                    const h = this.momentumHold.get(market)!;
                    const ev = processTick - h.entryTick;
                    const ex = shouldExitMomentumPosition(micro, h.snapshot, rr.persistenceScore ?? 0);
                    const force = shouldForceExitMomentumByHoldDuration(ev);
                    if (ex.exit || force) {
                        logger.info(
                            `📉 ${colorStrategy("momentum")} EXIT: ${ex.reason ?? "max hold events"} (eventsHeld=${ev})`,
                        );
                        this.momentumHold.delete(market);
                    } else {
                        blockedByMomentumHold = true;
                    }
                }

                if (blockedByMomentumHold) {
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: "momentum: active position (no pyramid)",
                    };
                } else {
                    const mom = evaluateMomentumEntry(micro, rr, nextHist);
                    if (mom.shouldEnter) {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: mom.signal,
                            direction: mom.direction,
                            confidence: mom.confidence,
                            blockedBySafetyGate: undefined,
                            safetyBlockReason: undefined,
                        };
                        shareSize = computeMomentumPositionSize(this.cfg.sharesPerSide, mom.momentumScore);
                        regimeExec = { kind: "momentum", entrySnapshot: mom.entrySnapshot, processTick };
                        logger.info(`📈 ${colorStrategy("momentum")} ENTRY: ${mom.reason}`);
                    } else {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: "HOLD",
                            blockedBySafetyGate: true,
                            safetyBlockReason: mom.blockReason ?? "momentum: entry not met",
                        };
                    }
                }
            } else if (!blockedByCooldown && !forcedTransitionBlockReason && strategyRegime === "breakout" && micro && rr) {
                let blockedByBreakoutHold = false;
                if (this.breakoutHold.has(market)) {
                    const h = this.breakoutHold.get(market)!;
                    const ev = processTick - h.entryTick;
                    const ex = shouldExitBreakoutPosition(micro, h.snapshot);
                    const force = shouldForceExitBreakoutByHoldDuration(ev);
                    if (ex.exit || force) {
                        logger.info(
                            `📉 ${colorStrategy("breakout")} EXIT: ${ex.reason ?? "max hold events"} (eventsHeld=${ev})`,
                        );
                        this.breakoutHold.delete(market);
                    } else {
                        blockedByBreakoutHold = true;
                    }
                }

                if (blockedByBreakoutHold) {
                    this.breakoutArmPending.delete(market);
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: "breakout: active position (no pyramid)",
                    };
                } else {
                    const compSeries = this.compressionHistory.get(market) ?? [];
                    const hadCompression = hadCompressionInRecentWindow(compSeries, COMPRESSION_LOOKBACK_EVENTS);
                    const pending = this.breakoutArmPending.get(market) ?? null;
                    const bo = evaluateBreakoutEntry(micro, rr, hadCompression, pending, processTick);
                    if (bo.pendingNext === null) {
                        this.breakoutArmPending.delete(market);
                    } else {
                        this.breakoutArmPending.set(market, bo.pendingNext);
                    }
                    if (bo.shouldEnter && bo.entrySnapshot) {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: bo.signal,
                            direction: bo.direction,
                            confidence: bo.confidence,
                            blockedBySafetyGate: undefined,
                            safetyBlockReason: undefined,
                        };
                        shareSize = computeBreakoutPositionSize(this.cfg.sharesPerSide);
                        regimeExec = { kind: "breakout", entrySnapshot: bo.entrySnapshot, processTick };
                        logger.info(`📈 ${colorStrategy("breakout")} ENTRY: ${bo.reason}`);
                    } else {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: "HOLD",
                            blockedBySafetyGate: true,
                            safetyBlockReason: bo.blockReason ?? "breakout: entry not met",
                        };
                    }
                }
            } else if (!blockedByCooldown && !forcedTransitionBlockReason && strategyRegime === "reversal" && micro && rr) {
                let blockedByReversalHold = false;
                if (this.reversalHold.has(market)) {
                    const h = this.reversalHold.get(market)!;
                    const ev = processTick - h.entryTick;
                    const retSeries = this.return1History.get(market) ?? [];
                    const ex = shouldExitReversalPosition(micro, h.snapshot, retSeries);
                    const force = shouldForceExitReversalByHoldDuration(ev);
                    if (ex.exit || force) {
                        logger.info(
                            `📉 ${colorStrategy("reversal")} EXIT: ${ex.reason ?? "max hold events"} (eventsHeld=${ev})`,
                        );
                        this.reversalHold.delete(market);
                    } else {
                        blockedByReversalHold = true;
                    }
                }

                if (blockedByReversalHold) {
                    this.reversalArmPending.delete(market);
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: "reversal: active position (no pyramid)",
                    };
                } else {
                    const retSeries = this.return1History.get(market) ?? [];
                    const prevZ = this.reversalPrevExhaustionZ.get(market) ?? null;
                    const pending = this.reversalArmPending.get(market) ?? null;
                    const rev = evaluateReversalEntry(micro, rr, retSeries, prevZ, pending, processTick);
                    if (rev.pendingNext === null) {
                        this.reversalArmPending.delete(market);
                    } else {
                        this.reversalArmPending.set(market, rev.pendingNext);
                    }
                    if (rev.shouldEnter && rev.entrySnapshot) {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: rev.signal,
                            direction: rev.direction,
                            confidence: rev.confidence,
                            blockedBySafetyGate: undefined,
                            safetyBlockReason: undefined,
                        };
                        shareSize = computeReversalPositionSize(this.cfg.sharesPerSide);
                        regimeExec = { kind: "reversal", entrySnapshot: rev.entrySnapshot, processTick };
                        logger.info(`📈 ${colorStrategy("reversal")} ENTRY: ${rev.reason}`);
                    } else {
                        effectivePrediction = {
                            ...effectivePrediction,
                            signal: "HOLD",
                            blockedBySafetyGate: true,
                            safetyBlockReason: rev.blockReason ?? "reversal: entry not met",
                        };
                    }
                }
            }

            if (micro) {
                this.reversalPrevExhaustionZ.set(market, {
                    absOfiZ: Math.abs(micro.zOfiNorm),
                    absMicroZ: Math.abs(micro.zMicropriceEdge),
                });
            }

            // Low-signal no-trade: chop, weak best score, or tight margin — HOLD (overrides regime strategies).
            if (rr && lowSignalBlocksTrade(rr)) {
                const reason = formatLowSignalBlockReason(rr);
                const hadRegimeExec = regimeExec !== undefined;
                effectivePrediction = {
                    ...effectivePrediction,
                    signal: "HOLD",
                    blockedBySafetyGate: true,
                    safetyBlockReason: reason,
                };
                regimeExec = undefined;
                if (rr.regime === "chop" && micro) {
                    logger.debug(formatChopMicroMetrics(micro));
                }
                if (hadRegimeExec) {
                    logger.info(`🚫 NO_TRADE: ${reason} (overrode regime strategy)`);
                } else {
                    logger.debug(`🚫 NO_TRADE: ${reason}`);
                }
            }

            // Execution risk (final gate): thin / dangerous book — overrides prediction; HOLD unless extreme flow_dominance score (≤30% base).
            if (rr && executionRiskDanger(rr, micro)) {
                if (!executionRiskSmallTradeAllowed(rr)) {
                    const hadRegimeExec = regimeExec !== undefined;
                    const reason = formatExecutionRiskBlockReason(rr, micro);
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: reason,
                    };
                    regimeExec = undefined;
                    if (hadRegimeExec) {
                        logger.info(`🚫 NO_TRADE: ${reason} (overrode regime strategy)`);
                    } else {
                        logger.debug(`🚫 NO_TRADE: ${reason}`);
                    }
                } else {
                    const base = this.cfg.sharesPerSide;
                    const prev = shareSize ?? base;
                    shareSize = capExecutionRiskSmallTradeSize(base, prev);
                    const fd = rr.scores?.flow_dominance ?? 0;
                    if (regimeExec !== undefined || effectivePrediction.signal !== "HOLD") {
                        logger.info(
                            `⚠️ EXECUTION RISK: small-trade cap size=${shareSize} (flow_dominance=${fd.toFixed(2)}>=0.80)`,
                        );
                    }
                }
            }

            // End-of-round: default HOLD when <20s to expiry; optional trade only with strong flow + tight spread + depth (≤50% base).
            if (rr && micro && expiryCloseWindow(micro)) {
                if (!expiryCloseAllowsTrade(rr, micro)) {
                    const hadRegimeExec = regimeExec !== undefined;
                    const reason = formatExpiryCloseBlockReason(micro);
                    effectivePrediction = {
                        ...effectivePrediction,
                        signal: "HOLD",
                        blockedBySafetyGate: true,
                        safetyBlockReason: reason,
                    };
                    regimeExec = undefined;
                    if (hadRegimeExec) {
                        logger.info(`🚫 NO_TRADE: ${reason} (overrode regime strategy)`);
                    } else {
                        logger.debug(`🚫 NO_TRADE: ${reason}`);
                    }
                } else {
                    const base = this.cfg.sharesPerSide;
                    const prev = shareSize ?? base;
                    shareSize = capExpiryCloseSize(base, prev);
                    const fd = rr.scores?.flow_dominance ?? 0;
                    if (regimeExec !== undefined || effectivePrediction.signal !== "HOLD") {
                        logger.info(
                            `⚠️ EXPIRY-CLOSE: size cap=${shareSize} (flow_dominance=${fd.toFixed(2)}, spread/depth OK)`,
                        );
                    }
                }
            }

            // Track prediction for accuracy calculation.
            // Direction is determined by sign of price change; a zero move
            // is treated as "up" (tie-breaking toward the previous prediction
            // is not meaningful either way for a 0-move outcome).
            const lastPred = this.lastPredictions.get(market);
            if (lastPred) {
                const priceDiff = upAsk - lastPred.actualPrice;
                const actualDirection: "up" | "down" = priceDiff >= 0 ? "up" : "down";
                const wasCorrect = lastPred.prediction.direction === actualDirection;
                const timeDiff = Date.now() - lastPred.timestamp;

                logger.info(`🔮 Prediction: ${lastPred.prediction.direction.toUpperCase()} (conf: ${lastPred.prediction.confidence.toFixed(2)}) | Actual: ${actualDirection.toUpperCase()} | ${wasCorrect ? "✅ CORRECT" : "❌ WRONG"} | Time: ${timeDiff}ms`);

                this.updatePredictionScore(market, slug, lastPred.prediction, lastPred.actualPrice, upAsk, wasCorrect);
            }

            // Store current prediction for next evaluation
            this.lastPredictions.set(market, {
                prediction: effectivePrediction,
                actualPrice: upAsk,
                timestamp: Date.now(),
            });

            const bestEdge = Math.max(effectivePrediction.edgeBuyUp, effectivePrediction.edgeBuyDown);
            const triggerType = effectivePrediction.isPoleValue ? "POLE" : effectivePrediction.regime.toUpperCase();
            const coloredRegime = colorRegime(effectivePrediction.regime);
            const coloredSignal = colorSignal(effectivePrediction.signal);
            const blockedText = effectivePrediction.blockedBySafetyGate
                ? ` ${chalk.bgRed.white.bold("[BLOCKED]")} ${chalk.redBright(effectivePrediction.safetyBlockReason ?? "")}`
                : "";
            logger.info(`🔮 PREDICT [${triggerType}]: regime=${coloredRegime} (conf=${effectivePrediction.regimeConfidence.toFixed(2)}, margin=${effectivePrediction.regimeScoreMargin.toFixed(2)}) | pUp=${effectivePrediction.pUp.toFixed(3)} | Edge=${(bestEdge * 100).toFixed(1)}% | Dir: ${effectivePrediction.direction.toUpperCase()} | Signal: ${coloredSignal}${blockedText} | Pred: ${effectivePrediction.predictedPrice.toFixed(4)} (cur: ${upAsk.toFixed(4)})`);

            // Execute prediction-based trading strategy
            this.executePredictionTrade(market, slug, effectivePrediction, upAsk, downAsk, currentTokenIds, shareSize, regimeExec);

            // Log diagnostics periodically
            const diagStats = predictor.getDiagnostics().getStats();
            if (diagStats.totalPredictions > 0 &&
                (diagStats.totalPredictions % 25 === 0 ||
                 [10, 50, 100, 200, 500, 1000].includes(diagStats.totalPredictions))) {
                logger.info(predictor.getDiagnostics().formatStatsLog());
            }

            // Log regime diagnostics at lower frequency (event-driven, not prediction-driven)
            const regimeStats = predictor.getRegimeDiagnostics().getStats();
            if (regimeStats.totalEvents > 0 &&
                (regimeStats.totalEvents % 100 === 0 ||
                 [50, 200, 500, 1000].includes(regimeStats.totalEvents))) {
                logger.info(predictor.getRegimeDiagnostics().formatStatsLog());
            }

            // Update previous UP ask price (always update for next comparison)
            row.previousUpPrice = upAsk;
            // State will be saved by debounced saveState automatically
        });
    }

    private getSlugForMarket(market: string): string {
        return slugForCurrent5m(market);
    }

    /**
     * Periodically check for market cycle changes and handle them
     * This ensures we detect cycle changes even when there are no price updates
     */
    private async checkAndHandleMarketCycleChanges(): Promise<void> {
        if (this.isStopped) return;
        const market = this.cfg.market;
        const currentSlug = this.getSlugForMarket(market);
        const prevSlug = this.lastSlugByMarket[market];
        if (prevSlug && prevSlug !== currentSlug) {
            logger.info(
                `🔄 Market cycle change detected via periodic check for ${market}: ${prevSlug} → ${currentSlug}`
            );
            await this.reinitializeMarketForNewCycle(market, prevSlug, currentSlug);
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

            const predictor = this.pricePredictors.get(market);
            if (predictor) {
                predictor.reset();
            }
            this.marketProcessTick.delete(market);
            this.flowDominanceHold.delete(market);
            this.momentumHold.delete(market);
            this.upAskHistory.delete(market);
            this.compressionHistory.delete(market);
            this.breakoutHold.delete(market);
            this.breakoutArmPending.delete(market);
            this.reversalHold.delete(market);
            this.reversalArmPending.delete(market);
            this.return1History.delete(market);
            this.reversalPrevExhaustionZ.delete(market);
            this.regimeStateByMarket.delete(market);

            logger.info(`✅ Market ${market} re-initialized with new token IDs for cycle ${newSlug}`);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            logger.error(`⚠️  Failed to re-initialize market ${market} with new slug ${newSlug}: ${errorMsg}. Will retry on next check.`);
        }
    }

    private async buyShares(
        leg: "YES" | "NO",
        tokenID: string,
        askPrice: number,
        size: number,
    ): Promise<boolean> {
        const limitPrice = askPrice + 0.01;

        const limitOrder: UserOrder = {
            tokenID,
            side: Side.BUY,
            price: limitPrice,
            size,
        };

        const orderAmount = limitPrice * size;

        logger.info(`BUY: ${leg} ~${size} shares @ limit ${limitPrice.toFixed(4)} (${orderAmount.toFixed(2)} USDC)`);

        // Place order IMMEDIATELY (await to ensure it's placed within 10ms)
        try {
            const response = await this.client.createAndPostOrder(
                limitOrder,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC // Good-Till-Cancel for limit orders
            );

            const orderID = response?.orderID;
            if (!orderID) {
                logger.error(`BUY failed for ${leg} - no orderID returned`);
                return false;
            }
            // Order placed successfully
            logger.info(`✅ First-Side Order placed: ${leg} orderID ${orderID.substring(0, 10)}... @ ${limitPrice.toFixed(4)}`);
            return true;
        } catch (e) {
            logger.error(`BUY failed for ${leg}: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * Execute prediction-based trading strategy
     * Single-leg execution only:
     * - buy UP when direction is up
     * - buy DOWN when direction is down
     * `shareSize` defaults to config; regime strategies may scale size.
     */
    private executePredictionTrade(
        market: string,
        slug: string,
        prediction: PricePrediction,
        upAsk: number,
        downAsk: number,
        tokenIds: { upTokenId: string; downTokenId: string; conditionId: string; upIdx: number; downIdx: number },
        shareSize?: number,
        regimeExec?: RegimeStrategyExec,
    ): void {
        const size = shareSize ?? this.cfg.sharesPerSide;
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

        // Skip if signal is HOLD (edge insufficient or volatility circuit breaker)
        if (prediction.signal === "HOLD") {
            return;
        }

        // Safety hook: check diagnostics health before trading
        const predictor = this.pricePredictors.get(market);
        if (predictor) {
            const health = predictor.getDiagnostics().getHealthStatus();
            if (!health.tradingAllowed) {
                logger.warning(`SAFETY: trading disabled - ${health.warnings.join(", ")}`);
                return;
            }
            if (health.warnings.length > 0) {
                logger.warning(`DIAGNOSTICS: ${health.warnings.join("; ")}`);
            }
        }

        // Only increment totalPredictions when we actually make a trade
        score.totalPredictions++;

        // Determine which token to buy based on prediction direction only
        // Always follow prediction direction - no alternating logic
        let buyToken: "UP" | "DOWN" | null = null;
        let buyPrice = 0;
        let tokenId = "";

        if (prediction.direction === "up") {
            // Prediction says rising → buy UP token
            buyToken = "UP";
            buyPrice = upAsk;
            tokenId = tokenIds.upTokenId;
        } else if (prediction.direction === "down") {
            // Prediction says falling → buy DOWN token
            buyToken = "DOWN";
            buyPrice = downAsk;
            tokenId = tokenIds.downTokenId;
        }

        if (!buyToken) return; // No valid buy signal

        // Check if market is paused (reached 50 UP + 50 DOWN)
        if (this.pausedMarkets.has(scoreKey)) {
            return; // Skip silently - market paused
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
            return; // Skip - limit reached
        }
        if (buyToken === "DOWN" && tokenCounts.downTokenCount >= this.MAX_BUY_COUNTS_PER_SIDE) {
            logger.info(`⛔ LIMIT REACHED: DOWN count is ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} - skipping trade`);
            return; // Skip - limit reached
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
        const buyCost = buyPrice * size;
        logger.info(`🎯 FIRST-SIDE Trade: ${buyToken} @ ${buyPrice.toFixed(4)} (${buyCost.toFixed(2)} USDC) | size=${size} | UP ${tokenCounts.upTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE}, DOWN ${tokenCounts.downTokenCount}/${this.MAX_BUY_COUNTS_PER_SIDE} | Limit: ${this.MAX_BUY_COUNTS_PER_SIDE} per side`);

        this.buyShares(
            buyToken === "UP" ? "YES" : "NO",
            tokenId,
            buyPrice,
            size,
        );

        if (regimeExec?.kind === "flow_dominance") {
            this.flowDominanceHold.set(market, {
                entryTick: regimeExec.processTick,
                snapshot: regimeExec.entrySnapshot,
            });
        }
        if (regimeExec?.kind === "momentum") {
            this.momentumHold.set(market, {
                entryTick: regimeExec.processTick,
                snapshot: regimeExec.entrySnapshot,
            });
        }
        if (regimeExec?.kind === "breakout") {
            this.breakoutHold.set(market, {
                entryTick: regimeExec.processTick,
                snapshot: regimeExec.entrySnapshot,
            });
        }
        if (regimeExec?.kind === "reversal") {
            this.reversalHold.set(market, {
                entryTick: regimeExec.processTick,
                snapshot: regimeExec.entrySnapshot,
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

    /**
     * Generate prediction score summaries for all active markets
     * Called on shutdown or periodically
     */
    private generateAllPredictionSummaries(): void {
        const now = new Date();
        const minutes = now.getMinutes();

        if (minutes % 5 !== 0) {
            return;
        }

        // Generate summary for each active market/slug
        const scores = Array.from(this.predictionScores.entries());
        for (const [scoreKey, score] of scores) {
            if (score.endTime === null && score.totalPredictions > 0) {
                this.generatePredictionScoreSummary(score.slug, score.market);
            }
        }

        // Dump diagnostics summary for all predictors
        for (const [market, predictor] of this.pricePredictors.entries()) {
            const diag = predictor.getDiagnostics();
            const stats = diag.getStats();
            if (stats.totalPredictions > 0) {
                logger.info(`\n📊 DIAGNOSTICS SUMMARY [${market}]:\n${diag.formatStatsLog()}`);
            }

            const regimeDiag = predictor.getRegimeDiagnostics();
            const regimeStats = regimeDiag.getStats();
            if (regimeStats.totalEvents > 0) {
                logger.info(`\n📊 REGIME DIAGNOSTICS [${market}]:\n${regimeDiag.formatStatsLog()}`);
            }
        }
    }

}
