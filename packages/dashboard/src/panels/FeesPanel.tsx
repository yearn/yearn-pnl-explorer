import type { FeeStackChain, FeeStackNode, FeeStackSummary } from "@yearn-tvl/shared";
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { DashboardContext } from "../App";
import { bpsPct, CHAIN_COLORS, CHAIN_SHORT, fmt, pctFmt, SkeletonCards, SkeletonChart, useFetch, usePagination, useSort } from "../hooks";

interface FeeSummary {
  totalFeeRevenue: number;
  performanceFeeRevenue: number;
  managementFeeRevenue: number;
  totalGains: number;
  totalLosses: number;
  vaultCount: number;
  reportCount: number;
  byChain: Record<string, { feeRevenue: number; gains: number; vaultCount: number }>;
}

interface FeeHistory {
  interval: string;
  buckets: Array<{
    period: string;
    gains: number;
    performanceFeeRevenue: number;
    managementFeeRevenue: number;
    reportCount: number;
  }>;
}

interface VaultFee {
  address: string;
  chainId: number;
  name: string | null;
  tvlUsd: number;
  totalFeeRevenue: number;
  performanceFeeRevenue: number;
  managementFeeRevenue: number;
  totalGainUsd: number;
  reportCount: number;
  performanceFee: number;
  managementFee: number;
}

type Trend = "improving" | "declining" | "stable" | "insufficient_data";
type PricingConfidence = "high" | "medium" | "low";
type Quadrant = "high_tvl_high_yield" | "high_tvl_low_yield" | "low_tvl_high_yield" | "low_tvl_low_yield";

interface VaultProfitability {
  address: string;
  chainId: number;
  name: string | null;
  category: string;
  tvlUsd: number;
  annualizedFeeRevenue: number;
  feeYield: number;
  feeCapture: number;
  gainYield: number;
  trend: Trend;
  trendDelta: number;
  pricingConfidence: PricingConfidence;
  reportCount: number;
  avgHarvestFrequencyDays: number;
  performanceFee: number;
  managementFee: number;
  totalGainUsd: number;
  totalFeeRevenue: number;
  quadrant: Quadrant;
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
  byChain: Array<{ chain: string; chainId: number; tvl: number; fees: number; feeYield: number; vaultCount: number }>;
  byCategory: Array<{ category: string; tvl: number; fees: number; feeYield: number; vaultCount: number }>;
  quadrants: Record<Quadrant, VaultProfitability[]>;
  dataQuality: {
    highConfidenceCount: number;
    mediumConfidenceCount: number;
    lowConfidenceCount: number;
    reportsWithPricingSource: number;
    totalReports: number;
  };
}

const QUADRANT_LABELS: Record<Quadrant, { label: string; color: string; desc: string }> = {
  high_tvl_high_yield: { label: "Cash Cows", color: "#0ecb81", desc: "Protect & maintain" },
  high_tvl_low_yield: { label: "Optimize", color: "#f0b90b", desc: "Improve yield or migrate" },
  low_tvl_high_yield: { label: "Scale Up", color: "#3b82f6", desc: "Drive more TVL" },
  low_tvl_low_yield: { label: "Review", color: "#848e9c", desc: "Consider retirement" },
};

function trendIcon(t: string | undefined) {
  if (t === "improving") return <span style={{ color: "var(--green)" }}>&#x25B2;</span>;
  if (t === "declining") return <span style={{ color: "var(--red)" }}>&#x25BC;</span>;
  if (t === "stable") return <span style={{ color: "var(--text-3)" }}>&#x25CF;</span>;
  return <span style={{ color: "var(--text-3)" }}>-</span>;
}

function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]?.payload) return null;
  const v = payload[0].payload;
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.7rem 0.85rem",
        fontSize: "0.78rem",
        lineHeight: 1.6,
        minWidth: 180,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)", fontSize: "0.82rem" }}>{v.name || v.address?.slice(0, 10)}</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: "var(--text-2)" }}>TVL</span>
        <span style={{ color: "var(--text)" }}>{fmt(v.tvlUsd)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: "var(--text-2)" }}>Fee Yield</span>
        <span style={{ color: "var(--accent)" }}>{pctFmt(v.feeYield)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
        <span style={{ color: "var(--text-2)" }}>Fees (ann.)</span>
        <span style={{ color: "var(--green)" }}>{fmt(v.annualizedFeeRevenue)}</span>
      </div>
    </div>
  );
}

