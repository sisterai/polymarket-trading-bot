import { readFileSync, existsSync } from "fs";
import { AssetType, Chain, ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import { ensureCredential, credentialPath } from "../security/createCredential";
import { getPolymarketProxyWalletAddress } from "../utils/proxyWallet";
import { logger } from "../utils/logger";

// Cache for ClobClient instance to avoid repeated initialization
let cachedClient: ClobClient | null = null;
let cachedConfig: { chainId: number; host: string } | null = null;

/**
 * Initialize ClobClient from credentials (cached singleton).
 * If credential file is missing, creates it automatically via createOrDeriveApiKey.
 */
export async function getClobClient(): Promise<ClobClient> {
    if (!existsSync(credentialPath())) {
        const ok = await ensureCredential();
        if (!ok) {
            throw new Error(
                "Credential file not found and could not create one. Set PRIVATE_KEY and ensure the wallet can create a Polymarket API key."
            );
        }
    }

    const creds: ApiKeyCreds = JSON.parse(readFileSync(credentialPath(), "utf-8"));
    
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;

    // Return cached client if config hasn't changed
    if (cachedClient && cachedConfig && 
        cachedConfig.chainId === chainId && 
        cachedConfig.host === host) {
        return cachedClient;
    }

    // Create wallet from private key
    const privateKey = config.requirePrivateKey();
    const wallet = new Wallet(privateKey);

    // Convert base64url secret to standard base64 for clob-client compatibility
    const secretBase64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');

    // Create API key credentials
    const apiKeyCreds: ApiKeyCreds = {
        key: creds.key,
        secret: secretBase64,
        passphrase: creds.passphrase,
    };

    // Polymarket supports trading via EOA (signatureType=0) or via the on-chain proxy/smart wallet
    // (signatureType=2 + funderAddress). Many users have collateral in the proxy wallet even if
    // they sign with the EOA. If USE_PROXY_WALLET is not explicitly enabled, we auto-detect which
    // mode has spendable collateral and pick that client.
    const eoaClient = new ClobClient(host, chainId, wallet, apiKeyCreds, 0);

    let proxyClient: ClobClient | null = null;
    let proxyAddress: string | null = null;
    try {
        proxyAddress = await getPolymarketProxyWalletAddress(wallet.address, chainId);
        if (proxyAddress) {
            proxyClient = new ClobClient(host, chainId, wallet, apiKeyCreds, 2, proxyAddress);
        }
    } catch (e) {
        // Proxy resolution is best-effort; we can still trade with EOA mode.
        logger.debug(
            `Proxy wallet auto-detect unavailable: ${e instanceof Error ? e.message : String(e)}`
        );
    }

    if (config.useProxyWallet) {
        const funderAddress = config.prozyWalletAddress;
        cachedClient = new ClobClient(host, chainId, wallet, apiKeyCreds, 2, funderAddress);
    } else if (proxyClient && proxyAddress) {
        // Compare collateral availability and pick the better mode.
        // We prefer whichever reports a larger allowance, then larger balance.
        try {
            const [eoaBA, proxyBA] = await Promise.all([
                eoaClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
                proxyClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
            ]);

            const eoaBal = parseFloat(eoaBA.balance || "0");
            const eoaAllow = parseFloat(eoaBA.allowance || "0");
            const proxyBal = parseFloat(proxyBA.balance || "0");
            const proxyAllow = parseFloat(proxyBA.allowance || "0");

            const pickProxy =
                proxyAllow > eoaAllow || (proxyAllow === eoaAllow && proxyBal > eoaBal);

            if (pickProxy) {
                logger.info(
                    `Using proxy wallet mode (auto-detected): funder=${proxyAddress} ` +
                        `(balance=${(proxyBal / 1e6).toFixed(6)}, allowance=${(proxyAllow / 1e6).toFixed(6)})`
                );
                cachedClient = proxyClient;
            } else {
                cachedClient = eoaClient;
            }
        } catch {
            // If detection calls fail, fall back to EOA mode.
            cachedClient = eoaClient;
        }
    } else {
        cachedClient = eoaClient;
    }

    cachedConfig = { chainId, host };

    return cachedClient;
}
