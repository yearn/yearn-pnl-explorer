/**
 * Fetch depositor data from Kong GraphQL API transfers endpoint.
 * Builds per-vault depositor maps from mint/burn transfers and upserts to DB.
 * Note: Kong transfers are limited to ~100 results per query with no pagination,
 * and mainly work for Ethereum V2 vaults.
 */
import { db, vaults, depositors } from "@yearn-tvl/db";
import { eq, and, sql } from "drizzle-orm";
import { KONG_API_URL } from "@yearn-tvl/shared";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

interface KongTransfer {
  sender: string;
  receiver: string;
  valueUsd: number;
  blockTime: string;
  transactionHash: string;
}

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

async function fetchTransfers(chainId: number, vaultAddress: string): Promise<KongTransfer[]> {
  const res = await fetch(KONG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: TRANSFERS_QUERY,
      variables: { chainId, address: vaultAddress },
    }),
  });

  if (!res.ok) {
    console.warn(`  Kong API error for ${vaultAddress}: ${res.status}`);
    return [];
  }

  const json = (await res.json()) as { data?: { transfers?: KongTransfer[] }; errors?: unknown[] };
  if (json.errors) {
    console.warn(`  GraphQL errors for ${vaultAddress}:`, json.errors);
    return [];
  }

  return json.data?.transfers ?? [];
}

function buildDepositorMap(transfers: KongTransfer[]): Map<string, DepositorEntry> {
  const map = new Map<string, DepositorEntry>();

  for (const t of transfers) {
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
  }

  return map;
}

function blockTimeToIso(blockTime: string): string {
  const ts = Number(blockTime);
  if (!Number.isNaN(ts) && ts > 0) {
    return new Date(ts * 1000).toISOString();
  }
  // Already ISO or some other format — return as-is
  return blockTime;
}

async function upsertDepositors(
  vaultId: number,
  chainId: number,
  depositorMap: Map<string, DepositorEntry>
): Promise<number> {
  let count = 0;

  for (const entry of depositorMap.values()) {
    const existing = await db.query.depositors.findFirst({
      where: and(
        eq(depositors.address, entry.address),
        eq(depositors.vaultId, vaultId)
      ),
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

    count++;
  }

  return count;
}

export async function fetchAndStoreDepositors() {
  // Get active (non-retired) vaults, focusing on chain 1 where transfers work
  const activeVaults = await db.query.vaults.findMany({
    where: and(
      eq(vaults.isRetired, false),
      eq(vaults.chainId, 1)
    ),
  });

  console.log(`Found ${activeVaults.length} active Ethereum vaults to process`);

  let totalDepositors = 0;
  let vaultsWithData = 0;
  const perVaultCounts: Array<{ name: string; address: string; count: number }> = [];

  for (const vault of activeVaults) {
    const transfers = await fetchTransfers(vault.chainId, vault.address);

    if (transfers.length === 0) {
      continue;
    }

    const depositorMap = buildDepositorMap(transfers);

    if (depositorMap.size === 0) {
      continue;
    }

    const count = await upsertDepositors(vault.id, vault.chainId, depositorMap);
    totalDepositors += count;
    vaultsWithData++;
    perVaultCounts.push({ name: vault.name ?? vault.address, address: vault.address, count });

    console.log(`  ${vault.name ?? vault.address.slice(0, 10)}: ${transfers.length} transfers -> ${count} depositors`);

    // Small delay to avoid hammering the API
    await new Promise((r) => setTimeout(r, 100));
  }

  // Print summary
  console.log("\n--- Summary ---");
  console.log(`Vaults processed with transfer data: ${vaultsWithData}/${activeVaults.length}`);
  console.log(`Total unique depositors stored: ${totalDepositors}`);

  if (perVaultCounts.length > 0) {
    console.log("\nPer-vault depositor counts:");
    const sorted = perVaultCounts.sort((a, b) => b.count - a.count);
    for (const v of sorted) {
      console.log(`  ${v.name} (${v.address.slice(0, 10)}...): ${v.count} depositors`);
    }
  }

  return { totalDepositors, vaultsWithData, totalVaults: activeVaults.length };
}

// Run directly
if (import.meta.main) {
  const result = await fetchAndStoreDepositors();
  console.log("\nDone:", result);
}
