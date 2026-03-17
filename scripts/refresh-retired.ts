/**
 * Refresh TVL for retired vaults by reading totalAssets() on-chain and pricing via DL.
 * Kong stops updating retired vaults, so their TVL snapshots go stale.
 * DL reads on-chain regardless of retirement status — this script does the same.
 *
 * Usage: bun run scripts/refresh-retired.ts [--chain 250] [--min-assets 1000]
 */
import { createPublicClient, http, formatUnits, type Chain, type Address } from "viem";
import { mainnet, optimism, polygon, base, arbitrum } from "viem/chains";
import { db, vaults, vaultSnapshots } from "@yearn-tvl/db";
import { eq, and, sql } from "drizzle-orm";
import { CHAIN_PREFIXES } from "@yearn-tvl/shared";

const fantom: Chain = {
  id: 250,
  name: "Fantom",
  nativeCurrency: { name: "FTM", symbol: "FTM", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ftm.tools"] } },
};

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet, 10: optimism, 137: polygon, 250: fantom, 8453: base, 42161: arbitrum,
};

const TOTAL_ASSETS_ABI = [
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

// Parse CLI args
const args = process.argv.slice(2);
const chainFilter = args.includes("--chain") ? Number(args[args.indexOf("--chain") + 1]) : undefined;
const minAssets = args.includes("--min-assets") ? Number(args[args.indexOf("--min-assets") + 1]) : 0;

const main = async () => {
  // Find retired vaults with non-zero totalAssets in their latest snapshot
  const retiredVaults = db.all<{
    id: number; address: string; chainId: number; name: string;
    assetAddress: string; assetSymbol: string; assetDecimals: number;
    snapshotId: number; oldTvlUsd: number; oldTotalAssets: string;
  }>(sql`
    SELECT v.id, v.address, v.chain_id as chainId, v.name,
           v.asset_address as assetAddress, v.asset_symbol as assetSymbol,
           v.asset_decimals as assetDecimals,
           s.id as snapshotId, s.tvl_usd as oldTvlUsd, s.total_assets as oldTotalAssets
    FROM vaults v
    JOIN vault_snapshots s ON s.vault_id = v.id
    WHERE v.is_retired = 1
      AND s.id IN (SELECT MAX(id) FROM vault_snapshots GROUP BY vault_id)
      AND CAST(s.total_assets AS REAL) > ${minAssets}
      ${chainFilter ? sql`AND v.chain_id = ${chainFilter}` : sql``}
    ORDER BY s.tvl_usd DESC
  `);

  console.log(`Found ${retiredVaults.length} retired vaults with assets${chainFilter ? ` on chain ${chainFilter}` : ""}`);

  // Group by chain for RPC efficiency
  const byChain = new Map<number, typeof retiredVaults>();
  for (const v of retiredVaults) {
    const arr = byChain.get(v.chainId) ?? [];
    arr.push(v);
    byChain.set(v.chainId, arr);
  }

  let updated = 0;
  let totalNewTvl = 0;

  for (const [chainId, chainVaults] of byChain) {
    const chain = CHAIN_MAP[chainId];
    const rpcUrl = process.env[`RPC_URI_FOR_${chainId}`] || process.env.ETH_RPC_URL;

    if (!chain || !rpcUrl) {
      console.log(`  Skipping chain ${chainId}: no chain config or RPC`);
      continue;
    }

    console.log(`\n  Chain ${chainId} (${chain.name}): ${chainVaults.length} vaults`);
    const client = createPublicClient({ chain, transport: http(rpcUrl) });

    // Read totalAssets on-chain for each vault
    const onChainData: { vault: typeof chainVaults[0]; totalAssets: bigint }[] = [];

    for (const vault of chainVaults) {
      try {
        const totalAssets = await client.readContract({
          address: vault.address as Address,
          abi: TOTAL_ASSETS_ABI,
          functionName: "totalAssets",
        });
        onChainData.push({ vault, totalAssets });
      } catch (err) {
        console.log(`    Failed to read ${vault.name}: ${(err as Error).message.slice(0, 60)}`);
      }
    }

    // Price underlying tokens via DL
    const prefix = CHAIN_PREFIXES[chainId];
    if (!prefix) {
      console.log(`    No DL price prefix for chain ${chainId}, using stablecoin fallback`);
    }

    const uniqueAssets = [...new Set(onChainData.map((d) => d.vault.assetAddress).filter(Boolean))];
    let prices: Record<string, { price: number }> = {};

    if (prefix && uniqueAssets.length > 0) {
      const coinKeys = uniqueAssets.map((a) => `${prefix}:${a}`).join(",");
      try {
        const res = await fetch(`https://coins.llama.fi/prices/current/${coinKeys}`);
        if (res.ok) {
          const data = (await res.json()) as { coins: Record<string, { price: number }> };
          prices = data.coins;
        }
      } catch {
        console.log(`    Failed to fetch DL prices`);
      }
    }

    // Update snapshots
    const now = new Date().toISOString();
    for (const { vault, totalAssets } of onChainData) {
      const decimals = vault.assetDecimals || 18;

      // Price lookup
      let tvlUsd = 0;
      const priceKey = prefix ? `${prefix}:${vault.assetAddress}` : null;
      const priceInfo = priceKey ? prices[priceKey] : null;

      if (priceInfo && priceInfo.price > 0) {
        tvlUsd = Number(totalAssets) / 10 ** decimals * priceInfo.price;
      } else {
        // Stablecoin fallback
        const stables = ["USDC", "USDT", "DAI", "FRAX", "LUSD", "MIM", "DOLA"];
        if (stables.includes(vault.assetSymbol)) {
          tvlUsd = Number(formatUnits(totalAssets, decimals));
        }
      }

      const oldTvl = vault.oldTvlUsd || 0;
      const changed = Math.abs(tvlUsd - oldTvl) > 1;

      if (changed) {
        // Insert new snapshot with fresh data
        await db.insert(vaultSnapshots).values({
          vaultId: vault.id,
          tvlUsd,
          totalAssets: totalAssets.toString(),
          timestamp: now,
        });

        const delta = tvlUsd - oldTvl;
        console.log(`    ${vault.name}: $${(oldTvl / 1e3).toFixed(1)}K → $${(tvlUsd / 1e3).toFixed(1)}K (${delta > 0 ? "+" : ""}$${(delta / 1e3).toFixed(1)}K)`);
        updated++;
      }

      totalNewTvl += tvlUsd;
    }
  }

  console.log(`\nUpdated ${updated} vault snapshots`);
  console.log(`Total retired vault TVL (refreshed): $${(totalNewTvl / 1e6).toFixed(2)}M`);
};

main().catch(console.error);
