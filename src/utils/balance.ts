import { ClobClient, AssetType } from "@polymarket/clob-client";
import { getContractConfig } from "@polymarket/clob-client";
import { config } from "../config";
import { logger } from "./logger";

function extractCollateralAllowanceMicro(balanceResponse: any): number {
    // Newer CLOB responses expose allowances per spender (Exchange, NegRisk*, etc.)
    // Older responses may expose a direct `allowance` field.
    const direct = parseFloat(balanceResponse?.allowance ?? "NaN");
    if (Number.isFinite(direct)) return direct;

    const allowances: Record<string, string> | undefined = balanceResponse?.allowances;
    if (!allowances || typeof allowances !== "object") return 0;

    const chainId = config.chainId;
    const exchange = getContractConfig(chainId).exchange.toLowerCase();
    const raw = allowances[exchange] ?? allowances[Object.keys(allowances).find((k) => k.toLowerCase() === exchange) ?? ""];
    const n = parseFloat(raw ?? "0");
    return Number.isFinite(n) ? n : 0;
}

/**
 * Calculate available balance for placing orders
 * Formula: availableBalance = totalBalance - sum of (orderSize - orderFillAmount) for open orders
 */
export async function getAvailableBalance(
    client: ClobClient,
    assetType: AssetType,
    tokenId?: string
): Promise<number> {
    try {
        // Get total balance
        const balanceResponse = await client.getBalanceAllowance({
            asset_type: assetType,
            ...(tokenId && { token_id: tokenId }),
        });

        const totalBalance = parseFloat(balanceResponse.balance || "0");
        const totalAllowance = assetType === AssetType.COLLATERAL ? extractCollateralAllowanceMicro(balanceResponse) : 0;

        // For COLLATERAL (USDC), CLOB enforces both balance and allowance.
        // The true spendable amount is min(balance, allowance).
        const spendableTotal =
            assetType === AssetType.COLLATERAL ? Math.min(totalBalance, totalAllowance) : totalBalance;

        // Get open orders for this asset
        const openOrders = await client.getOpenOrders(
            tokenId ? { asset_id: tokenId } : undefined
        );

        // Calculate reserved amount from open orders
        let reservedAmount = 0;
        for (const order of openOrders) {
            // Only count orders for the same asset type
            const orderSide = order.side.toUpperCase();
            const isBuyOrder = orderSide === "BUY";
            const isSellOrder = orderSide === "SELL";

            // For BUY orders, reserve USDC (COLLATERAL)
            // For SELL orders, reserve tokens (CONDITIONAL)
            if (
                (assetType === AssetType.COLLATERAL && isBuyOrder) ||
                (assetType === AssetType.CONDITIONAL && isSellOrder)
            ) {
                const orderSize = parseFloat(order.original_size || "0");
                const sizeMatched = parseFloat(order.size_matched || "0");
                const reserved = orderSize - sizeMatched;
                reservedAmount += reserved;
            }
        }

        const availableBalance = spendableTotal - reservedAmount;

        logger.debug(
            `Balance check: Balance=${totalBalance}, Allowance=${totalAllowance}, Reserved=${reservedAmount}, Available=${availableBalance}`
        );

        return Math.max(0, availableBalance);
    } catch (error) {
        logger.error(
            `Failed to get available balance: ${error instanceof Error ? error.message : String(error)}`
        );
        // Return 0 on error to be safe
        return 0;
    }
}

/**
 * Block execution until available USDC (collateral) balance reaches a minimum threshold.
 * This is useful to ensure the bot only proceeds once the wallet is funded.
 */
export async function waitForMinimumUsdcBalance(
    client: ClobClient,
    minimumUsd: number = 1,
    options?: {
        pollIntervalMs?: number;
        timeoutMs?: number; // 0 or undefined = no timeout
        logEveryPoll?: boolean;
    }
): Promise<{ ok: boolean; available: number; balance: number; allowance: number }> {
    const pollIntervalMs = options?.pollIntervalMs ?? 15_000;
    const timeoutMs = options?.timeoutMs ?? 0;
    const logEveryPoll = options?.logEveryPoll ?? true;

    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            // Best effort: ensure CLOB state is up-to-date with on-chain balance/allowance.
            try {
                await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            } catch {
                // ignore - we'll still query current CLOB view below
            }

            const balanceResponse = await client.getBalanceAllowance({
                asset_type: AssetType.COLLATERAL,
            });

            const balance = parseFloat(balanceResponse.balance || "0") / 10 ** 6;
            const allowance = extractCollateralAllowanceMicro(balanceResponse) / 10 ** 6;
            const available = (await getAvailableBalance(client, AssetType.COLLATERAL)) / 10 ** 6;

            logger.info("═══════════════════════════════════════");
            logger.info("💰 WALLET BALANCE & ALLOWANCE");
            logger.info("═══════════════════════════════════════");
            logger.info(`USDC Balance: ${balance.toFixed(6)}`);
            logger.info(`USDC Allowance: ${allowance.toFixed(6)}`);
            logger.info(
                `Available: ${available.toFixed(6)} (Balance: ${balance.toFixed(6)}, Allowance: ${allowance.toFixed(6)})`
            );
            logger.info("═══════════════════════════════════════");

            const ok = available >= minimumUsd;

            if (logEveryPoll) {
                logger.info(
                    `USDC gate: available=${available.toFixed(6)} (balance=${balance.toFixed(
                        6
                    )}, allowance=${allowance.toFixed(6)}), required>=${minimumUsd}`
                );
            }

            if (ok) {
                logger.info(
                    `USDC gate passed: available=${available.toFixed(6)} >= ${minimumUsd}`
                );
                return { ok: true, available, balance, allowance };
            }
        } catch (error) {
            logger.error(
                `USDC gate check failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (timeoutMs > 0 && Date.now() - start >= timeoutMs) {
            logger.error(
                `USDC gate timed out after ${Math.round(timeoutMs / 1000)}s (required>=${minimumUsd})`
            );
            return { ok: false, available: 0, balance: 0, allowance: 0 };
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}


