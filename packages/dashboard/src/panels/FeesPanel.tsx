import { useState, useContext, useMemo } from "react";
import { DashboardContext } from "../App";
import { useFetch, fmt, useSort, CHAIN_NAMES, CHART_COLORS, SkeletonCards, SkeletonChart, exportCSV } from "../hooks";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";

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
  const { chainFilter, density } = useContext(DashboardContext);
  const [timePreset, setTimePreset] = useState(4); // default "All"

  const sinceTs = getSinceTs(TIME_PRESETS[timePreset]?.days ?? 0);
  const sinceQ = sinceTs != null ? `?since=${sinceTs}` : "";
  const { data: summary, loading: l1 } = useFetch<FeeSummary>(`/api/fees${sinceQ}`);
  const { data: history, loading: l2 } = useFetch<FeeHistory>("/api/fees/history?interval=monthly");
  const { data: vaultData, loading: l3 } = useFetch<{ count: number; vaults: VaultFee[] }>(`/api/fees/vaults${sinceQ}`);
  const vaultSort = useSort("totalFeeRevenue");

  // Filter history buckets client-side by time range
  const filteredBuckets = useMemo(() => {
    if (!history) return [];
    if (sinceTs == null) return history.buckets;
    const sinceDate = new Date(sinceTs * 1000);
    return history.buckets.filter((b) => new Date(b.period + "-01") >= sinceDate);
  }, [history, sinceTs]);

  // All hooks must be called unconditionally (before any early returns)
  const chainRows = useMemo(
    () =>
      summary
        ? Object.entries(summary.byChain)
            .map(([chain, d]) => ({ chain, label: CHAIN_NAMES[Number(chain)] || chain, feeRevenue: d.feeRevenue, gains: d.gains, vaultCount: d.vaultCount }))
            .sort((a, b) => b.feeRevenue - a.feeRevenue)
        : [],
    [summary],
  );

  const sortedVaults = useMemo(
    () =>
      vaultData
        ? vaultSort.sorted(vaultData.vaults, {
            name: (v) => v.name || "", chain: (v) => v.chainId, tvl: (v) => v.tvlUsd,
            totalFeeRevenue: (v) => v.totalFeeRevenue, perfFees: (v) => v.performanceFeeRevenue, reports: (v) => v.reportCount,
          })
        : [],
    [vaultSort.sortKey, vaultSort.sortDir, vaultData],
  );

  const top15 = useMemo(() => sortedVaults.slice(0, 15), [sortedVaults]);
  const maxFee = useMemo(() => Math.max(...top15.map((v) => v.totalFeeRevenue), 1), [top15]);

  if (l1 || l2 || l3) return <><SkeletonCards count={5} /><SkeletonChart /></>;
  if (!summary || !history || !vaultData) return null;

  return (
    <>
      {/* ---- Time Range Presets ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
        <span className="text-dim" style={{ fontSize: "0.75rem", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>Time Range</span>
        <div className="time-presets">
          {TIME_PRESETS.map((p, i) => (
            <button
              key={p.label}
              className={timePreset === i ? "active" : ""}
              onClick={() => setTimePreset(i)}
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
          <div className="sub">{fmt(Math.abs(summary.totalLosses))} in losses</div>
        </div>
        <div className="metric">
          <div className="label">Report Count</div>
          <div className="value">{summary.reportCount.toLocaleString()}</div>
          <div className="sub">{summary.vaultCount} vaults with fees</div>
        </div>
      </div>

      {/* ---- Fee History Area Chart ---- */}
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
                <linearGradient id="gradGains" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1f2637" strokeDasharray="3 3" />
              <XAxis
                dataKey="period"
                tick={{ fill: "#5e6673", fontSize: 11 }}
                interval={Math.max(0, Math.floor(filteredBuckets.length / 8) - 1)}
                angle={-35}
                textAnchor="end"
                height={50}
              />
              <YAxis
                tick={{ fill: "#5e6673", fontSize: 11 }}
                tickFormatter={(v: number) => fmt(v, 0)}
                width={60}
              />
              <Tooltip
                contentStyle={{ background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 }}
                labelStyle={{ color: "#eaecef" }}
                formatter={(value: number, name: string) => [
                  fmt(value, 2),
                  name === "performanceFeeRevenue" ? "Fee Revenue" : "Gains",
                ]}
                cursor={{ stroke: "rgba(46, 230, 182, 0.3)" }}
              />
              <Area
                type="monotone"
                dataKey="gains"
                stroke="#3b82f6"
                fill="url(#gradGains)"
                strokeWidth={2}
                name="gains"
              />
              <Area
                type="monotone"
                dataKey="performanceFeeRevenue"
                stroke="#0ecb81"
                fill="url(#gradFees)"
                strokeWidth={2}
                name="performanceFeeRevenue"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ---- Two-column: Chain Breakdown + Top Vaults ---- */}
      <div className="row">
        {/* ---- Fee Revenue by Chain (Horizontal Bar) ---- */}
        <div className="card">
          <h2>Fee Revenue by Chain</h2>
          <div className="chart-container" style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chainRows}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
              >
                <CartesianGrid stroke="#1f2637" strokeDasharray="3 3" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#5e6673", fontSize: 11 }}
                  tickFormatter={(v: number) => fmt(v, 0)}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#848e9c", fontSize: 11 }}
                  width={80}
                />
                <Tooltip
                  contentStyle={{ background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 }}
                  labelStyle={{ color: "#eaecef" }}
                  formatter={(value: number) => [fmt(value, 2), "Fee Revenue"]}
                  cursor={{ fill: "rgba(46, 230, 182, 0.06)" }}
                />
                <Bar dataKey="feeRevenue" radius={[0, 4, 4, 0]} barSize={18}>
                  {chainRows.map((_, idx) => (
                    <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ---- Top Earning Vaults ---- */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>Top Earning Vaults</h2>
            <button className="btn-export" onClick={() => exportCSV("vault-fees.csv", ["Vault", "Chain", "TVL", "Total Fees", "Perf Fees", "Reports"], sortedVaults.slice(0, 50).map(v => [v.name || v.address, CHAIN_NAMES[v.chainId] || String(v.chainId), v.tvlUsd, v.totalFeeRevenue, v.performanceFeeRevenue, v.reportCount]))}>Export CSV</button>
          </div>
          <div className="table-scroll" style={{ maxHeight: 520, overflowY: "auto" }}>
            <table className={density === "compact" ? "density-compact" : ""}>
              <thead>
                <tr>
                  <th {...vaultSort.th("name", "Vault")} />
                  <th {...vaultSort.th("chain", "Chain")} />
                  <th {...vaultSort.th("tvl", "TVL", "text-right")} />
                  <th {...vaultSort.th("totalFeeRevenue", "Total Fees", "text-right")} />
                  <th {...vaultSort.th("perfFees", "Perf Fees", "text-right")} />
                  <th {...vaultSort.th("reports", "Reports", "text-right")} />
                </tr>
              </thead>
              <tbody>
                {top15.map((v) => {
                  const pct = maxFee > 0 ? (v.totalFeeRevenue / maxFee) * 100 : 0;
                  return (
                    <tr key={`${v.chainId}:${v.address}`}>
                      <td>
                        <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
                          {v.name?.slice(0, 28) || v.address.slice(0, 10)}
                        </span>
                      </td>
                      <td>
                        <span className="text-dim" style={{ fontSize: "0.75rem" }}>
                          {CHAIN_NAMES[v.chainId] || v.chainId}
                        </span>
                      </td>
                      <td className="text-right">{fmt(v.tvlUsd)}</td>
                      <td className="text-right">
                        <div className="inline-bar">
                          <span className="text-green">{fmt(v.totalFeeRevenue)}</span>
                          <div className="inline-bar-track">
                            <div
                              className="inline-bar-fill fill-green"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="text-right text-accent">{fmt(v.performanceFeeRevenue)}</td>
                      <td className="text-right text-dim">{v.reportCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
