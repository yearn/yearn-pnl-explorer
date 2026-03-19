/**
 * Fetch vault harvest reports from Kong GraphQL API.
 * Uses `vaultReports` query per vault to get per-harvest gain/loss in USD.
 * When Kong fails to price gains (gainUsd=0 but gain>0), we compute USD
 * using the vault's asset token price (TVL / totalAssets).
 */
import { db, vaults, vaultSnapshots, strategyReports } from "@yearn-tvl/db";
import { KONG_API_URL } from "@yearn-tvl/shared";
import { eq, desc } from "drizzle-orm";

interface KongVaultReport {
  strategy: string;
  gain: string | null;
  gainUsd: number | null;
  loss: string | null;
  lossUsd: number | null;
  totalGainUsd: number | null;
  totalLossUsd: number | null;
  blockTime: string;
  blockNumber: number;
  transactionHash: string;
}

// Cap per-report gainUsd — Kong occasionally returns corrupted values (e.g. OHM-FRAXBP $4T)
const MAX_GAIN_PER_REPORT = 500_000;

const REPORTS_QUERY = `
  query($chainId: Int!, $address: String!) {
    vaultReports(chainId: $chainId, address: $address) {
      strategy
      gain
      gainUsd
      loss
      lossUsd
      totalGainUsd
      totalLossUsd
      blockTime
      blockNumber
      transactionHash
    }
  }
`;

const fetchVaultReports = async (chainId: number, address: string): Promise<KongVaultReport[]> => {
  const res = await fetch(KONG_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: REPORTS_QUERY,
      variables: { chainId, address },
    }),
  });

  if (!res.ok) throw new Error(`Kong API error: ${res.status}`);
  const json = (await res.json()) as { data?: { vaultReports: KongVaultReport[] }; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    console.warn(`  Kong GraphQL errors for ${address}: ${json.errors[0].message}`);
  }
  return json.data?.vaultReports || [];
};

const getActiveVaults = async () => {
  return db
    .select({
      id: vaults.id,
      address: vaults.address,
      chainId: vaults.chainId,
      name: vaults.name,
      category: vaults.category,
      assetDecimals: vaults.assetDecimals,
    })
    .from(vaults)
    .where(eq(vaults.isRetired, false));
};

/** Compute token price in USD from latest vault snapshot: TVL / (totalAssets / 10^decimals) */
const getTokenPrice = async (vaultId: number, decimals: number): Promise<number> => {
  const [snap] = await db
    .select({ tvlUsd: vaultSnapshots.tvlUsd, totalAssets: vaultSnapshots.totalAssets })
    .from(vaultSnapshots)
    .where(eq(vaultSnapshots.vaultId, vaultId))
    .orderBy(desc(vaultSnapshots.id))
    .limit(1);

  if (!snap?.tvlUsd || !snap?.totalAssets) return 0;
  const totalAssets = Number(snap.totalAssets);
  if (totalAssets === 0) return 0;
  return snap.tvlUsd / (totalAssets / 10 ** decimals);
};

/** Convert raw token gain to USD using vault's token price */
const rawGainToUsd = (rawGain: string | null, decimals: number, tokenPrice: number): number => {
  if (!rawGain || rawGain === "0") return 0;
  try {
    const gain = Number(BigInt(rawGain)) / 10 ** decimals;
    return gain * tokenPrice;
  } catch {
    return 0;
  }
};

/** Compute the final gainUsd for a report, repricing via token price if Kong returned 0 */
const resolveGainUsd = (
  report: KongVaultReport,
  decimals: number,
  tokenPrice: number | null,
): { gainUsd: number | null; repriced: boolean } => {
  const kongGain = report.gainUsd;

  // If Kong provided a valid price, use it (unless corrupted)
  if (kongGain && kongGain !== 0) {
    return { gainUsd: kongGain > MAX_GAIN_PER_REPORT ? 0 : kongGain, repriced: false };
  }

  // Try repricing from raw gain x token price
  if (report.gain && report.gain !== "0" && tokenPrice && tokenPrice > 0) {
    const computed = rawGainToUsd(report.gain, decimals, tokenPrice);
    if (computed > 0 && computed <= MAX_GAIN_PER_REPORT) {
      return { gainUsd: computed, repriced: true };
    }
  }

  return { gainUsd: kongGain ?? null, repriced: false };
};

