/**
 * Detect strategy→vault overlaps that aren't caught by auto-detection.
 * Reads on-chain to check if strategy contracts hold shares of known Yearn vaults.
 *
 * Run manually: bun run scripts/detect-overlaps.ts
 * Output: candidates to add to STRATEGY_OVERLAP_REGISTRY in packages/shared/src/strategy-overlaps.ts
 */

import { db, strategies, strategyDebts, vaults } from "@yearn-tvl/db";
import { groupBy } from "@yearn-tvl/shared";
import { desc, eq } from "drizzle-orm";
import { type Address, createPublicClient, defineChain, http, parseAbi } from "viem";
import { arbitrum, base, fantom, gnosis, mainnet, optimism, polygon } from "viem/chains";

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const katana = defineChain({
  id: 747474,
  name: "Katana",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const hyperliquid = defineChain({
  id: 999,
  name: "Hyperliquid",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const chains: Record<number, { chain: any; rpcEnv: string }> = {
  1: { chain: mainnet, rpcEnv: "RPC_URI_FOR_1" },
  10: { chain: optimism, rpcEnv: "RPC_URI_FOR_10" },
  137: { chain: polygon, rpcEnv: "RPC_URI_FOR_137" },
  250: { chain: fantom, rpcEnv: "RPC_URI_FOR_250" },
  8453: { chain: base, rpcEnv: "RPC_URI_FOR_8453" },
  42161: { chain: arbitrum, rpcEnv: "RPC_URI_FOR_42161" },
  100: { chain: gnosis, rpcEnv: "RPC_URI_FOR_100" },
  747474: { chain: katana, rpcEnv: "RPC_URI_FOR_747474" },
  999: { chain: hyperliquid, rpcEnv: "RPC_URI_FOR_999" },
};

const getClient = (chainId: number) => {
  const cfg = chains[chainId];
  if (!cfg) return null;
  const rpc = process.env[cfg.rpcEnv] || (chainId === 1 ? process.env.ETH_RPC_URL : undefined);
  if (!rpc) return null;
  return createPublicClient({ chain: cfg.chain, transport: http(rpc) });
};

const main = async () => {
  // Get all vault addresses as potential "target vaults"
  const allVaults = await db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      isRetired: vaults.isRetired,
    })
    .from(vaults);

  const vaultAddressSet = new Map(allVaults.map((v) => [`${v.chainId}:${v.address.toLowerCase()}`, v]));

  // Get all strategies with their latest debt
  const allStrategies = await db
    .select({
      id: strategies.id,
      address: strategies.address,
      chainId: strategies.chainId,
      name: strategies.name,
      vaultId: strategies.vaultId,
    })
    .from(strategies);

  // Filter to strategies not already matching a vault address (those are auto-detected)
  const nonVaultStrategies = allStrategies.filter((s) => !vaultAddressSet.has(`${s.chainId}:${s.address.toLowerCase()}`));

  console.log(`Checking ${nonVaultStrategies.length} strategies for vault share holdings...\n`);

  const byChain = groupBy(nonVaultStrategies, (s) => s.chainId);

  const candidates: Array<{
    strategyAddress: string;
    strategyName: string | null;
    chainId: number;
    targetVaultAddress: string;
    targetVaultName: string | null;
    debtUsd: number;
    balance: bigint;
  }> = [];

  await [...byChain].reduce(async (prevChain, [chainId, chainStrategies]) => {
    await prevChain;
    const client = getClient(chainId);
    if (!client) {
      console.log(`Skipping chain ${chainId} — no RPC configured`);
      return;
    }

    const chainVaults = allVaults.filter((v) => v.chainId === chainId && !v.isRetired);
    console.log(`Chain ${chainId}: checking ${chainStrategies.length} strategies against ${chainVaults.length} vaults...`);

    // For each strategy, check if it holds shares of any vault on the same chain
    // Batch in groups to avoid overwhelming the RPC
    const BATCH = 20;
    const batches = Array.from({ length: Math.ceil(chainStrategies.length / BATCH) }, (_, i) =>
      chainStrategies.slice(i * BATCH, (i + 1) * BATCH),
    );

    await batches.reduce(async (prevBatch, batch) => {
      await prevBatch;
      await Promise.all(
        batch.map(async (strat) => {
          // Get latest debt to filter out zero-debt strategies
          const [latestDebt] = await db
            .select()
            .from(strategyDebts)
            .where(eq(strategyDebts.strategyId, strat.id))
            .orderBy(desc(strategyDebts.id))
            .limit(1);

          if (!latestDebt?.currentDebtUsd || latestDebt.currentDebtUsd < 10000) return;

          const debtUsd = latestDebt.currentDebtUsd;

          // Check balanceOf on each vault's token (the vault IS the ERC20)
          await Promise.all(
            chainVaults.map(async (vault) => {
              try {
                const balance = await client.readContract({
                  address: vault.address as Address,
                  abi: ERC20_ABI,
                  functionName: "balanceOf",
                  args: [strat.address as Address],
                });

                if (balance > 0n) {
                  candidates.push({
                    strategyAddress: strat.address,
                    strategyName: strat.name,
                    chainId,
                    targetVaultAddress: vault.address,
                    targetVaultName: vault.name,
                    debtUsd,
                    balance,
                  });
                }
              } catch {
                // Not all addresses are ERC20s — skip
              }
            }),
          );
        }),
      );
    }, Promise.resolve());
  }, Promise.resolve());

  if (candidates.length === 0) {
    console.log("\nNo new overlap candidates found.");
    return;
  }

  console.log(`\n=== ${candidates.length} overlap candidates found ===\n`);
  candidates
    .sort((a, b) => b.debtUsd - a.debtUsd)
    .forEach((c) => {
      console.log(`  Strategy: ${c.strategyAddress} (${c.strategyName || "unnamed"})`);
      console.log(`  Chain: ${c.chainId}`);
      console.log(`  → Holds shares of: ${c.targetVaultAddress} (${c.targetVaultName || "unnamed"})`);
      console.log(`  Debt: $${(c.debtUsd / 1e6).toFixed(2)}M  Balance: ${c.balance}`);
      console.log();
    });

  console.log("Add to STRATEGY_OVERLAP_REGISTRY in packages/shared/src/strategy-overlaps.ts:");
  candidates.forEach((c) => {
    console.log(`  {`);
    console.log(`    strategyAddress: "${c.strategyAddress}",`);
    console.log(`    chainId: ${c.chainId},`);
    console.log(`    targetVaultAddress: "${c.targetVaultAddress}",`);
    console.log(`    label: "${c.strategyName || "unknown"} → ${c.targetVaultName || "unknown"}",`);
    console.log(`  },`);
  });
};

main().catch(console.error);