/** Flatten tree to rows, filtering out dust (<$100) children */
function flattenTree(node: FeeStackNode, depth: number, isLast: boolean): Array<{ node: FeeStackNode; depth: number; isLast: boolean }> {
  const rows: Array<{ node: FeeStackNode; depth: number; isLast: boolean }> = [{ node, depth, isLast }];
  const visibleChildren = depth === 0 ? node.children : node.children.filter((c) => c.capitalUsd >= 100);
  visibleChildren.forEach((child, i) => {
    rows.push(...flattenTree(child, depth + 1, i === visibleChildren.length - 1));
  });
  return rows;
}

const TIME_PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "YTD", days: -1 },
  { label: "All", days: 0 },
] as const;

function getSinceTs(days: number): number | null {
  if (days === 0) return null;
  const now = new Date();
  if (days === -1) return Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
  return Math.floor((now.getTime() - days * 86_400_000) / 1000);
}

export function FeesPanel() {
  const { chainFilter, density, setLastFetchedAt } = useContext(DashboardContext);
  const [timePreset, setTimePreset] = useState(4); // default "All"

  const sinceTs = getSinceTs(TIME_PRESETS[timePreset]?.days ?? 0);
  const sinceQ = sinceTs != null ? `?since=${sinceTs}` : "";
  const { data: summary, loading: l1, fetchedAt } = useFetch<FeeSummary>(`/api/fees${sinceQ}`);
  const { data: history, loading: l2 } = useFetch<FeeHistory>("/api/fees/history?interval=monthly");
  const { data: vaultData, loading: l3 } = useFetch<{ count: number; vaults: VaultFee[] }>(`/api/fees/vaults${sinceQ}`);
  const { data: feeStack } = useFetch<FeeStackSummary>("/api/fees/stack");
  const { data: profData } = useFetch<ProfitabilitySummary>("/api/profitability");
  const stackSort = useSort("feeCaptured");
  const [expandedStack, setExpandedStack] = useState<number | null>(null);
  const [quadrantFilter, setQuadrantFilter] = useState<Quadrant | "all">("all");

  useEffect(() => {
    if (fetchedAt) setLastFetchedAt(fetchedAt);
  }, [fetchedAt, setLastFetchedAt]);

  // Filter history buckets client-side by time range (never before 2024-01)
  const filteredBuckets = useMemo(() => {
    if (!history) return [];
    const floor = new Date("2024-01-01");
    if (sinceTs == null) return history.buckets.filter((b) => new Date(`${b.period}-01`) >= floor);
    const sinceDate = new Date(Math.max(sinceTs * 1000, floor.getTime()));
    return history.buckets.filter((b) => new Date(`${b.period}-01`) >= sinceDate);
  }, [history, sinceTs]);

  // Build a lookup map for vault fees from the time-filtered vaultData
  const vaultFeeMap = useMemo(() => {
    if (!vaultData) return new Map<string, VaultFee>();
    return new Map(vaultData.vaults.map((v) => [`${v.address.toLowerCase()}-${v.chainId}`, v]));
  }, [vaultData, sinceQ]);

  // Build a lookup map for profitability trend data
  const profTrendMap = useMemo(() => {
    if (!profData) return new Map<string, string>();
    return new Map(profData.vaults.map((v) => [`${v.address.toLowerCase()}-${v.chainId}`, v.trend]));
  }, [profData]);

  const sortedStacks = useMemo(() => {
    if (!feeStack) return [];
    type ChainWithFee = FeeStackChain & { feeCaptured: number; trend: string | undefined };
    const withFees: ChainWithFee[] = feeStack.chains
      .filter((c) => chainFilter === "all" || String(c.root.vault.chainId) === chainFilter)
      .map((c) => {
        const key = `${c.root.vault.address.toLowerCase()}-${c.root.vault.chainId}`;
        const matchedVault = vaultFeeMap.get(key);
        const feeCaptured = matchedVault
          ? matchedVault.totalFeeRevenue
          : sinceTs != null
            ? 0
            : c.root.capitalUsd * (c.effectivePerfFee / 10000);
        return {
          ...c,
          feeCaptured,
          trend: profTrendMap.get(key),
        };
      });
    return stackSort.sorted(withFees, {
      name: (c) => c.root.vault.name || "",
      perfFee: (c) => c.root.perfFee,
      feeCaptured: (c) => c.feeCaptured,
      effective: (c) => c.effectivePerfFee,
    });
  }, [feeStack, vaultFeeMap, profTrendMap, stackSort.sortKey, stackSort.sortDir, sinceQ, chainFilter]);

  const stackPagination = usePagination(sortedStacks.length, 30);
  const pagedStacks = sortedStacks.slice(stackPagination.start, stackPagination.end);

  const scatterData = useMemo(() => {
    if (!profData) return [];
    const base = profData.vaults
      .filter((v) => v.feeYield > 0 && v.tvlUsd >= 1e4 && v.tvlUsd <= 1e8)
      .filter((v) => chainFilter === "all" || String(v.chainId) === chainFilter);
    const eligible = quadrantFilter !== "all" ? base.filter((v) => v.quadrant === quadrantFilter) : base;
    if (eligible.length < 4) return eligible.map((v) => ({ ...v, logTvl: Math.log10(v.tvlUsd) }));
    const yields = eligible.map((v) => v.feeYield).sort((a, b) => a - b);
    const q1 = yields[Math.floor(yields.length * 0.25)];
    const q3 = yields[Math.floor(yields.length * 0.75)];
    const iqr = q3 - q1;
    const upper = q3 + 1.5 * iqr;
    return eligible.filter((v) => v.feeYield <= upper).map((v) => ({ ...v, logTvl: Math.log10(v.tvlUsd) }));
  }, [profData, quadrantFilter, chainFilter]);

  const trendLine = useMemo(() => {
    if (scatterData.length < 5) return null;
    const n = scatterData.length;
    const { sumX, sumY, sumXY, sumX2, sumY2 } = scatterData.reduce(
      (acc, p) => ({
        sumX: acc.sumX + p.logTvl,
        sumY: acc.sumY + p.feeYield,
        sumXY: acc.sumXY + p.logTvl * p.feeYield,
        sumX2: acc.sumX2 + p.logTvl * p.logTvl,
        sumY2: acc.sumY2 + p.feeYield * p.feeYield,
      }),
      { sumX: 0, sumY: 0, sumXY: 0, sumX2: 0, sumY2: 0 },
    );
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const denomR = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const r2 = denomR === 0 ? 0 : ((n * sumXY - sumX * sumY) / denomR) ** 2;
    if (r2 < 0.01) return null;
    const xs = scatterData.map((p) => p.logTvl);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    return {
      points: [
        { logTvl: minX, feeYield: slope * minX + intercept },
        { logTvl: maxX, feeYield: slope * maxX + intercept },
      ],
      r2,
    };
  }, [scatterData]);

  // Only show skeletons on initial load, not when switching time ranges
  const hasData = summary && history && vaultData;
  if (!hasData && (l1 || l2 || l3))
    return (
      <>
        <SkeletonCards count={5} />
        <SkeletonChart />
      </>
    );
  if (!hasData) return null;

  return (
    <>
      {/* ---- Time Range Presets ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <span className="text-dim" style={{ fontSize: "0.75rem", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Time Range
        </span>
        <div className="time-presets" role="group" aria-label="Time range">
          {TIME_PRESETS.map((p, i) => (
            <button
              key={p.label}
              className={timePreset === i ? "active" : ""}
              onClick={() => setTimePreset(i)}
              aria-pressed={timePreset === i}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Metric Cards ---- */}
      <div className="metric-grid">
        <div className="metric metric-accent">
          <div className="label">Total Fee Revenue</div>
          <div className="value">{fmt(summary.totalFeeRevenue)}</div>
          <div className="sub">{summary.reportCount.toLocaleString()} harvest reports</div>
        </div>
        <div className="metric metric-green">
          <div className="label">Performance Fees</div>
          <div className="value text-green">{fmt(summary.performanceFeeRevenue)}</div>
          <div className="sub">From {fmt(summary.totalGains)} gains</div>
        </div>
        <div className="metric metric-blue">
          <div className="label">Management Fees</div>
          <div className="value text-blue">{fmt(summary.managementFeeRevenue)}</div>
          <div className="sub">AUM-based (estimated)</div>
        </div>
        <div className="metric metric-yellow">
          <div className="label">Total Gains</div>
          <div className="value text-yellow">{fmt(summary.totalGains)}</div>
          <div className="sub">{summary.reportCount.toLocaleString()} harvest reports</div>
        </div>
        <div className="metric">
          <div className="label">Report Count</div>
          <div className="value">{summary.reportCount.toLocaleString()}</div>
          <div className="sub">{summary.vaultCount} vaults with fees</div>
        </div>
      </div>

      {/* ---- Charts Row: Fee History + Scatter ---- */}
      <div className="row">
        <div className="card">
          <h2>Monthly Fee Revenue &amp; Gains</h2>
          <div className="chart-container" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredBuckets} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gradFees" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0ecb81" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#0ecb81" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradMgmt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f0b90b" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#f0b90b" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradGains" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="period"
                  tick={{ fill: "var(--text-3)", fontSize: 11 }}
                  interval={Math.max(0, Math.floor(filteredBuckets.length / 8) - 1)}
                  angle={-35}
                  textAnchor="end"
                  height={50}
                />
                <YAxis tick={{ fill: "var(--text-3)", fontSize: 11 }} tickFormatter={(v: number) => fmt(v, 0)} width={60} />
                <Tooltip
                  contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 }}
                  labelStyle={{ color: "var(--text)" }}
                  formatter={(value: number, name: string) => [
                    fmt(value, 2),
                    name === "performanceFeeRevenue" ? "Performance Fees" : name === "managementFeeRevenue" ? "Management Fees" : "Gains",
                  ]}
                  cursor={{ stroke: "rgba(46, 230, 182, 0.3)" }}
                />
                <Area type="monotone" dataKey="gains" stroke="#3b82f6" fill="url(#gradGains)" strokeWidth={2} name="gains" />
                <Area
                  type="monotone"
                  dataKey="performanceFeeRevenue"
                  stroke="#0ecb81"
                  fill="url(#gradFees)"
                  strokeWidth={2}
                  name="performanceFeeRevenue"
                />
                <Area
                  type="monotone"
                  dataKey="managementFeeRevenue"
                  stroke="#f0b90b"
                  fill="url(#gradMgmt)"
                  strokeWidth={2}
                  name="managementFeeRevenue"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <span className="sr-only">Area chart showing monthly fee revenue and gains over time.</span>
        </div>

        {/* ---- TVL vs Fee Yield Scatter ---- */}
        {profData && (
          <div className="card">
            <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              TVL vs Fee Yield
              {trendLine && <span style={{ fontSize: "0.75rem", color: "#f0b90b", fontWeight: 400 }}>R² = {trendLine.r2.toFixed(3)}</span>}
            </h2>
            <div className="quadrant-legend" role="group" aria-label="Quadrant filter">
              {Object.entries(QUADRANT_LABELS).map(([key, { label, color, desc }]) => {
                const count = profData.quadrants[key as Quadrant]?.length || 0;
                const isActive = quadrantFilter === key;
                return (
                  <span
                    key={key}
                    className="quadrant-tag"
                    role="button"
                    tabIndex={0}
                    aria-pressed={isActive}
                    style={{
                      borderColor: color,
                      color,
                      cursor: "pointer",
                      opacity: quadrantFilter === "all" || isActive ? 1 : 0.4,
                      background: isActive ? `${color}15` : undefined,
                    }}
                    onClick={() => setQuadrantFilter(quadrantFilter === key ? "all" : (key as Quadrant))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setQuadrantFilter(quadrantFilter === key ? "all" : (key as Quadrant));
                      }
                    }}
                  >
                    {label} ({count}) <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>{desc}</span>
                  </span>
                );
              })}
            </div>
            <div className="chart-container" style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ left: 20, right: 20, bottom: 24, top: 10 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    dataKey="logTvl"
                    name="TVL"
                    domain={[4, 8]}
                    ticks={[4, 5, 6, 7, 8]}
                    tickFormatter={(v: number) => fmt(10 ** v, 0)}
                    tick={{ fill: "var(--text-3)", fontSize: 11 }}
                    label={{ value: "TVL (log scale)", position: "bottom", fill: "var(--text-3)", fontSize: 11, offset: 6 }}
                    stroke="var(--border)"
                    allowDataOverflow
                  />
                  <YAxis
                    type="number"
                    dataKey="feeYield"
                    name="Fee Yield"
                    tickFormatter={(v) => pctFmt(v)}
                    tick={{ fill: "var(--text-3)", fontSize: 11 }}
                    label={{ value: "Fee Yield (ann.)", angle: -90, position: "insideLeft", fill: "var(--text-3)", fontSize: 11 }}
                    stroke="var(--border)"
                  />
                  <ZAxis type="number" dataKey="annualizedFeeRevenue" range={[30, 500]} name="Fees" />
                  <Tooltip content={<ScatterTooltip />} cursor={false} />
                  <Scatter data={scatterData}>
                    {scatterData.map((v, i) => {
                      const qColor = QUADRANT_LABELS[v.quadrant]?.color || "#848e9c";
                      return <Cell key={i} fill={qColor} fillOpacity={0.65} stroke={qColor} strokeWidth={1} />;
                    })}
                  </Scatter>
                  {trendLine && (
                    <Scatter
                      data={trendLine.points}
                      line={{ stroke: "#f0b90b", strokeWidth: 2, strokeDasharray: "6 3" }}
                      shape={() => <></>}
                      isAnimationActive={false}
                      legendType="none"
                    />
                  )}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <span className="sr-only">Scatter plot showing TVL vs fee yield for {scatterData.length} vaults.</span>
          </div>
        )}
      </div>

      {/* ---- Fee Analysis ---- */}
      {feeStack &&
        feeStack.chains.length > 0 &&
        (() => {
          const maxCap = Math.max(...sortedStacks.map((c) => c.root.capitalUsd), 1);
          return (
            <div className="card">
              <h2>Fee Analysis</h2>
              <div className="metric-grid" style={{ marginBottom: "1rem" }}>
                <div className="metric">
                  <div className="label">Max Depth</div>
                  <div className="value">{feeStack.maxDepth}</div>
                </div>
                <div className="metric">
                  <div className="label">Max Effective Fee</div>
                  <div className="value text-yellow">{bpsPct(feeStack.maxEffectivePerfFee)}</div>
                </div>
                <div className="metric">
                  <div className="label">Avg Effective Fee</div>
                  <div className="value">{bpsPct(feeStack.avgEffectivePerfFee)}</div>
                </div>
                <div className="metric">
                  <div className="label">Vaults with Stacking</div>
                  <div className="value">{sortedStacks.length}</div>
                </div>
              </div>
              <div className="table-scroll" style={{ maxHeight: 600, overflowY: "auto" }}>
                <table className={density === "compact" ? "density-compact" : ""}>
                  <thead>
                    <tr>
                      <th {...stackSort.th("name", "Vault")} />
                      <th {...stackSort.th("perfFee", "Perf Fee", "text-right")} />
                      <th {...stackSort.th("feeCaptured", "Fees Captured", "text-right")} />
                      <th {...stackSort.th("effective", "Effective", "text-right")} />
                      <th style={{ textAlign: "center", width: 60 }}>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedStacks.map((chain, idx) => {
                      const realIdx = stackPagination.start + idx;
                      const isOpen = expandedStack === realIdx;
                      const rows = flattenTree(chain.root, 0, true);
                      const feeCaptured = chain.feeCaptured;
                      const barPct = maxCap > 0 ? (chain.root.capitalUsd / maxCap) * 100 : 0;
                      return (
                        <Fragment key={`stack-${realIdx}`}>
                          <tr onClick={() => setExpandedStack(isOpen ? null : realIdx)} style={{ cursor: "pointer" }}>
                            <td>
                              <span style={{ color: "var(--text-3)", marginRight: 6, fontSize: "0.7rem" }}>
                                {isOpen ? "\u25BC" : "\u25B6"}
                              </span>
                              <span style={{ fontWeight: 600 }}>
                                {chain.root.vault.name?.slice(0, 30) || chain.root.vault.address.slice(0, 10)}
                              </span>
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: "0.6rem",
                                  fontWeight: 600,
                                  padding: "1px 5px",
                                  borderRadius: 3,
                                  background: `${CHAIN_COLORS[chain.root.vault.chainId] || "#5e6673"}20`,
                                  color: CHAIN_COLORS[chain.root.vault.chainId] || "#5e6673",
                                  letterSpacing: "0.03em",
                                }}
                              >
                                {CHAIN_SHORT[chain.root.vault.chainId] || chain.root.vault.chainId}
                              </span>
                            </td>
                            <td className="text-right">{bpsPct(chain.root.perfFee)}</td>
                            <td className="text-right">
                              <div className="inline-bar">
                                <span className="text-green">{fmt(feeCaptured)}</span>
                                <div className="inline-bar-track">
                                  <div className="inline-bar-fill fill-green" style={{ width: `${barPct}%` }} />
                                </div>
                              </div>
                            </td>
                            <td className="text-right">
                              <span className="text-yellow" style={{ fontWeight: 600 }}>
                                {bpsPct(chain.effectivePerfFee)}
                              </span>
                              <span className="text-dim" style={{ fontSize: "0.7rem", marginLeft: 4 }}>
                                depth {chain.maxDepth}
                              </span>
                            </td>
                            <td style={{ textAlign: "center" }}>{trendIcon(chain.trend)}</td>
                          </tr>
                          {isOpen &&
                            rows.map(({ node, depth, isLast }, ri) => {
                              const paddingLeft = 1.0 + depth * 1.6;
                              const isRoot = depth === 0;
                              const isLeafStrategy = node.children.length === 0 && node.perfFee === 0 && !isRoot;
                              const rowOpacity = isLeafStrategy ? 0.55 : 1;
                              const hopFee = node.capitalUsd * (node.perfFee / 10000);
                              return (
                                <tr
                                  key={`stack-${realIdx}-${ri}`}
                                  style={{ background: `rgba(46, 230, 182, ${0.015 + depth * 0.015})`, opacity: rowOpacity }}
                                >
                                  <td style={{ paddingLeft: `${paddingLeft}rem` }}>
                                    <span className="text-dim" style={{ marginRight: 6, fontSize: "0.75rem" }}>
                                      {isRoot ? "\u25CB" : isLast ? "\u2514\u2500" : "\u251C\u2500"}
                                    </span>
                                    {!isRoot && (
                                      <span style={{ color: "var(--accent)", fontSize: "0.65rem", marginRight: 4, opacity: 0.6 }}>
                                        {"\u2192"}
                                      </span>
                                    )}
                                    <span style={{ color: isRoot ? "var(--text)" : "var(--text-2)" }}>
                                      {node.vault.name?.slice(0, 28) || node.vault.address.slice(0, 10)}
                                    </span>
                                    {!isRoot && node.vault.chainId !== chain.root.vault.chainId && (
                                      <span
                                        style={{
                                          marginLeft: 4,
                                          fontSize: "0.55rem",
                                          fontWeight: 600,
                                          padding: "1px 4px",
                                          borderRadius: 3,
                                          background: `${CHAIN_COLORS[node.vault.chainId] || "#5e6673"}20`,
                                          color: CHAIN_COLORS[node.vault.chainId] || "#5e6673",
                                        }}
                                      >
                                        {CHAIN_SHORT[node.vault.chainId] || node.vault.chainId}
                                      </span>
                                    )}
                                  </td>
                                  <td className="text-right" style={{ color: node.perfFee > 0 ? "var(--text)" : "var(--text-3)" }}>
                                    {bpsPct(node.perfFee)}
                                  </td>
                                  <td className="text-right" style={{ color: hopFee > 0 ? "var(--text-2)" : "var(--text-3)" }}>
                                    {hopFee > 0 ? fmt(hopFee) : fmt(node.capitalUsd)}
                                  </td>
                                  <td className="text-right">
                                    {isRoot ? (
                                      <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                                        root
                                      </span>
                                    ) : isLeafStrategy ? (
                                      <span className="text-dim" style={{ fontSize: "0.65rem" }}>
                                        strategy
                                      </span>
                                    ) : (
                                      <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                                        +{bpsPct(node.perfFee)}
                                      </span>
                                    )}
                                  </td>
                                  <td />
                                </tr>
                              );
                            })}
                          {isOpen && (
                            <tr style={{ background: "rgba(46, 230, 182, 0.06)", borderTop: "1px solid var(--border)" }}>
                              <td style={{ paddingLeft: "1rem" }}>
                                <span
                                  style={{
                                    fontSize: "0.72rem",
                                    fontWeight: 600,
                                    color: "var(--text-3)",
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                  }}
                                >
                                  Effective total
                                </span>
                              </td>
                              <td className="text-right">
                                <span className="text-yellow" style={{ fontWeight: 600 }}>
                                  {bpsPct(chain.effectivePerfFee)}
                                </span>
                              </td>
                              <td className="text-right text-green" style={{ fontWeight: 600 }}>
                                {fmt(feeCaptured)}
                              </td>
                              <td className="text-right">
                                <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                                  weighted
                                </span>
                              </td>
                              <td />
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {stackPagination.Pagination && <stackPagination.Pagination />}
            </div>
          );
        })()}
    </>
  );
}
