/**
 * Profitability analysis service.
 * Computes per-vault fee yield, fee capture rate, trends, and strategic quadrant classification.
 * Fee yield = annualized fee revenue / average TVL (like APY for the protocol).
 */
import { db, vaults, feeConfigs, strategyReports } from "@yearn-tvl/db";
import { eq, and, sql, gte } from "drizzle-orm";
import type { VaultCategory } from "@yearn-tvl/shared";
import { CHAIN_NAMES, toMap, reduceBy } from "@yearn-tvl/shared";
import { getLatestSnapshots, latestFeeConfigIds, isAnalysisEligible } from "./queries.js";

type PricingConfidence = "high" | "medium" | "low";
type Trend = "improving" | "declining" | "stable" | "insufficient_data";
type Quadrant = "high_tvl_high_yield" | "high_tvl_low_yield" | "low_tvl_high_yield" | "low_tvl_low_yield";

interface VaultProfitability {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  tvlUsd: number;
  annualizedFeeRevenue: number;
  feeYield: number; // annualized fee revenue / TVL as a ratio (0.05 = 5%)
  feeCapture: number; // total fees / total gains as a ratio
  gainYield: number; // annualized gains / TVL
  trend: Trend;
  trendDelta: number; // fee yield change between periods
  pricingConfidence: PricingConfidence;
  reportCount: number;
  avgHarvestFrequencyDays: number;
  performanceFee: number;
  managementFee: number;
  totalGainUsd: number;
  totalFeeRevenue: number;
  quadrant: Quadrant;
  // Period-specific data for trend
  currentPeriodFeeYield: number;
  previousPeriodFeeYield: number;
}

interface ProfitabilitySummary {
  protocolFeeYield: number;
  feeCaptureRate: number;
  medianVaultFeeYield: number;
  totalAnnualizedFees: number;
  totalTvl: number;
  vaultCount: number;
  lastUpdated: string;
  vaults: VaultProfitability[];
  byChain: Array<{
    chain: string;
    chainId: number;
    tvl: number;
    fees: number;
    feeYield: number;
    vaultCount: number;
  }>;
  byCategory: Array<{
    category: string;
    tvl: number;
    fees: number;
    feeYield: number;
    vaultCount: number;
  }>;
  quadrants: {
    high_tvl_high_yield: VaultProfitability[];
    high_tvl_low_yield: VaultProfitability[];
    low_tvl_high_yield: VaultProfitability[];
    low_tvl_low_yield: VaultProfitability[];
  };
  dataQuality: {
    highConfidenceCount: number;
    mediumConfidenceCount: number;
    lowConfidenceCount: number;
    reportsWithPricingSource: number;
    totalReports: number;
  };
}

interface TrendResult {
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: VaultCategory;
    tvlUsd: number;
    currentPeriodFeeYield: number;
    previousPeriodFeeYield: number;
    delta: number;
    trend: Trend;
    currentPeriodGains: number;
    previousPeriodGains: number;
  }>;
  period: string;
}


/** Determine pricing confidence from the mix of pricing sources in a vault's reports.
 * Reports without an explicit pricingSource came from Kong API (gainUsd at report time),
 * which is equivalent to high-quality pricing — they just predate the tracking column. */
const getPricingConfidence = (sources: Record<string, number>): PricingConfidence => {
  const total = Object.values(sources).reduce((a, b) => a + b, 0);
  if (total === 0) return "medium"; // No reports at all

  // Treat "unknown" (NULL pricingSource) as Kong-sourced — original API values
  const highQuality = (sources["kong"] || 0) + (sources["defillama_historical"] || 0) + (sources["unknown"] || 0);
  const ratio = highQuality / total;
  if (ratio >= 0.8) return "high";
  if (ratio >= 0.4) return "medium";
  return "low";
};

const classifyTrend = (reportCount: number, currentYield: number, previousYield: number): { trend: Trend; trendDelta: number } => {
  if (reportCount < 3) return { trend: "insufficient_data", trendDelta: 0 };
  const trendDelta = currentYield - previousYield;
  const threshold = 0.005; // 0.5% yield change
  const trend: Trend = trendDelta > threshold ? "improving" : trendDelta < -threshold ? "declining" : "stable";
  return { trend, trendDelta };
};

