/**
 * Fetch all Yearn vaults from Kong GraphQL API and persist to DB.
 * Categories: v2 (apiVersion 0.4.x) and v3 (v3=true). Curation vaults are NOT in Kong.
 */
import { db, vaults, vaultSnapshots, strategies, strategyDebts, feeConfigs } from "@yearn-tvl/db";
import { KONG_API_URL, IGNORED_VAULTS, fetchCurrentPrices } from "@yearn-tvl/shared";
import type { KongVault } from "@yearn-tvl/shared";
import { eq, and } from "drizzle-orm";
import { priceViaSugarOracle } from "./lib/velo-oracle.js";

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

const classifyCategory = (vault: KongVault): "v2" | "v3" =>
  vault.v3 ? "v3" : "v2";

const isIgnored = (address: string, chainId: number): boolean =>
  IGNORED_VAULTS.some(
    (v) => v.address.toLowerCase() === address.toLowerCase() && v.chainId === chainId
  );

const fetchKongVaults = async (): Promise<KongVault[]> => {
  const res = await fetch(KONG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: VAULTS_QUERY }),
  });

  if (!res.ok) throw new Error(`Kong API error: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { data?: { vaults: KongVault[] }; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Kong GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  if (!json.data?.vaults) {
    throw new Error("Kong API returned no vault data");
  }
  return json.data.vaults;
};

const upsertVault = async (kongVault: KongVault): Promise<number> => {
  const now = new Date().toISOString();
  const category = classifyCategory(kongVault);

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
};

const upsertSnapshot = async (vaultId: number, kongVault: KongVault) => {
  const now = new Date().toISOString();
  await db.insert(vaultSnapshots).values({
    vaultId,
    tvlUsd: kongVault.tvl?.close ?? 0,
    totalAssets: kongVault.totalAssets,
    totalIdle: kongVault.totalIdle,
    timestamp: now,
  });
};

const upsertStrategiesAndDebts = async (vaultId: number, kongVault: KongVault) => {
  const now = new Date().toISOString();

  if (!kongVault.debts?.length) return;

  for (const debt of kongVault.debts) {
    const existing = await db.query.strategies.findFirst({
      where: and(
        eq(strategies.address, debt.strategy),
        eq(strategies.vaultId, vaultId)
      ),
    });

    const strategyId = existing
      ? existing.id
      : (await db
          .insert(strategies)
          .values({ address: debt.strategy, vaultId, chainId: kongVault.chainId })
          .returning({ id: strategies.id }))[0].id;

    await db.insert(strategyDebts).values({
      strategyId,
      vaultId,
      currentDebt: debt.currentDebt,
      currentDebtUsd: debt.currentDebtUsd,
      maxDebt: debt.maxDebt,
      timestamp: now,
    });
  }
};

const upsertFees = async (vaultId: number, kongVault: KongVault) => {
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
};

/**
 * Fallback pricing for vaults where Kong returns tvl.close = 0 but totalAssets > 0.
 * Fetches current token prices from DefiLlama and computes TVL = totalAssets / 10^decimals * price.
 */
const priceMissingTvl = async (zeroTvlVaults: { vaultId: number; kongVault: KongVault }[]) => {
  if (zeroTvlVaults.length === 0) return 0;

  const priceable = zeroTvlVaults.filter((v) => v.kongVault.asset?.address);
  if (priceable.length === 0) return 0;

  const prices = await fetchCurrentPrices(
    priceable.map((v) => ({ chainId: v.kongVault.chainId, address: v.kongVault.asset!.address })),
  );

  let fixed = 0;
  for (const vault of priceable) {
    const price = prices.get(vault.kongVault.asset!.address.toLowerCase());
    if (!price || price <= 0) continue;

    const decimals = vault.kongVault.asset!.decimals;
    const totalAssets = BigInt(vault.kongVault.totalAssets || "0");
    if (totalAssets === 0n) continue;

    const tvlUsd = Number(totalAssets) / 10 ** decimals * price;
    if (tvlUsd <= 0) continue;

    const latestSnapshot = await db.query.vaultSnapshots.findFirst({
      where: eq(vaultSnapshots.vaultId, vault.vaultId),
      orderBy: (s, { desc }) => [desc(s.id)],
    });

    if (latestSnapshot) {
      await db
        .update(vaultSnapshots)
        .set({ tvlUsd })
        .where(eq(vaultSnapshots.id, latestSnapshot.id));
      console.log(`  Priced ${vault.kongVault.name} (${vault.kongVault.chainId}): $${tvlUsd.toFixed(0)}`);
      fixed++;
    }
  }

  return fixed;
};

/**
 * Fallback 2: Use Velodrome/Aerodrome Sugar Oracle for LP tokens on Optimism/Base
 * that DefiLlama can't price.
 */
const priceViaSugarOracleFallback = async (
  veloVaults: { vaultId: number; kongVault: KongVault }[],
) => {
  const byChain = veloVaults.reduce((acc, v) => {
    const chain = v.kongVault.chainId;
    const arr = acc.get(chain) ?? [];
    arr.push(v);
    return acc.set(chain, arr);
  }, new Map<number, typeof veloVaults>());

  let fixed = 0;
  for (const [chainId, chainVaults] of byChain) {
    // Only try vaults whose latest snapshot is still 0
    const toPrice: typeof chainVaults = [];
    for (const v of chainVaults) {
      const snap = await db.query.vaultSnapshots.findFirst({
        where: eq(vaultSnapshots.vaultId, v.vaultId),
        orderBy: (s, { desc }) => [desc(s.id)],
      });
      if (snap && (!snap.tvlUsd || snap.tvlUsd === 0)) {
        toPrice.push(v);
      }
    }
    if (toPrice.length === 0) continue;

    const assetAddresses = toPrice.map((v) => v.kongVault.asset?.address).filter(Boolean) as string[];
    const prices = await priceViaSugarOracle(chainId, assetAddresses);

    for (const v of toPrice) {
      const assetAddr = v.kongVault.asset?.address?.toLowerCase();
      if (!assetAddr) continue;
      const price = prices.get(assetAddr);
      if (!price || price <= 0) continue;

      const decimals = v.kongVault.asset.decimals;
      const totalAssets = BigInt(v.kongVault.totalAssets || "0");
      if (totalAssets === 0n) continue;

      const tvlUsd = Number(totalAssets) / 10 ** decimals * price;
      if (tvlUsd <= 0) continue;

      const snap = await db.query.vaultSnapshots.findFirst({
        where: eq(vaultSnapshots.vaultId, v.vaultId),
        orderBy: (s, { desc }) => [desc(s.id)],
      });
      if (snap) {
        await db.update(vaultSnapshots).set({ tvlUsd }).where(eq(vaultSnapshots.id, snap.id));
        console.log(`  Priced ${v.kongVault.name} (${chainId}): $${tvlUsd.toFixed(0)}`);
        fixed++;
      }
    }
  }
  return fixed;
};

export const fetchAndStoreKongData = async () => {
  console.log("Fetching vaults from Kong API...");
  const kongVaults = await fetchKongVaults();
  console.log(`Received ${kongVaults.length} vaults from Kong`);

  const activeVaults = kongVaults.filter((kv) => !isIgnored(kv.address, kv.chainId));
  const skipped = kongVaults.length - activeVaults.length;
  const zeroTvlVaults: { vaultId: number; kongVault: KongVault }[] = [];

  for (const kv of activeVaults) {
    const vaultId = await upsertVault(kv);
    await upsertSnapshot(vaultId, kv);
    await upsertStrategiesAndDebts(vaultId, kv);
    await upsertFees(vaultId, kv);

    const tvl = kv.tvl?.close ?? 0;
    const totalAssets = BigInt(kv.totalAssets || "0");
    if (tvl === 0 && totalAssets > 0n) {
      zeroTvlVaults.push({ vaultId, kongVault: kv });
    }
  }

  const stored = activeVaults.length;
  console.log(`Stored ${stored} vaults, skipped ${skipped} ignored`);

  if (zeroTvlVaults.length > 0) {
    console.log(`\nFallback 1 (DefiLlama) for ${zeroTvlVaults.length} vaults with 0 TVL...`);
    const fixed = await priceMissingTvl(zeroTvlVaults);
    console.log(`Priced ${fixed}/${zeroTvlVaults.length} vaults via DefiLlama`);
  }

  const stillZero = zeroTvlVaults.filter((v) =>
    v.kongVault.chainId === 10 || v.kongVault.chainId === 8453,
  );
  if (stillZero.length > 0) {
    console.log(`\nFallback 2 (Sugar Oracle) for ${stillZero.length} Optimism/Base vaults...`);
    const fixed = await priceViaSugarOracleFallback(stillZero);
    console.log(`Priced ${fixed}/${stillZero.length} vaults via Sugar Oracle`);
  }

  return { stored, skipped, total: kongVaults.length };
};

// Run directly
if (import.meta.main) {
  const result = await fetchAndStoreKongData();
  console.log("Done:", result);
}
