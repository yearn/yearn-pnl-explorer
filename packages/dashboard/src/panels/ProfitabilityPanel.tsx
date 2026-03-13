import { useState } from "react";
import { useFetch, fmt, shortAddr, useSort } from "../hooks";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
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

const CHAIN_NAMES: Record<number, string> = {
  1: "ETH", 10: "OP", 137: "POLY", 250: "FTM", 42161: "ARB", 8453: "BASE", 100: "GNO", 747474: "KAT", 999: "HL", 80094: "BERA", 146: "SONIC",
};

const EXPLORER_URLS: Record<number, string> = {
  1: "https://etherscan.io/address",
  10: "https://optimistic.etherscan.io/address",
  137: "https://polygonscan.com/address",
  250: "https://ftmscan.com/address",
  8453: "https://basescan.org/address",
  42161: "https://arbiscan.io/address",
  100: "https://gnosisscan.io/address",
  747474: "https://katanascan.com/address",
  999: "https://hyperevmscan.io/address",
  80094: "https://berascan.com/address",
  146: "https://sonicscan.org/address",
};

const QUADRANT_LABELS: Record<Quadrant, { label: string; color: string; desc: string }> = {
  high_tvl_high_yield: { label: "Cash Cows", color: "#3fb950", desc: "Protect & maintain" },
  high_tvl_low_yield: { label: "Optimize", color: "#d29922", desc: "Big opportunity — improve yield or migrate" },
  low_tvl_high_yield: { label: "Scale Up", color: "#0075ff", desc: "Drive more TVL here" },
  low_tvl_low_yield: { label: "Review", color: "#8b949e", desc: "Consider retirement" },
};

const CAT_COLORS: Record<string, string> = { v1: "#8b949e", v2: "#0075ff", v3: "#3fb950", curation: "#d29922" };

type SortKey = "tvl" | "feeYield" | "fees" | "gains" | "trend" | "name";

function trendIcon(t: Trend) {
  if (t === "improving") return <span style={{ color: "#3fb950" }}>&#x25B2;</span>;
  if (t === "declining") return <span style={{ color: "#f85149" }}>&#x25BC;</span>;
  if (t === "stable") return <span style={{ color: "#8b949e" }}>&#x25CF;</span>;
  return <span style={{ color: "#8b949e" }}>-</span>;
}

function confidenceBadge(c: PricingConfidence) {
  const cls = c === "high" ? "confidence-high" : c === "medium" ? "confidence-medium" : "confidence-low";
  return <span className={`confidence-badge ${cls}`}>{c}</span>;
}