const classifyQuadrant = (tvlUsd: number, feeYield: number, medianTvl: number, medianYield: number): Quadrant => {
  const highTvl = tvlUsd >= medianTvl;
  const highYield = feeYield >= medianYield;
  if (highTvl && highYield) return "high_tvl_high_yield";
  if (highTvl) return "high_tvl_low_yield";
  if (highYield) return "low_tvl_high_yield";
  return "low_tvl_low_yield";
};

const MIN_ANNUALIZE_SPAN = 90 * 24 * 3600; // 90 days

const annualizeValue = (value: number, minTime: number | null, maxTime: number | null, minSpan: number = MIN_ANNUALIZE_SPAN): number => {
  if (!minTime || !maxTime || maxTime <= minTime) return value;
  const span = maxTime - minTime;
  if (span >= 365 * 24 * 3600) return value;
  if (span < minSpan) return value;
  return value * (365 * 24 * 3600 / span);
};

/** Get profitability analysis for all active vaults */
export const getProfitability = async (): Promise<ProfitabilitySummary> => {
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - 365 * 24 * 3600;
  const sixMonthsAgo = now - 182.5 * 24 * 3600;

  const snapshots = await getLatestSnapshots();

  // Build fee rate lookup (latest per vault)
  const latestFees = latestFeeConfigIds();
  const feeRates = await db
    .select({
      vaultId: feeConfigs.vaultId,
      performanceFee: feeConfigs.performanceFee,
      managementFee: feeConfigs.managementFee,
    })
    .from(feeConfigs)
    .innerJoin(latestFees, and(
      eq(feeConfigs.vaultId, latestFees.vaultId),
      eq(feeConfigs.id, latestFees.maxId),
    ));
  const rateMap = toMap(
    feeRates,
    (r) => r.vaultId,
    (r) => ({ performanceFee: r.performanceFee || 0, managementFee: r.managementFee || 0 }),
  );

  // Get report aggregates for all vaults — last 365 days
  const reportAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
      totalLoss: sql<number>`COALESCE(SUM(${strategyReports.lossUsd}), 0)`,
      count: sql<number>`COUNT(*)`,
      minBlockTime: sql<number>`MIN(${strategyReports.blockTime})`,
      maxBlockTime: sql<number>`MAX(${strategyReports.blockTime})`,
    })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, oneYearAgo))
    .groupBy(strategyReports.vaultId);

  const reportMap = toMap(reportAggs, (r) => r.vaultId, (r) => r);

  // Get pricing source breakdown per vault
  const pricingSources = await db
    .select({
      vaultId: strategyReports.vaultId,
      pricingSource: strategyReports.pricingSource,
      count: sql<number>`COUNT(*)`,
    })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, oneYearAgo))
    .groupBy(strategyReports.vaultId, strategyReports.pricingSource);

  const pricingMap = pricingSources.reduce((acc, r) => {
    const sources = acc.get(r.vaultId) || {};
    sources[r.pricingSource || "unknown"] = r.count;
    acc.set(r.vaultId, sources);
    return acc;
  }, new Map<number, Record<string, number>>());

  // Get current half (last 6 months) vs previous half (6-12 months ago) gains
  const currentHalfAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
    })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, sixMonthsAgo))
    .groupBy(strategyReports.vaultId);

  const currentHalfMap = toMap(currentHalfAggs, (r) => r.vaultId, (r) => r.totalGain);

  const previousHalfAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
    })
    .from(strategyReports)
    .where(and(
      gte(strategyReports.blockTime, oneYearAgo),
      sql`${strategyReports.blockTime} < ${sixMonthsAgo}`,
    ))
    .groupBy(strategyReports.vaultId);

  const previousHalfMap = toMap(previousHalfAggs, (r) => r.vaultId, (r) => r.totalGain);

  // Data quality stats
  const [totalReportsResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, oneYearAgo));
  const [reportsWithSourceResult] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(strategyReports)
    .where(and(
      gte(strategyReports.blockTime, oneYearAgo),
      sql`${strategyReports.pricingSource} IS NOT NULL`,
    ));

  // Latest fetch time for data freshness
  const [latestVault] = await db
    .select({ lastFetched: sql<string>`MAX(${vaults.updatedAt})` })
    .from(vaults);

  // Process each vault
  const vaultResults = snapshots
    .filter(({ vault, snapshot }) => isAnalysisEligible(vault, snapshot.tvlUsd ?? 0))
    .map(({ vault, snapshot }) => {
      const tvlUsd = snapshot.tvlUsd ?? 0;
      const rates = rateMap.get(vault.id) || { performanceFee: 0, managementFee: 0 };
      const reports = reportMap.get(vault.id);
      const totalGain = reports?.totalGain || 0;
      const reportCount = reports?.count || 0;

      // Performance fee revenue
      const perfRevenue = totalGain * (rates.performanceFee / 10000);

      // Management fee revenue (annualized from TVL)
      const mgmtRevenue = (() => {
        if (rates.managementFee <= 0 || tvlUsd <= 0 || !reports) return 0;
        const minTime = reports.minBlockTime || 0;
        const maxTime = reports.maxBlockTime || 0;
        if (maxTime <= minTime) return 0;
        const durationYears = (maxTime - minTime) / (365.25 * 24 * 3600);
        return tvlUsd * (rates.managementFee / 10000) * durationYears;
      })();

      const totalFeeRevenue = perfRevenue + mgmtRevenue;

      // Annualize: only extrapolate if we have at least 90 days of data
      const annualizedFees = (() => {
        if (!reports?.maxBlockTime || !reports?.minBlockTime) return totalFeeRevenue;
        const span = reports.maxBlockTime - reports.minBlockTime;
        if (span >= MIN_ANNUALIZE_SPAN && span < 365 * 24 * 3600) {
          return totalFeeRevenue * (365 * 24 * 3600 / span);
        }
        return totalFeeRevenue;
      })();

      const rawFeeYield = tvlUsd > 0 ? annualizedFees / tvlUsd : 0;
      const feeYield = Math.min(rawFeeYield, 5.0);
      const feeCapture = totalGain > 0 ? totalFeeRevenue / totalGain : 0;
      const annualizedGains = reports ? annualizeValue(totalGain, reports.minBlockTime, reports.maxBlockTime, MIN_ANNUALIZE_SPAN) : 0;
      const gainYield = tvlUsd > 0 ? annualizedGains / tvlUsd : 0;

      // Harvest frequency
      const avgHarvestFrequencyDays = reportCount > 1 && reports?.minBlockTime && reports?.maxBlockTime
        ? ((reports.maxBlockTime - reports.minBlockTime) / (reportCount - 1)) / 86400
        : 0;

      // Trend: compare current half fee yield vs previous half
      const currentGains = currentHalfMap.get(vault.id) || 0;
      const previousGains = previousHalfMap.get(vault.id) || 0;
      const currentAnnualized = currentGains * (rates.performanceFee / 10000) * 2;
      const previousAnnualized = previousGains * (rates.performanceFee / 10000) * 2;
      const currentPeriodFeeYield = tvlUsd > 0 ? currentAnnualized / tvlUsd : 0;
      const previousPeriodFeeYield = tvlUsd > 0 ? previousAnnualized / tvlUsd : 0;

      const { trend, trendDelta } = classifyTrend(reportCount, currentPeriodFeeYield, previousPeriodFeeYield);
      const pricingConfidence = getPricingConfidence(pricingMap.get(vault.id) || {});

      return {
        address: vault.address,
        chainId: vault.chainId,
        name: vault.name,
        category: vault.category as VaultCategory,
        tvlUsd,
        annualizedFeeRevenue: annualizedFees,
        feeYield,
        feeCapture,
        gainYield,
        trend,
        trendDelta,
        pricingConfidence,
        reportCount,
        avgHarvestFrequencyDays: Math.round(avgHarvestFrequencyDays * 10) / 10,
        performanceFee: rates.performanceFee,
        managementFee: rates.managementFee,
        totalGainUsd: totalGain,
        totalFeeRevenue,
        quadrant: "low_tvl_low_yield" as Quadrant, // placeholder, computed below
        currentPeriodFeeYield,
        previousPeriodFeeYield,
      };
    });

  // Compute quadrants using median TVL and median fee yield
  const tvls = vaultResults.map((v) => v.tvlUsd).sort((a, b) => a - b);
  const yields = vaultResults.filter((v) => v.feeYield > 0).map((v) => v.feeYield).sort((a, b) => a - b);
  const medianTvl = tvls.length > 0 ? tvls[Math.floor(tvls.length / 2)] : 0;
  const medianYield = yields.length > 0 ? yields[Math.floor(yields.length / 2)] : 0;

  // Assign quadrant to each vault and partition into groups
  const classified = vaultResults.map((v) => ({
    ...v,
    quadrant: classifyQuadrant(v.tvlUsd, v.feeYield, medianTvl, medianYield),
  }));

  const quadrants: ProfitabilitySummary["quadrants"] = {
    high_tvl_high_yield: classified.filter((v) => v.quadrant === "high_tvl_high_yield").sort((a, b) => b.tvlUsd - a.tvlUsd),
    high_tvl_low_yield: classified.filter((v) => v.quadrant === "high_tvl_low_yield").sort((a, b) => b.tvlUsd - a.tvlUsd),
    low_tvl_high_yield: classified.filter((v) => v.quadrant === "low_tvl_high_yield").sort((a, b) => b.tvlUsd - a.tvlUsd),
    low_tvl_low_yield: classified.filter((v) => v.quadrant === "low_tvl_low_yield").sort((a, b) => b.tvlUsd - a.tvlUsd),
  };

  // Aggregate by chain
  const chainAgg = reduceBy(
    classified,
    (v) => CHAIN_NAMES[v.chainId] || `Chain ${v.chainId}`,
    () => ({ chainId: 0, tvl: 0, fees: 0, vaultCount: 0 }),
    (acc, v) => ({ chainId: v.chainId, tvl: acc.tvl + v.tvlUsd, fees: acc.fees + v.annualizedFeeRevenue, vaultCount: acc.vaultCount + 1 }),
  );
  const byChain = Object.entries(chainAgg)
    .map(([chain, d]) => ({ chain, chainId: d.chainId, tvl: d.tvl, fees: d.fees, feeYield: d.tvl > 0 ? d.fees / d.tvl : 0, vaultCount: d.vaultCount }))
    .sort((a, b) => b.fees - a.fees);

  // Aggregate by category
  const catAgg = reduceBy(
    classified,
    (v) => v.category,
    () => ({ tvl: 0, fees: 0, vaultCount: 0 }),
    (acc, v) => ({ tvl: acc.tvl + v.tvlUsd, fees: acc.fees + v.annualizedFeeRevenue, vaultCount: acc.vaultCount + 1 }),
  );
  const byCategory = Object.entries(catAgg)
    .map(([category, d]) => ({ category, tvl: d.tvl, fees: d.fees, feeYield: d.tvl > 0 ? d.fees / d.tvl : 0, vaultCount: d.vaultCount }))
    .sort((a, b) => b.fees - a.fees);

  // Protocol-level metrics
  const totalTvl = classified.reduce((s, v) => s + v.tvlUsd, 0);
  const totalAnnualizedFees = classified.reduce((s, v) => s + v.annualizedFeeRevenue, 0);
  const totalGains = classified.reduce((s, v) => s + v.totalGainUsd, 0);
  const totalRawFees = classified.reduce((s, v) => s + v.totalFeeRevenue, 0);

  // Data quality
  const dataQualityCounts = classified.reduce(
    (acc, v) => ({
      high: acc.high + (v.pricingConfidence === "high" ? 1 : 0),
      medium: acc.medium + (v.pricingConfidence === "medium" ? 1 : 0),
      low: acc.low + (v.pricingConfidence === "low" ? 1 : 0),
    }),
    { high: 0, medium: 0, low: 0 },
  );

  return {
    protocolFeeYield: totalTvl > 0 ? totalAnnualizedFees / totalTvl : 0,
    feeCaptureRate: totalGains > 0 ? totalRawFees / totalGains : 0,
    medianVaultFeeYield: medianYield,
    totalAnnualizedFees,
    totalTvl,
    vaultCount: classified.length,
    lastUpdated: latestVault?.lastFetched || new Date().toISOString(),
    vaults: classified.sort((a, b) => b.annualizedFeeRevenue - a.annualizedFeeRevenue),
    byChain,
    byCategory,
    quadrants,
    dataQuality: {
      highConfidenceCount: dataQualityCounts.high,
      mediumConfidenceCount: dataQualityCounts.medium,
      lowConfidenceCount: dataQualityCounts.low,
      reportsWithPricingSource: reportsWithSourceResult?.count || 0,
      totalReports: totalReportsResult?.count || 0,
    },
  };
};

