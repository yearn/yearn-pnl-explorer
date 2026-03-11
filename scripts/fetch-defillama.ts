/**
 * Fetch Yearn TVL data from DefiLlama API and persist snapshots.
 * Tracks both yearn-finance and yearn-curating protocols.
 */
import { db, defillamaSnapshots } from "@yearn-tvl/db";
import { DEFILLAMA_PROTOCOLS } from "@yearn-tvl/shared";

interface DefillamaChainTvl {
  [chain: string]: number;
}

interface DefillamaProtocol {
  name: string;
  currentChainTvls: DefillamaChainTvl;
  tvl: Array<{ date: number; totalLiquidityUSD: number }>;
  chainTvls: Record<string, { tvl: Array<{ date: number; totalLiquidityUSD: number }> }>;
}

async function fetchProtocol(slug: string): Promise<DefillamaProtocol> {
  const res = await fetch(`https://api.llama.fi/protocol/${slug}`);
  if (!res.ok) throw new Error(`DefiLlama error for ${slug}: ${res.status}`);
  return res.json() as Promise<DefillamaProtocol>;
}

export async function fetchAndStoreDefillamaData() {
  const now = new Date().toISOString();
  let totalStored = 0;

  for (const protocol of DEFILLAMA_PROTOCOLS) {
    console.log(`Fetching DefiLlama data for ${protocol}...`);
    const data = await fetchProtocol(protocol);

    // Store per-chain current TVL
    for (const [chain, tvl] of Object.entries(data.currentChainTvls)) {
      // Skip staking/pool2/borrowed variants
      if (chain.includes("-") || chain === "staking" || chain === "pool2") continue;

      await db.insert(defillamaSnapshots).values({
        protocol,
        chain,
        tvlUsd: tvl,
        timestamp: now,
      });
      totalStored++;
    }

    // Store total
    const totalTvl = Object.entries(data.currentChainTvls)
      .filter(([chain]) => !chain.includes("-") && chain !== "staking" && chain !== "pool2")
      .reduce((sum, [, tvl]) => sum + tvl, 0);

    await db.insert(defillamaSnapshots).values({
      protocol,
      chain: "total",
      tvlUsd: totalTvl,
      timestamp: now,
    });
    totalStored++;

    console.log(`  ${protocol}: $${(totalTvl / 1e6).toFixed(1)}M total`);
  }

  console.log(`Stored ${totalStored} DefiLlama snapshots`);
  return { stored: totalStored };
}

if (import.meta.main) {
  const result = await fetchAndStoreDefillamaData();
  console.log("Done:", result);
}
