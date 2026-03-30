/**
 * Fetch vault harvest reports from Kong GraphQL API.
 * Uses `vaultReports` query per vault to get per-harvest gain/loss in USD.
 * When Kong fails to price gains (gainUsd=0 but gain>0), we compute USD
 * using the vault's asset token price (TVL / totalAssets).
 */
import { db, strategyReports, vaultSnapshots, vaults } from "@yearn-tvl/db";
import type { KongReportREST } from "@yearn-tvl/shared";
import { KONG_API_URL, KongReportRESTSchema, retryWithBackoff, validateArray } from "@yearn-tvl/shared";
import { desc, eq } from "drizzle-orm";

type KongVaultReport = KongReportREST;

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
  return retryWithBackoff(
    async () => {
      const res = await fetch(KONG_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: REPORTS_QUERY,
          variables: { chainId, address },
        }),
      });

      if (!res.ok) throw new Error(`Kong API error: ${res.status}`);
      const json = (await res.json()) as { data?: { vaultReports: unknown[] }; errors?: Array<{ message: string }> };
      if (json.errors?.length) {
        console.warn(`  Kong GraphQL errors for ${address}: ${json.errors[0].message}`);
      }
      const raw = json.data?.vaultReports || [];
      return validateArray(raw, KongReportRESTSchema, "KongReport");
    },
    { label: `fetchReports(${address.slice(0, 10)})` },
  );
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

  const { totalReports, totalGainUsd, repricedCount, repricedUsd, byChain } = await activeVaults.reduce(
    async (accPromise, vault) => {
      const acc = await accPromise;
      try {
        const reports = await fetchVaultReports(vault.chainId, vault.address);
        if (reports.length === 0) return acc;

        const now = new Date().toISOString();
        const decimals = vault.assetDecimals || 18;

        // Check existing reports to avoid duplicates
        const existing = await db
          .select({ hash: strategyReports.transactionHash })
          .from(strategyReports)
          .where(eq(strategyReports.vaultId, vault.id));
        const existingHashes = new Set(existing.map((e) => e.hash));

        // Lazily compute token price only if needed (some report has gainUsd=0 but gain>0)
        const needsRepricing = reports.some((r) => !existingHashes.has(r.transactionHash) && !r.gainUsd && r.gain && r.gain !== "0");
        const tokenPrice = needsRepricing ? await getTokenPrice(vault.id, decimals) : null;

        const { newCount, vaultGain, vaultRepricedCount, vaultRepricedUsd } = await reports.reduce(
          async (rAccPromise, r) => {
            const rAcc = await rAccPromise;
            if (existingHashes.has(r.transactionHash)) return rAcc;

            const { gainUsd, repriced } = resolveGainUsd(r, decimals, tokenPrice);

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

            return {
              newCount: rAcc.newCount + 1,
              vaultGain: rAcc.vaultGain + (gainUsd || 0),
              vaultRepricedCount: rAcc.vaultRepricedCount + (repriced && gainUsd ? 1 : 0),
              vaultRepricedUsd: rAcc.vaultRepricedUsd + (repriced && gainUsd ? gainUsd : 0),
            };
          },
          Promise.resolve({ newCount: 0, vaultGain: 0, vaultRepricedCount: 0, vaultRepricedUsd: 0 }),
        );

        const chainEntry = acc.byChain[vault.chainId] || { vaults: 0, reports: 0, gain: 0 };

        if (newCount > 0) {
          process.stdout.write(
            `  ${vault.name?.slice(0, 30) || vault.address.slice(0, 10)}: ${newCount} reports, $${(vaultGain / 1e3).toFixed(1)}K gains\n`,
          );
        }

        return {
          totalReports: acc.totalReports + newCount,
          totalGainUsd: acc.totalGainUsd + vaultGain,
          repricedCount: acc.repricedCount + vaultRepricedCount,
          repricedUsd: acc.repricedUsd + vaultRepricedUsd,
          byChain: {
            ...acc.byChain,
            [vault.chainId]: {
              vaults: chainEntry.vaults + 1,
              reports: chainEntry.reports + newCount,
              gain: chainEntry.gain + vaultGain,
            },
          },
        };
      } catch (err) {
        console.warn(`  Failed ${vault.address.slice(0, 10)} chain=${vault.chainId}: ${(err as Error).message}`);
        return acc;
      }
    },
    Promise.resolve({
      totalReports: 0,
      totalGainUsd: 0,
      repricedCount: 0,
      repricedUsd: 0,
      byChain: {} as Record<number, { vaults: number; reports: number; gain: number }>,
    }),
  );

  console.log(`\nStored ${totalReports} reports, $${(totalGainUsd / 1e6).toFixed(2)}M total gains`);
  if (repricedCount > 0) {
    console.log(`Repriced ${repricedCount} reports (Kong had gainUsd=0), added $${(repricedUsd / 1e6).toFixed(2)}M`);
  }
  Object.entries(byChain)
    .sort((a, b) => b[1].gain - a[1].gain)
    .forEach(([chainId, data]) => {
      console.log(`  Chain ${chainId}: ${data.vaults} vaults, ${data.reports} reports, $${(data.gain / 1e6).toFixed(2)}M gains`);
    });

  return { totalReports, totalGainUsd, repricedCount, repricedUsd };
};

if (import.meta.main) {
  const result = await fetchAndStoreReports();
  console.log("Done:", result);
}