/** Get period-over-period trend analysis */
export const getProfitabilityTrends = async (periodDays: number = 30): Promise<TrendResult> => {
  const now = Math.floor(Date.now() / 1000);
  const currentStart = now - periodDays * 24 * 3600;
  const previousStart = now - 2 * periodDays * 24 * 3600;

  const snapshots = await getLatestSnapshots();

  const latestFees = latestFeeConfigIds();
  const feeRates = await db
    .select({ vaultId: feeConfigs.vaultId, performanceFee: feeConfigs.performanceFee })
    .from(feeConfigs)
    .innerJoin(latestFees, and(
      eq(feeConfigs.vaultId, latestFees.vaultId),
      eq(feeConfigs.id, latestFees.maxId),
    ));
  const rateMap = toMap(feeRates, (r) => r.vaultId, (r) => r.performanceFee || 0);

  const currentAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
    })
    .from(strategyReports)
    .where(gte(strategyReports.blockTime, currentStart))
    .groupBy(strategyReports.vaultId);
  const currentMap = toMap(currentAggs, (r) => r.vaultId, (r) => r.totalGain);

  const previousAggs = await db
    .select({
      vaultId: strategyReports.vaultId,
      totalGain: sql<number>`COALESCE(SUM(${strategyReports.gainUsd}), 0)`,
    })
    .from(strategyReports)
    .where(and(
      gte(strategyReports.blockTime, previousStart),
      sql`${strategyReports.blockTime} < ${currentStart}`,
    ))
    .groupBy(strategyReports.vaultId);
  const previousMap = toMap(previousAggs, (r) => r.vaultId, (r) => r.totalGain);

  const results = snapshots
    .filter(({ vault, snapshot }) => isAnalysisEligible(vault, snapshot.tvlUsd ?? 0))
    .map(({ vault, snapshot }) => {
      const tvlUsd = snapshot.tvlUsd ?? 0;
      const rate = rateMap.get(vault.id) || 0;
      const currentGains = currentMap.get(vault.id) || 0;
      const previousGains = previousMap.get(vault.id) || 0;

      const annualizationFactor = 365 / periodDays;
      const currentFeeYield = tvlUsd > 0 ? (currentGains * (rate / 10000) * annualizationFactor) / tvlUsd : 0;
      const previousFeeYield = tvlUsd > 0 ? (previousGains * (rate / 10000) * annualizationFactor) / tvlUsd : 0;
      const delta = currentFeeYield - previousFeeYield;

      const trend: Trend =
        currentGains === 0 && previousGains === 0 ? "insufficient_data"
        : delta > 0.005 ? "improving"
        : delta < -0.005 ? "declining"
        : "stable";

      return {
        address: vault.address,
        chainId: vault.chainId,
        name: vault.name,
        category: vault.category as VaultCategory,
        tvlUsd,
        currentPeriodFeeYield: currentFeeYield,
        previousPeriodFeeYield: previousFeeYield,
        delta,
        trend,
        currentPeriodGains: currentGains,
        previousPeriodGains: previousGains,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return { vaults: results, period: `${periodDays}d` };
};
