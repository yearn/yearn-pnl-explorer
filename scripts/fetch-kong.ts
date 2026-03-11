/**
 * Fetch all Yearn vaults from Kong GraphQL API and persist to DB.
 * Categories: v2 (apiVersion 0.4.x) and v3 (v3=true). Curation vaults are NOT in Kong.
 */
import { db, vaults, vaultSnapshots, strategies, strategyDebts, feeConfigs } from "@yearn-tvl/db";
import { KONG_API_URL, IGNORED_VAULTS } from "@yearn-tvl/shared";
import type { KongVault } from "@yearn-tvl/shared";
import { eq, and } from "drizzle-orm";

const VAULTS_QUERY = `
  query {
    vaults(yearn: true) {
      address
      name
      chainId
      apiVersion
      v3
      yearn
      vaultType
      tvl { close blockTime }
      totalAssets
      totalIdle
      asset { address symbol decimals }
      debts { strategy currentDebt currentDebtUsd maxDebt }
      fees { managementFee performanceFee }
      meta { isRetired }
      strategies
    }
  }
`;

function classifyCategory(vault: KongVault): "v2" | "v3" {
  if (vault.v3) return "v3";
  return "v2";
}

function isIgnored(address: string, chainId: number): boolean {
  return IGNORED_VAULTS.some(
    (v) => v.address.toLowerCase() === address.toLowerCase() && v.chainId === chainId
  );
}

async function fetchKongVaults(): Promise<KongVault[]> {
  const res = await fetch(KONG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: VAULTS_QUERY }),
  });

  if (!res.ok) throw new Error(`Kong API error: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data: { vaults: KongVault[] } };
  return json.data.vaults;
}

async function upsertVault(kongVault: KongVault): Promise<number> {
  const now = new Date().toISOString();
  const category = classifyCategory(kongVault);

  // Check if vault already exists
  const existing = await db.query.vaults.findFirst({
    where: and(
      eq(vaults.address, kongVault.address),
      eq(vaults.chainId, kongVault.chainId)
    ),
  });

  if (existing) {
    await db
      .update(vaults)
      .set({
        name: kongVault.name,
        apiVersion: kongVault.apiVersion,
        v3: kongVault.v3,
        vaultType: kongVault.vaultType,
        yearn: kongVault.yearn,
        assetAddress: kongVault.asset?.address,
        assetSymbol: kongVault.asset?.symbol,
        assetDecimals: kongVault.asset?.decimals,
        isRetired: kongVault.meta?.isRetired ?? false,
        category,
        updatedAt: now,
      })
      .where(eq(vaults.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(vaults)
    .values({
      address: kongVault.address,
      chainId: kongVault.chainId,
      name: kongVault.name,
      apiVersion: kongVault.apiVersion,
      v3: kongVault.v3,
      vaultType: kongVault.vaultType,
      yearn: kongVault.yearn,
      assetAddress: kongVault.asset?.address,
      assetSymbol: kongVault.asset?.symbol,
      assetDecimals: kongVault.asset?.decimals,
      isRetired: kongVault.meta?.isRetired ?? false,
      category,
      source: "kong",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: vaults.id });

  return inserted.id;
}

async function upsertSnapshot(vaultId: number, kongVault: KongVault) {
  const now = new Date().toISOString();
  await db.insert(vaultSnapshots).values({
    vaultId,
    tvlUsd: kongVault.tvl?.close ?? 0,
    totalAssets: kongVault.totalAssets,
    totalIdle: kongVault.totalIdle,
    timestamp: now,
  });
}

async function upsertStrategiesAndDebts(vaultId: number, kongVault: KongVault) {
  const now = new Date().toISOString();

  if (!kongVault.debts?.length) return;

  for (const debt of kongVault.debts) {
    // Upsert strategy
    let strategy = await db.query.strategies.findFirst({
      where: and(
        eq(strategies.address, debt.strategy),
        eq(strategies.vaultId, vaultId)
      ),
    });

    let strategyId: number;
    if (strategy) {
      strategyId = strategy.id;
    } else {
      const [inserted] = await db
        .insert(strategies)
        .values({
          address: debt.strategy,
          vaultId,
          chainId: kongVault.chainId,
        })
        .returning({ id: strategies.id });
      strategyId = inserted.id;
    }

    // Insert debt snapshot
    await db.insert(strategyDebts).values({
      strategyId,
      vaultId,
      currentDebt: debt.currentDebt,
      currentDebtUsd: debt.currentDebtUsd,
      maxDebt: debt.maxDebt,
      timestamp: now,
    });
  }
}

async function upsertFees(vaultId: number, kongVault: KongVault) {
  // V2 vaults don't have fees in Kong — use conservative defaults (10% perf, 0% mgmt)
  // Most V2 vaults are 1000/0 on-chain. fetch-v2-fees.ts reads exact on-chain rates.
  const category = classifyCategory(kongVault);
  const perfFee = kongVault.fees?.performanceFee ?? (category === "v2" ? 1000 : 0);
  const mgmtFee = kongVault.fees?.managementFee ?? 0;

  if (perfFee === 0 && mgmtFee === 0) return;

  const existing = await db.query.feeConfigs.findFirst({
    where: eq(feeConfigs.vaultId, vaultId),
  });

  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(feeConfigs)
      .set({
        managementFee: mgmtFee,
        performanceFee: perfFee,
        updatedAt: now,
      })
      .where(eq(feeConfigs.id, existing.id));
  } else {
    await db.insert(feeConfigs).values({
      vaultId,
      managementFee: mgmtFee,
      performanceFee: perfFee,
      updatedAt: now,
    });
  }
}

export async function fetchAndStoreKongData() {
  console.log("Fetching vaults from Kong API...");
  const kongVaults = await fetchKongVaults();
  console.log(`Received ${kongVaults.length} vaults from Kong`);

  let stored = 0;
  let skipped = 0;

  for (const kv of kongVaults) {
    if (isIgnored(kv.address, kv.chainId)) {
      skipped++;
      continue;
    }

    const vaultId = await upsertVault(kv);
    await upsertSnapshot(vaultId, kv);
    await upsertStrategiesAndDebts(vaultId, kv);
    await upsertFees(vaultId, kv);
    stored++;
  }

  console.log(`Stored ${stored} vaults, skipped ${skipped} ignored`);
  return { stored, skipped, total: kongVaults.length };
}

// Run directly
if (import.meta.main) {
  const result = await fetchAndStoreKongData();
  console.log("Done:", result);
}
