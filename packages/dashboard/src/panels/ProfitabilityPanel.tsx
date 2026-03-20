import { useState, useMemo } from "react";
import { useFetch, fmt, shortAddr, pctFmt, useSort, CHAIN_NAMES, CHAIN_SHORT, EXPLORER_URLS, CAT_COLORS, SkeletonCards, SkeletonChart, exportCSV, useDebouncedValue } from "../hooks";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, BarChart, Bar,
} from "recharts";

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

type SortKey = "tvl" | "feeYield" | "fees" | "gains" | "trend" | "name";

function trendIcon(t: Trend) {
  if (t === "improving") return <span style={{ color: "var(--green)" }}>&#x25B2;</span>;
  if (t === "declining") return <span style={{ color: "var(--red)" }}>&#x25BC;</span>;
  if (t === "stable") return <span style={{ color: "var(--text-3)" }}>&#x25CF;</span>;
  return <span style={{ color: "var(--text-3)" }}>-</span>;
}

function confidenceBadge(c: PricingConfidence) {
  const cls = c === "high" ? "confidence-high" : c === "medium" ? "confidence-medium" : "confidence-low";
  return <span className={`confidence-badge ${cls}`}>{c}</span>;
}

function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]?.payload) return null;
  const v = payload[0].payload;
  return (
    <div style={{
      background: "#151a23",
      border: "1px solid #1f2637",
      borderRadius: 8,
      padding: "0.7rem 0.85rem",
      fontSize: "0.78rem",
      lineHeight: 1.6,
      minWidth: 180,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "var(--text)", fontSize: "0.82rem" }}>
        {v.name || shortAddr(v.address)}
      </div>
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
      <div style={{
        marginTop: 6,
        paddingTop: 6,
        borderTop: "1px solid #1f2637",
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}>
        <span className={`badge-${v.category}`} style={{ fontSize: "0.7rem" }}>{v.category.toUpperCase()}</span>
        <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>{CHAIN_SHORT[v.chainId as keyof typeof CHAIN_SHORT] || v.chainId}</span>
      </div>
    </div>
  );
}

