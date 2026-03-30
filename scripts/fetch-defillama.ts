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

const fetchProtocol = async (slug: string): Promise<DefillamaProtocol> => {
  const res = await fetch(`https://api.llama.fi/protocol/${slug}`);
  if (!res.ok) throw new Error(`DefiLlama error for ${slug}: ${res.status}`);
  return res.json() as Promise<DefillamaProtocol>;
};

const isValidChain = (chain: string): boolean => !chain.includes("-") && chain !== "staking" && chain !== "pool2";

export const fetchAndStoreDefillamaData = async () => {
  const now = new Date().toISOString();

  const results = await Promise.all(
    DEFILLAMA_PROTOCOLS.map(async (protocol) => {
      console.log(`Fetching DefiLlama data for ${protocol}...`);
      const data = await fetchProtocol(protocol);

      const chainEntries = Object.entries(data.currentChainTvls).filter(([chain]) => isValidChain(chain));

      // Store per-chain current TVL
      await Promise.all(
        chainEntries.map(([chain, tvl]) => db.insert(defillamaSnapshots).values({ protocol, chain, tvlUsd: tvl, timestamp: now })),
      );

      // Store total
      const totalTvl = chainEntries.reduce((sum, [, tvl]) => sum + tvl, 0);
      await db.insert(defillamaSnapshots).values({ protocol, chain: "total", tvlUsd: totalTvl, timestamp: now });

      console.log(`  ${protocol}: $${(totalTvl / 1e6).toFixed(1)}M total`);
      return chainEntries.length + 1; // per-chain + total
    }),
  );

  const totalStored = results.reduce((sum, n) => sum + n, 0);
  console.log(`Stored ${totalStored} DefiLlama snapshots`);
  return { stored: totalStored };
};

if (import.meta.main) {
  const result = await fetchAndStoreDefillamaData();
  console.log("Done:", result);
}
