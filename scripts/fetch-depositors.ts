/**
 * Fetch depositor data from Kong GraphQL API transfers endpoint.
 * Builds per-vault depositor maps from mint/burn transfers and upserts to DB.
 * Note: Kong transfers are limited to ~100 results per query with no pagination,
 * and mainly work for Ethereum V2 vaults.
 */
import { db, depositors, vaults } from "@yearn-tvl/db";
import type { KongTransferREST } from "@yearn-tvl/shared";
import { KONG_API_URL, KongTransferRESTSchema, retryWithBackoff, validateArray } from "@yearn-tvl/shared";
import { and, eq } from "drizzle-orm";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type KongTransfer = KongTransferREST;

interface DepositorEntry {
  address: string;
  netUsd: number;
  firstSeen: string;
  lastSeen: string;
}

const TRANSFERS_QUERY = `
  query Transfers($chainId: Int!, $address: String!) {
    transfers(chainId: $chainId, address: $address) {
      sender
      receiver
      valueUsd
      blockTime
      transactionHash
    }
  }
`;

const fetchTransfers = async (chainId: number, vaultAddress: string): Promise<KongTransfer[]> => {
  try {
    return await retryWithBackoff(
      async () => {
        const res = await fetch(KONG_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: TRANSFERS_QUERY,
            variables: { chainId, address: vaultAddress },
          }),
        });

        if (!res.ok) throw new Error(`Kong API error: ${res.status}`);

        const json = (await res.json()) as { data?: { transfers?: unknown[] }; errors?: unknown[] };
        if (json.errors) {
          console.warn(`  GraphQL errors for ${vaultAddress}:`, json.errors);
          return [];
        }

        const raw = json.data?.transfers ?? [];
        return validateArray(raw, KongTransferRESTSchema, "KongTransfer");
      },
      { label: `fetchTransfers(${vaultAddress.slice(0, 10)})` },
    );
  } catch {
    return [];
  }
};

const buildDepositorMap = (transfers: KongTransfer[]): Map<string, DepositorEntry> => {
  return transfers.reduce((map, t) => {
    const valueUsd = t.valueUsd ?? 0;
    const blockTime = t.blockTime;

    // Mint (deposit): sender is zero address, receiver is depositor
    if (t.sender.toLowerCase() === ZERO_ADDRESS) {
      const addr = t.receiver.toLowerCase();
      const existing = map.get(addr);
      if (existing) {
        existing.netUsd += valueUsd;
        if (blockTime < existing.firstSeen) existing.firstSeen = blockTime;
        if (blockTime > existing.lastSeen) existing.lastSeen = blockTime;
      } else {
        map.set(addr, { address: addr, netUsd: valueUsd, firstSeen: blockTime, lastSeen: blockTime });
      }
    }

    // Burn (withdrawal): receiver is zero address, sender is withdrawer
    if (t.receiver.toLowerCase() === ZERO_ADDRESS) {
      const addr = t.sender.toLowerCase();
      const existing = map.get(addr);
      if (existing) {
        existing.netUsd -= valueUsd;
        if (blockTime < existing.firstSeen) existing.firstSeen = blockTime;
        if (blockTime > existing.lastSeen) existing.lastSeen = blockTime;
      } else {
        map.set(addr, { address: addr, netUsd: -valueUsd, firstSeen: blockTime, lastSeen: blockTime });
      }
    }

    return map;
  }, new Map<string, DepositorEntry>());
};

const blockTimeToIso = (blockTime: string): string => {
  const ts = Number(blockTime);
  if (!Number.isNaN(ts) && ts > 0) {
    return new Date(ts * 1000).toISOString();
  }
  // Already ISO or some other format — return as-is
  return blockTime;
};

const upsertDepositors = async (vaultId: number, chainId: number, depositorMap: Map<string, DepositorEntry>): Promise<number> => {
  return [...depositorMap.values()].reduce(async (accPromise, entry) => {
    const count = await accPromise;

    const existing = await db.query.depositors.findFirst({
      where: and(eq(depositors.address, entry.address), eq(depositors.vaultId, vaultId)),
    });

    const firstSeen = blockTimeToIso(entry.firstSeen);
    const lastSeen = blockTimeToIso(entry.lastSeen);

    if (existing) {
      await db
        .update(depositors)
        .set({
          balanceUsd: entry.netUsd,
          firstSeen,
          lastSeen,
        })
        .where(eq(depositors.id, existing.id));
    } else {
      await db.insert(depositors).values({
        address: entry.address,
        vaultId,
        chainId,
        balance: entry.netUsd.toString(),
        balanceUsd: entry.netUsd,
        firstSeen,
        lastSeen,
      });
    }

    return count + 1;
  }, Promise.resolve(0));
};

export const fetchAndStoreDepositors = async () => {
  // Get active (non-retired) vaults, focusing on chain 1 where transfers work
  const activeVaults = await db.query.vaults.findMany({
    where: and(eq(vaults.isRetired, false), eq(vaults.chainId, 1)),
  });

  console.log(`Found ${activeVaults.length} active Ethereum vaults to process`);

  const { totalDepositors, vaultsWithData, perVaultCounts } = await activeVaults.reduce(
    async (accPromise, vault) => {
      const acc = await accPromise;
      const transfers = await fetchTransfers(vault.chainId, vault.address);

      if (transfers.length === 0) {
        return acc;
      }

      const depositorMap = buildDepositorMap(transfers);

      if (depositorMap.size === 0) {
        return acc;
      }

      const count = await upsertDepositors(vault.id, vault.chainId, depositorMap);

      console.log(`  ${vault.name ?? vault.address.slice(0, 10)}: ${transfers.length} transfers -> ${count} depositors`);

      // Small delay to avoid hammering the API
      await new Promise((r) => setTimeout(r, 100));

      return {
        totalDepositors: acc.totalDepositors + count,
        vaultsWithData: acc.vaultsWithData + 1,
        perVaultCounts: [...acc.perVaultCounts, { name: vault.name ?? vault.address, address: vault.address, count }],
      };
    },
    Promise.resolve({
      totalDepositors: 0,
      vaultsWithData: 0,
      perVaultCounts: [] as Array<{ name: string; address: string; count: number }>,
    }),
  );

  // Print summary
  console.log("\n--- Summary ---");
  console.log(`Vaults processed with transfer data: ${vaultsWithData}/${activeVaults.length}`);
  console.log(`Total unique depositors stored: ${totalDepositors}`);

  if (perVaultCounts.length > 0) {
    console.log("\nPer-vault depositor counts:");
    perVaultCounts
      .sort((a, b) => b.count - a.count)
      .forEach((v) => {
        console.log(`  ${v.name} (${v.address.slice(0, 10)}...): ${v.count} depositors`);
      });
  }

  return { totalDepositors, vaultsWithData, totalVaults: activeVaults.length };
};

// Run directly
if (import.meta.main) {
  const result = await fetchAndStoreDepositors();
  console.log("\nDone:", result);
}
