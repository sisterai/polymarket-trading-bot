import WebSocket from "ws";
import { logger } from "../utils/logger";

const BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream?streams=";
const PING_INTERVAL_MS = 20_000;
const RECONNECT_DELAY_MS = 5_000;
const CONNECT_TIMEOUT_MS = 15_000;

const MARKET_TO_SYMBOL: Record<string, string> = {
    btc: "btcusdt",
    eth: "ethusdt",
    sol: "solusdt",
    xrp: "xrpusdt",
    bnb: "bnbusdt",
    avax: "avaxusdt",
    matic: "maticusdt",
    link: "linkusdt",
    doge: "dogeusdt",
    ada: "adausdt",
};

export function marketToBinanceSymbol(market: string): string | null {
    return MARKET_TO_SYMBOL[market.toLowerCase()] ?? null;
}

type AggTradeMessage = {
    data?: { s?: string; p?: string };
    s?: string;
    p?: string;
};

export class BinanceWebSocket {
    private ws: WebSocket | null = null;
    private prices: Map<string, number> = new Map();
    private callbacks: Map<string, Array<(price: number) => void>> = new Map();
    private readonly symbols: string[];
    private pingTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isClosed = false;

    constructor(markets: string[]) {
        this.symbols = markets
            .map((m) => marketToBinanceSymbol(m))
            .filter((s): s is string => s !== null);
    }

    async connect(): Promise<void> {
        if (this.symbols.length === 0) {
            logger.error("BinanceWebSocket: no mapped symbols for given markets");
            return;
        }

        return new Promise((resolve, reject) => {
            const streams = this.symbols.map((s) => `${s}@aggTrade`).join("/");
            const url = `${BINANCE_WS_BASE}${streams}`;

            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (err) reject(err);
                else resolve();
            };

            const timeout = setTimeout(
                () => settle(new Error("Binance WS connect timeout")),
                CONNECT_TIMEOUT_MS
            );

            this.ws = new WebSocket(url);

            this.ws.on("open", () => {
                logger.info(`BinanceWebSocket connected: ${this.symbols.join(", ")}`);
                this.startPing();
                settle();
            });

            this.ws.on("message", (data: Buffer | string) => {
                this.handleMessage(data.toString());
            });

            // Binance sends server-side pings; respond with pong to stay connected
            this.ws.on("ping", (data) => {
                this.ws?.pong(data);
            });

            this.ws.on("error", (err) => {
                logger.error(`BinanceWebSocket error: ${err.message}`);
                settle(err);
            });

            this.ws.on("close", () => {
                this.stopPing();
                if (!this.isClosed) {
                    logger.error("BinanceWebSocket closed, scheduling reconnect...");
                    this.scheduleReconnect();
                }
            });
        });
    }

    private handleMessage(raw: string): void {
        try {
            const msg = JSON.parse(raw) as AggTradeMessage;
            // Combined stream: { stream, data: { s, p } }; single stream: { s, p }
            const trade = msg.data ?? (msg as { s?: string; p?: string });
            if (!trade.s || !trade.p) return;

            const symbol = trade.s.toLowerCase();
            const price = parseFloat(trade.p);
            if (!Number.isFinite(price) || price <= 0) return;

            this.prices.set(symbol, price);

            const cbs = this.callbacks.get(symbol);
            if (cbs) {
                for (const cb of cbs) cb(price);
            }
        } catch {
            // ignore malformed frames
        }
    }

    getPrice(symbol: string): number | null {
        return this.prices.get(symbol.toLowerCase()) ?? null;
    }

    onPriceUpdate(symbol: string, cb: (price: number) => void): void {
        const key = symbol.toLowerCase();
        if (!this.callbacks.has(key)) this.callbacks.set(key, []);
        this.callbacks.get(key)!.push(cb);
    }

    private startPing(): void {
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, PING_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch (e) {
                logger.error(
                    `BinanceWebSocket reconnect failed: ${e instanceof Error ? e.message : String(e)}`
                );
            }
        }, RECONNECT_DELAY_MS);
    }

    disconnect(): void {
        this.isClosed = true;
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
    }
}
