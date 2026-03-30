/**
 * Read actual V2 vault fee rates from on-chain.
 * Kong doesn't return fees for V2 vaults, so fetch-kong.ts uses conservative defaults.
 * This script reads the real managementFee() and performanceFee() values and updates fee_configs.
 */

import { db, feeConfigs, vaults } from "@yearn-tvl/db";
import { and, eq } from "drizzle-orm";
import { createPublicClient, http, parseAbi } from "viem";
import { arbitrum, base, mainnet, optimism, polygon } from "viem/chains";

const abi = parseAbi(["function managementFee() view returns (uint256)", "function performanceFee() view returns (uint256)"]);

const chains: Record<number, { chain: any; rpcEnv: string }> = {
  1: { chain: mainnet, rpcEnv: "RPC_URI_FOR_1" },
  10: { chain: optimism, rpcEnv: "RPC_URI_FOR_10" },
  137: { chain: polygon, rpcEnv: "RPC_URI_FOR_137" },
  8453: { chain: base, rpcEnv: "RPC_URI_FOR_8453" },
  42161: { chain: arbitrum, rpcEnv: "RPC_URI_FOR_42161" },
};

export const fetchV2Fees = async () => {
  const v2Vaults = await db.query.vaults.findMany({
    where: and(eq(vaults.category, "v2"), eq(vaults.isRetired, false)),
  });

  console.log(`Reading on-chain fees for ${v2Vaults.length} V2 vaults...\n`);

  // Group by chain
  const byChain = v2Vaults.reduce((acc, v) => {
    const arr = acc.get(v.chainId) ?? [];
    arr.push(v);
    return acc.set(v.chainId, arr);
  }, new Map<number, typeof v2Vaults>());

  const { updated, errors, rateDist } = await [...byChain].reduce(
    async (accP, [chainId, chainVaults]) => {
      const acc = await accP;
      const config = chains[chainId];
      if (!config) {
        console.log(`  Chain ${chainId}: no config, skipping ${chainVaults.length} vaults`);
        return acc;
      }

      const rpc = process.env[config.rpcEnv] || process.env.ETH_RPC_URL;
      if (!rpc) {
        console.log(`  Chain ${chainId}: no RPC, skipping`);
        return acc;
      }

      const client = createPublicClient({ chain: config.chain, transport: http(rpc) });

      const chainResult = await chainVaults.reduce(
        async (innerAccP, v) => {
          const innerAcc = await innerAccP;
          try {
            const [mgmt, perf] = await Promise.all([
              client.readContract({ address: v.address as `0x${string}`, abi, functionName: "managementFee" }),
              client.readContract({ address: v.address as `0x${string}`, abi, functionName: "performanceFee" }),
            ]);

            const perfFee = Number(perf);
            const mgmtFee = Number(mgmt);
            const key = `perf=${perfFee} mgmt=${mgmtFee}`;
            const newRateDist = { ...innerAcc.rateDist, [key]: (innerAcc.rateDist[key] || 0) + 1 };

            // Update fee config
            const existing = await db.query.feeConfigs.findFirst({
              where: eq(feeConfigs.vaultId, v.id),
            });

            const now = new Date().toISOString();
            if (existing) {
              if (existing.performanceFee !== perfFee || existing.managementFee !== mgmtFee) {
                await db
                  .update(feeConfigs)
                  .set({
                    performanceFee: perfFee,
                    managementFee: mgmtFee,
                    updatedAt: now,
                  })
                  .where(eq(feeConfigs.id, existing.id));
                return { updated: innerAcc.updated + 1, errors: innerAcc.errors, rateDist: newRateDist };
              }
            } else {
              await db.insert(feeConfigs).values({
                vaultId: v.id,
                performanceFee: perfFee,
                managementFee: mgmtFee,
                updatedAt: now,
              });
              return { updated: innerAcc.updated + 1, errors: innerAcc.errors, rateDist: newRateDist };
            }
            return { ...innerAcc, rateDist: newRateDist };
          } catch {
            return { ...innerAcc, errors: innerAcc.errors + 1 };
          }
        },
        Promise.resolve({ updated: acc.updated, errors: acc.errors, rateDist: acc.rateDist }),
      );

      console.log(`  Chain ${chainId}: ${chainVaults.length} vaults checked`);
      return chainResult;
    },
    Promise.resolve({ updated: 0, errors: 0, rateDist: {} as Record<string, number> }),
  );

  console.log(`\nUpdated ${updated} fee configs, ${errors} errors`);
  console.log("Rate distribution:");
  Object.entries(rateDist)
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, count]) => {
      console.log(`  ${key}: ${count} vaults`);
    });

  return { updated, errors };
};

if (import.meta.main) {
  const result = await fetchV2Fees();
  console.log("Done:", result);
}