function pctFmt(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

// Custom tooltip for scatter plot
function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]?.payload) return null;
  const v = payload[0].payload;
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: "0.6rem", fontSize: "0.8rem" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{v.name || shortAddr(v.address)}</div>
      <div>TVL: {fmt(v.tvlUsd)}</div>
      <div>Fee Yield: {pctFmt(v.feeYield)}</div>
      <div>Fees: {fmt(v.annualizedFeeRevenue)}</div>
      <div style={{ color: "#8b949e" }}>{v.category} · {CHAIN_NAMES[v.chainId] || v.chainId}</div>
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
  const [page, setPage] = useState(0);
  const catSort = useSort("fees");
  const chainSort = useSort("fees");

  if (loading) return <div className="loading">Loading profitability data...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const PAGE_SIZE = 50;

  // Sort
  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
    setPage(0);
  };

  // Filter
  let filtered = data.vaults;
  if (chainFilter !== "all") filtered = filtered.filter((v) => String(v.chainId) === chainFilter);
  if (catFilter !== "all") filtered = filtered.filter((v) => v.category === catFilter);
  if (confFilter !== "all") filtered = filtered.filter((v) => v.pricingConfidence === confFilter);

  // Sort
  const sorted = [...filtered].sort((a, b) => {
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
  });

  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);

  // Scatter data (use log scale for TVL)
  const scatterData = data.vaults
    .filter((v) => v.feeYield > 0 && v.tvlUsd > 0)
    .map((v) => ({ ...v, logTvl: Math.log10(v.tvlUsd) }));

  // Unique chains for filter
  const chains = [...new Set(data.vaults.map((v) => v.chainId))];

  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === "desc" ? " ▼" : " ▲") : "";

  return (
    <>
      {/* Top metrics */}
      <div className="metric-grid">
        <div className="metric">
          <div className="label">Protocol Fee Yield</div>
          <div className="value text-green">{pctFmt(data.protocolFeeYield)}</div>
          <div className="sub">Annualized fees / Total TVL</div>
        </div>
        <div className="metric">
          <div className="label">Fee Capture Rate</div>
          <div className="value">{pctFmt(data.feeCaptureRate)}</div>
          <div className="sub">Fees / Gains</div>
        </div>
        <div className="metric">
          <div className="label">Median Vault Fee Yield</div>
          <div className="value">{pctFmt(data.medianVaultFeeYield)}</div>
          <div className="sub">{data.vaultCount} vaults analyzed</div>
        </div>
        <div className="metric">
          <div className="label">Annualized Fee Revenue</div>
          <div className="value text-green">{fmt(data.totalAnnualizedFees)}</div>
          <div className="sub">On {fmt(data.totalTvl)} TVL (V1+V2+V3 alloc.)</div>
        </div>
      </div>

      {/* Quadrant scatter plot */}
      <div className="card">
        <h2>TVL vs Fee Yield — Strategic Quadrants</h2>
        <div className="quadrant-legend">
          {Object.entries(QUADRANT_LABELS).map(([key, { label, color, desc }]) => {
            const count = data.quadrants[key as Quadrant]?.length || 0;
            return (
              <span key={key} className="quadrant-tag" style={{ borderColor: color, color }}>
                {label} ({count}) <span className="text-dim">— {desc}</span>
              </span>
            );
          })}
        </div>
        <div className="chart-container" style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ left: 20, right: 20, bottom: 20, top: 10 }}>
              <XAxis
                type="number" dataKey="logTvl" name="TVL"
                domain={["auto", "auto"]}
                tickFormatter={(v) => fmt(Math.pow(10, v), 0)}
                label={{ value: "TVL (log scale)", position: "bottom", fill: "#8b949e", fontSize: 11 }}
              />
              <YAxis
                type="number" dataKey="feeYield" name="Fee Yield"
                tickFormatter={(v) => pctFmt(v)}
                label={{ value: "Fee Yield (annualized)", angle: -90, position: "insideLeft", fill: "#8b949e", fontSize: 11 }}
              />
              <ZAxis type="number" dataKey="annualizedFeeRevenue" range={[20, 400]} name="Fees" />
              <Tooltip content={<ScatterTooltip />} />
              <Scatter data={scatterData}>
                {scatterData.map((v, i) => (
                  <Cell key={i} fill={CAT_COLORS[v.category] || "#8b949e"} fillOpacity={0.7} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* By category and chain fee yield */}
      <div className="row">
        <div className="card">
          <h2>Fee Yield by Category</h2>
          <div className="chart-container" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.byCategory}>
                <XAxis dataKey="category" />
                <YAxis tickFormatter={(v) => pctFmt(v)} />
                <Tooltip formatter={(v: number) => pctFmt(v)} />
                <Bar dataKey="feeYield" name="Fee Yield" radius={[4, 4, 0, 0]}>
                  {data.byCategory.map((c, i) => (
                    <Cell key={i} fill={CAT_COLORS[c.category] || "#8b949e"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table style={{ marginTop: "0.5rem" }}>
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
                  <td>{c.category.toUpperCase()}</td>
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
          <h2>Fee Yield by Chain</h2>
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

      {/* Filterable vault table */}
      <div className="card">
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Vault Profitability</h2>
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
          <span className="text-dim" style={{ fontSize: "0.8rem" }}>{sorted.length} vaults</span>
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
              <th className="text-right sortable" onClick={() => handleSort("gains")}>Gains (365d){sortArrow("gains")}</th>
              <th className="sortable" onClick={() => handleSort("trend")}>Trend{sortArrow("trend")}</th>
              <th>Confidence</th>
              <th>Quadrant</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((v) => (
              <tr key={`${v.chainId}:${v.address}`}>
                <td title={v.name || v.address}>
                  {v.name?.slice(0, 25) || shortAddr(v.address)}
                  {EXPLORER_URLS[v.chainId] && (
                    <a href={`${EXPLORER_URLS[v.chainId]}/${v.address}`} target="_blank" rel="noopener noreferrer" style={{ color: "white", opacity: 0.4, textDecoration: "none", marginLeft: 4 }}>&#x2197;</a>
                  )}
                </td>
                <td className="text-dim">{CHAIN_NAMES[v.chainId] || v.chainId}</td>
                <td className="text-dim">{v.category}</td>
                <td className="text-right">{fmt(v.tvlUsd)}</td>
                <td className="text-right" style={{ color: v.feeYield > data.medianVaultFeeYield ? "#3fb950" : v.feeYield > 0 ? "#d29922" : "#f85149" }}>
                  {pctFmt(v.feeYield)}
                </td>
                <td className="text-right text-green">{fmt(v.annualizedFeeRevenue)}</td>
                <td className="text-right">{fmt(v.totalGainUsd)}</td>
                <td>{trendIcon(v.trend)} <span className="text-dim" style={{ fontSize: "0.75rem" }}>{v.trend === "insufficient_data" ? "n/a" : v.trend}</span></td>
                <td>{confidenceBadge(v.pricingConfidence)}</td>
                <td>
                  <span className="quadrant-tag-sm" style={{ borderColor: QUADRANT_LABELS[v.quadrant].color, color: QUADRANT_LABELS[v.quadrant].color }}>
                    {QUADRANT_LABELS[v.quadrant].label}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", padding: "0.75rem", alignItems: "center" }}>
            <button className="page-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Prev</button>
            <span className="text-dim" style={{ fontSize: "0.8rem" }}>Page {page + 1} of {totalPages}</span>
            <button className="page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}
