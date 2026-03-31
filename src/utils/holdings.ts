import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { logger } from "./logger";

/**
 * Holdings structure: market_id (conditionId) -> { token_id: amount }
 */
export interface TokenHoldings {
    [marketId: string]: {
        [tokenId: string]: number;
    };
}

const HOLDINGS_FILE = resolve(process.cwd(), "src/data/token-holding.json");

/**
 * Load holdings from file
 */
export function loadHoldings(): TokenHoldings {
    if (!existsSync(HOLDINGS_FILE)) {
        return {};
    }

    try {
        const content = readFileSync(HOLDINGS_FILE, "utf-8");
        return JSON.parse(content) as TokenHoldings;
    } catch (error) {
        logger.error("Failed to load holdings", error);
        return {};
    }
}

/**
 * Save holdings to file
 */
export function saveHoldings(holdings: TokenHoldings): void {
    try {
        writeFileSync(HOLDINGS_FILE, JSON.stringify(holdings, null, 2));
    } catch (error) {
        logger.error("Failed to save holdings", error);
    }
}

/**
 * Add tokens to holdings after a BUY order
 */
export function addHoldings(marketId: string, tokenId: string, amount: number): void {
    const holdings = loadHoldings();
    
    if (!holdings[marketId]) {
        holdings[marketId] = {};
    }
    
    if (!holdings[marketId][tokenId]) {
        holdings[marketId][tokenId] = 0;
    }
    
    holdings[marketId][tokenId] += amount;
    
    saveHoldings(holdings);
    logger.info(`Added ${amount} tokens to holdings: ${marketId} -> ${tokenId}`);
}

/**
 * Get all holdings for a market
 */
export function getMarketHoldings(marketId: string): { [tokenId: string]: number } {
    const holdings = loadHoldings();
    return holdings[marketId] || {};
}

/**
 * Get all holdings (for debugging/viewing)
 */
export function getAllHoldings(): TokenHoldings {
    return loadHoldings();
}

/**
 * Clear all holdings for a specific market
 */
export function clearMarketHoldings(marketId: string): void {
    const holdings = loadHoldings();
    if (holdings[marketId]) {
        delete holdings[marketId];
        saveHoldings(holdings);
        logger.info(`Cleared holdings for market: ${marketId}`);
    } else {
        logger.error(`No holdings found for market: ${marketId}`);
    }
}