export function ProfitabilityPanel() {
  const { data, loading, error } = useFetch<ProfitabilitySummary>("/api/profitability");
  const [sortKey, setSortKey] = useState<SortKey>("fees");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [chainFilter, setChainFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [confFilter, setConfFilter] = useState("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(0);
  const catSort = useSort("fees");
  const chainSort = useSort("fees");

  const PAGE_SIZE = 50;

  // All hooks must be called unconditionally (before any early returns)
  const filtered = useMemo(() => {
    if (!data) return [];
    let result = data.vaults;
    if (debouncedSearch) result = result.filter((v) => (v.name || v.address).toLowerCase().includes(debouncedSearch.toLowerCase()));
    if (chainFilter !== "all") result = result.filter((v) => String(v.chainId) === chainFilter);
    if (catFilter !== "all") result = result.filter((v) => v.category === catFilter);
    if (confFilter !== "all") result = result.filter((v) => v.pricingConfidence === confFilter);
    return result;
  }, [data, debouncedSearch, chainFilter, catFilter, confFilter]);

  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    const dir = sortDir === "desc" ? -1 : 1;
    switch (sortKey) {
      case "tvl": return (a.tvlUsd - b.tvlUsd) * dir;
      case "feeYield": return (a.feeYield - b.feeYield) * dir;
      case "fees": return (a.annualizedFeeRevenue - b.annualizedFeeRevenue) * dir;
      case "gains": return (a.totalGainUsd - b.totalGainUsd) * dir;
      case "trend": return (a.trendDelta - b.trendDelta) * dir;
      case "name": return ((a.name || "").localeCompare(b.name || "")) * dir;
      default: return 0;
    }
  }), [filtered, sortKey, sortDir]);

  const scatterData = useMemo(() => {
    if (!data) return [];
    const eligible = data.vaults.filter((v) => v.feeYield > 0 && v.tvlUsd > 0);
    if (eligible.length < 4) return eligible.map((v) => ({ ...v, logTvl: Math.log10(v.tvlUsd) }));
    const yields = eligible.map((v) => v.feeYield).sort((a, b) => a - b);
    const q1 = yields[Math.floor(yields.length * 0.25)];
    const q3 = yields[Math.floor(yields.length * 0.75)];
    const iqr = q3 - q1;
    const upper = q3 + 1.5 * iqr;
    return eligible
      .filter((v) => v.feeYield <= upper)
      .map((v) => ({ ...v, logTvl: Math.log10(v.tvlUsd) }));
  }, [data]);

  const trendLine = useMemo(() => {
    if (scatterData.length < 5) return null;
    const n = scatterData.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (const p of scatterData) {
      sumX += p.logTvl;
      sumY += p.feeYield;
      sumXY += p.logTvl * p.feeYield;
      sumX2 += p.logTvl * p.logTvl;
      sumY2 += p.feeYield * p.feeYield;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    // r²
    const denomR = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const r2 = denomR === 0 ? 0 : Math.pow((n * sumXY - sumX * sumY) / denomR, 2);
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

  const chains = useMemo(() => (data ? [...new Set(data.vaults.map((v) => v.chainId))] : []), [data]);

  if (loading) return <><SkeletonCards count={4} /><SkeletonChart /></>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
    setPage(0);
  };

  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === "desc" ? " \u25BC" : " \u25B2") : "";

  return (
    <>
      {/* Top metrics */}
      <div className="metric-grid">
        <div className="metric metric-accent">
          <div className="label">Protocol Fee Yield</div>
          <div className="value text-accent">{pctFmt(data.protocolFeeYield)}</div>
          <div className="sub">Annualized fees / Total TVL</div>
        </div>
        <div className="metric metric-blue">
          <div className="label">Fee Capture Rate</div>
          <div className="value text-blue">{pctFmt(data.feeCaptureRate)}</div>
          <div className="sub">Fees / Gains</div>
        </div>
        <div className="metric metric-green">
          <div className="label">Median Vault Yield</div>
          <div className="value text-green">{pctFmt(data.medianVaultFeeYield)}</div>
          <div className="sub">{data.vaultCount} vaults analyzed</div>
        </div>
        <div className="metric metric-yellow">
          <div className="label">Annualized Fees</div>
          <div className="value text-yellow">{fmt(data.totalAnnualizedFees)}</div>
          <div className="sub">On {fmt(data.totalTvl)} TVL</div>
        </div>
      </div>

      {/* Scatter chart */}
      <div className="card">
        <h2 style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          TVL vs Fee Yield
          {trendLine && (
            <span style={{ fontSize: "0.75rem", color: "#f0b90b", fontWeight: 400 }}>
              R² = {trendLine.r2.toFixed(3)}
            </span>
          )}
        </h2>
        <div className="quadrant-legend">
          {Object.entries(QUADRANT_LABELS).map(([key, { label, color, desc }]) => {
            const count = data.quadrants[key as Quadrant]?.length || 0;
            return (
              <span key={key} className="quadrant-tag" style={{ borderColor: color, color }}>
                {label} ({count}) <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>{desc}</span>
              </span>
            );
          })}
        </div>
        <div className="chart-container" style={{ height: 360 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ left: 20, right: 20, bottom: 24, top: 10 }}>
              <CartesianGrid stroke="#1f2637" strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="logTvl"
                name="TVL"
                domain={["auto", "auto"]}
                tickFormatter={(v) => fmt(Math.pow(10, v), 0)}
                tick={{ fill: "#5e6673", fontSize: 11 }}
                label={{ value: "TVL (log scale)", position: "bottom", fill: "#5e6673", fontSize: 11, offset: 6 }}
                stroke="#1f2637"
              />
              <YAxis
                type="number"
                dataKey="feeYield"
                name="Fee Yield"
                tickFormatter={(v) => pctFmt(v)}
                tick={{ fill: "#5e6673", fontSize: 11 }}
                label={{ value: "Fee Yield (ann.)", angle: -90, position: "insideLeft", fill: "#5e6673", fontSize: 11 }}
                stroke="#1f2637"
              />
              <ZAxis type="number" dataKey="annualizedFeeRevenue" range={[30, 500]} name="Fees" />
              <Tooltip content={<ScatterTooltip />} cursor={false} />
              <Scatter data={scatterData}>
                {scatterData.map((v, i) => (
                  <Cell
                    key={i}
                    fill={CAT_COLORS[v.category] || "#848e9c"}
                    fillOpacity={0.65}
                    stroke={CAT_COLORS[v.category] || "#848e9c"}
                    strokeWidth={1}
                  />
                ))}
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
      </div>

      {/* Category and Chain tables */}
      <div className="row">
        <div className="card">
          <h2>By Category</h2>
          <table>
            <thead>
              <tr>
                <th {...catSort.th("category", "Category")} />
                <th {...catSort.th("tvl", "TVL", "text-right")} />
                <th {...catSort.th("fees", "Fees (ann.)", "text-right")} />
                <th {...catSort.th("feeYield", "Fee Yield", "text-right")} />
                <th {...catSort.th("vaults", "Vaults", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {catSort.sorted(data.byCategory, {
                category: (c) => c.category,
                tvl: (c) => c.tvl,
                fees: (c) => c.fees,
                feeYield: (c) => c.feeYield,
                vaults: (c) => c.vaultCount,
              }).map((c) => (
                <tr key={c.category}>
                  <td><span className={`badge-${c.category}`}>{c.category.toUpperCase()}</span></td>
                  <td className="text-right">{fmt(c.tvl)}</td>
                  <td className="text-right text-green">{fmt(c.fees)}</td>
                  <td className="text-right">{pctFmt(c.feeYield)}</td>
                  <td className="text-right text-dim">{c.vaultCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>By Chain</h2>
          <table>
            <thead>
              <tr>
                <th {...chainSort.th("chain", "Chain")} />
                <th {...chainSort.th("tvl", "TVL", "text-right")} />
                <th {...chainSort.th("fees", "Fees (ann.)", "text-right")} />
                <th {...chainSort.th("feeYield", "Fee Yield", "text-right")} />
                <th {...chainSort.th("vaults", "Vaults", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {chainSort.sorted(data.byChain, {
                chain: (c) => c.chain,
                tvl: (c) => c.tvl,
                fees: (c) => c.fees,
                feeYield: (c) => c.feeYield,
                vaults: (c) => c.vaultCount,
              }).map((c) => (
                <tr key={c.chain}>
                  <td>{c.chain}</td>
                  <td className="text-right">{fmt(c.tvl)}</td>
                  <td className="text-right text-green">{fmt(c.fees)}</td>
                  <td className="text-right">{pctFmt(c.feeYield)}</td>
                  <td className="text-right text-dim">{c.vaultCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Vault table */}
      <div className="card">
        <div className="filter-bar">
          <h2 style={{ margin: 0 }}>Vault Profitability</h2>
          <button className="btn-export" onClick={() => exportCSV("vault-profitability.csv", ["Vault", "Chain", "Category", "TVL", "Fee Yield", "Fees (ann.)", "Gains", "Trend"], sorted.map(v => [v.name || v.address, CHAIN_SHORT[v.chainId as keyof typeof CHAIN_SHORT] || String(v.chainId), v.category, v.tvlUsd, (v.feeYield * 100).toFixed(2) + "%", v.annualizedFeeRevenue, v.totalGainUsd, v.trend]))}>Export CSV</button>
          <input
            className="search-input"
            placeholder="Search vaults..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
          <select value={chainFilter} onChange={(e) => { setChainFilter(e.target.value); setPage(0); }} className="filter-select">
            <option value="all">All chains</option>
            {chains.map((c) => <option key={c} value={String(c)}>{CHAIN_NAMES[c] || c}</option>)}
          </select>
          <select value={catFilter} onChange={(e) => { setCatFilter(e.target.value); setPage(0); }} className="filter-select">
            <option value="all">All categories</option>
            <option value="v1">V1</option>
            <option value="v2">V2</option>
            <option value="v3">V3</option>
          </select>
          <select value={confFilter} onChange={(e) => { setConfFilter(e.target.value); setPage(0); }} className="filter-select">
            <option value="all">All confidence</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <span style={{ color: "var(--text-3)", fontSize: "0.78rem", marginLeft: "auto" }}>{sorted.length} vaults</span>
        </div>

        <table>
          <thead>
            <tr>
              <th className="sortable" onClick={() => handleSort("name")}>Vault{sortArrow("name")}</th>
              <th>Chain</th>
              <th>Cat</th>
              <th className="text-right sortable" onClick={() => handleSort("tvl")}>TVL{sortArrow("tvl")}</th>
              <th className="text-right sortable" onClick={() => handleSort("feeYield")}>Fee Yield{sortArrow("feeYield")}</th>
              <th className="text-right sortable" onClick={() => handleSort("fees")}>Fees (ann.){sortArrow("fees")}</th>
              <th className="text-right sortable" onClick={() => handleSort("gains")}>Gains{sortArrow("gains")}</th>
              <th className="sortable" onClick={() => handleSort("trend")}>Trend{sortArrow("trend")}</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((v) => (
              <tr key={`${v.chainId}:${v.address}`}>
                <td>
                  <span className="vault-name">{v.name?.slice(0, 25) || shortAddr(v.address)}</span>
                  {EXPLORER_URLS[v.chainId] && (
                    <a
                      href={`${EXPLORER_URLS[v.chainId]}/${v.address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="explorer-link"
                    >
                      &#x2197;
                    </a>
                  )}
                </td>
                <td style={{ color: "var(--text-2)" }}>{CHAIN_SHORT[v.chainId as keyof typeof CHAIN_SHORT] || v.chainId}</td>
                <td><span className={`badge-${v.category}`}>{v.category.toUpperCase()}</span></td>
                <td className="text-right">{fmt(v.tvlUsd)}</td>
                <td
                  className="text-right"
                  style={{
                    color: v.feeYield > data.medianVaultFeeYield
                      ? "var(--green)"
                      : v.feeYield > 0
                        ? "var(--yellow)"
                        : "var(--red)",
                  }}
                >
                  {pctFmt(v.feeYield)}
                </td>
                <td className="text-right text-green">{fmt(v.annualizedFeeRevenue)}</td>
                <td className="text-right">{fmt(v.totalGainUsd)}</td>
                <td>
                  {trendIcon(v.trend)}{" "}
                  <span style={{ color: "var(--text-3)", fontSize: "0.72rem" }}>
                    {v.trend === "insufficient_data" ? "n/a" : v.trend}
                  </span>
                </td>
                <td>{confidenceBadge(v.pricingConfidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", padding: "0.75rem", alignItems: "center" }}>
            <button className="page-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
            <span style={{ color: "var(--text-3)", fontSize: "0.78rem" }}>Page {page + 1} of {totalPages}</span>
            <button className="page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}