export const fetchAndStoreReports = async () => {
  console.log("Fetching vault harvest reports from Kong...");

  const activeVaults = await getActiveVaults();
  console.log(`Found ${activeVaults.length} active vaults\n`);

  let totalReports = 0;
  let totalGainUsd = 0;
  let repricedCount = 0;
  let repricedUsd = 0;
  const byChain: Record<number, { vaults: number; reports: number; gain: number }> = {};

  for (const vault of activeVaults) {
    try {
      const reports = await fetchVaultReports(vault.chainId, vault.address);
      if (reports.length === 0) continue;

      const now = new Date().toISOString();
      const decimals = vault.assetDecimals || 18;

      // Check existing reports to avoid duplicates
      const existing = await db
        .select({ hash: strategyReports.transactionHash })
        .from(strategyReports)
        .where(eq(strategyReports.vaultId, vault.id));
      const existingHashes = new Set(existing.map((e) => e.hash));

      // Lazily compute token price only if needed (some report has gainUsd=0 but gain>0)
      const needsRepricing = reports.some(
        (r) => !existingHashes.has(r.transactionHash) && !(r.gainUsd) && r.gain && r.gain !== "0",
      );
      const tokenPrice = needsRepricing ? await getTokenPrice(vault.id, decimals) : null;

      let newCount = 0;
      let vaultGain = 0;

      for (const r of reports) {
        if (existingHashes.has(r.transactionHash)) continue;

        const { gainUsd, repriced } = resolveGainUsd(r, decimals, tokenPrice);
        if (repriced && gainUsd) {
          repricedCount++;
          repricedUsd += gainUsd;
        }

        await db.insert(strategyReports).values({
          vaultId: vault.id,
          strategyAddress: r.strategy || "",
          gain: r.gain,
          gainUsd,
          lossUsd: r.lossUsd,
          totalGainUsd: r.totalGainUsd,
          totalLossUsd: r.totalLossUsd,
          blockTime: r.blockTime ? Number(r.blockTime) : null,
          blockNumber: r.blockNumber,
          transactionHash: r.transactionHash,
          timestamp: now,
        });
        newCount++;
        vaultGain += gainUsd || 0;
      }

      totalReports += newCount;
      totalGainUsd += vaultGain;

      if (!byChain[vault.chainId]) byChain[vault.chainId] = { vaults: 0, reports: 0, gain: 0 };
      byChain[vault.chainId].vaults++;
      byChain[vault.chainId].reports += newCount;
      byChain[vault.chainId].gain += vaultGain;

      if (newCount > 0) {
        process.stdout.write(`  ${vault.name?.slice(0, 30) || vault.address.slice(0, 10)}: ${newCount} reports, $${(vaultGain / 1e3).toFixed(1)}K gains\n`);
      }
    } catch (err) {
      console.warn(`  Failed ${vault.address.slice(0, 10)} chain=${vault.chainId}: ${(err as Error).message}`);
    }
  }

  console.log(`\nStored ${totalReports} reports, $${(totalGainUsd / 1e6).toFixed(2)}M total gains`);
  if (repricedCount > 0) {
    console.log(`Repriced ${repricedCount} reports (Kong had gainUsd=0), added $${(repricedUsd / 1e6).toFixed(2)}M`);
  }
  for (const [chainId, data] of Object.entries(byChain).sort((a, b) => b[1].gain - a[1].gain)) {
    console.log(`  Chain ${chainId}: ${data.vaults} vaults, ${data.reports} reports, $${(data.gain / 1e6).toFixed(2)}M gains`);
  }

  return { totalReports, totalGainUsd, repricedCount, repricedUsd };
};

if (import.meta.main) {
  const result = await fetchAndStoreReports();
  console.log("Done:", result);
}
