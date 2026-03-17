import { useMemo } from "react";
import { useFetch, fmt, pct, useSort, CHAIN_NAMES, SkeletonCards, SkeletonChart, exportCSV } from "../hooks";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface Comparison {
  ourTotal: number;
  defillamaTotal: number;
  difference: number;
  differencePercent: number;
  retiredTvl: number;
  overlapDeducted: number;
  notes: string[];
  byChain: Array<{ chain: string; ours: number; defillama: number; difference: number }>;
  byCategory: Array<{
    category: string;
    defillamaProtocol: string;
    ours: number;
    defillama: number;
    difference: number;
  }>;
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 },
  labelStyle: { color: "#eaecef" },
  itemStyle: { color: "#848e9c" },
};

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function diffPct(ours: number, dl: number): number {
  if (Math.abs(dl) < 1 && Math.abs(ours) < 1) return 0;
  if (Math.abs(dl) < 1) return 100;
  return ((ours - dl) / dl) * 100;
}

export function ComparisonPanel() {
  const { data, loading, error } = useFetch<Comparison>("/api/comparison");
  const catSort = useSort("ours");
  const chainSort = useSort("ours");

  // All hooks must be called unconditionally (before any early returns)
  const chartData = useMemo(
    () =>
      data
        ? [...data.byChain]
            .sort((a, b) => b.ours - a.ours)
            .map((c) => ({ chain: CHAIN_NAMES[Number(c.chain)] || c.chain, Ours: c.ours, DefiLlama: c.defillama }))
        : [],
    [data],
  );

  const sortedCats = useMemo(
    () =>
      data
        ? catSort.sorted(data.byCategory, {
            category: (c) => c.category, protocol: (c) => c.defillamaProtocol,
            ours: (c) => c.ours, defillama: (c) => c.defillama,
            diff: (c) => c.difference, diffPct: (c) => diffPct(c.ours, c.defillama),
          })
        : [],
    [data, catSort.sorted],
  );

  const catMax = useMemo(
    () => (data ? Math.max(...data.byCategory.map((c) => Math.max(c.ours, c.defillama)), 1) : 1),
    [data],
  );

  const sortedChains = useMemo(
    () =>
      data
        ? chainSort.sorted(data.byChain, {
            chain: (c) => CHAIN_NAMES[Number(c.chain)] || c.chain,
            ours: (c) => c.ours, defillama: (c) => c.defillama,
            diff: (c) => c.difference, diffPct: (c) => diffPct(c.ours, c.defillama),
          })
        : [],
    [data, chainSort.sorted],
  );

  const chainMax = useMemo(
    () => (data ? Math.max(...data.byChain.map((c) => Math.abs(c.difference)), 1) : 1),
    [data],
  );

  if (loading) return <><SkeletonCards count={4} /><SkeletonChart /></>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const aligned = Math.abs(data.differencePercent) < 5;
  const diffColor = aligned ? "text-green" : "text-red";
  const diffMetricClass = aligned ? "metric-green" : "metric-red";

  return (
    <>
      {/* ── Metric Cards ── */}
      <div className="metric-grid">
        <div className="metric metric-accent">
          <div className="label">Our Total TVL</div>
          <div className="value">{fmt(data.ourTotal)}</div>
          <div className="sub">V1 + V2 + V3 + Curation (net of overlap)</div>
        </div>

        <div className="metric metric-blue">
          <div className="label">DefiLlama Total</div>
          <div className="value">{fmt(data.defillamaTotal)}</div>
          <div className="sub">yearn-finance + yearn-curating</div>
        </div>

        <div className={`metric ${diffMetricClass}`}>
          <div className="label">Difference</div>
          <div className={`value ${diffColor}`}>{fmt(data.difference)}</div>
          <div className="sub">
            {pct(data.differencePercent)} {aligned ? "-- Aligned" : "-- Divergent"}
          </div>
        </div>

        <div className="metric metric-yellow">
          <div className="label">Overlap Deducted</div>
          <div className="value">{fmt(data.overlapDeducted)}</div>
          <div className="sub">Double-count removal (auto + registry)</div>
        </div>
      </div>

      {/* ── Notes ── */}
      {/* ── Grouped Bar Chart: Ours vs DL by Chain ── */}
      <div className="card">
        <h2>TVL by Chain: Ours vs DefiLlama</h2>
        <div style={{ height: 320, marginTop: "0.5rem" }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="horizontal"
              margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
              barGap={2}
              barCategoryGap="20%"
            >
              <XAxis
                dataKey="chain"
                tick={{ fill: "#848e9c", fontSize: 11 }}
                axisLine={{ stroke: "#1f2637" }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatAxis}
                tick={{ fill: "#5e6673", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip
                formatter={(value: number) => fmt(value)}
                {...TOOLTIP_STYLE}
                cursor={{ fill: "rgba(31, 38, 55, 0.4)" }}
              />
              <Legend
                wrapperStyle={{ fontSize: "0.75rem", color: "#848e9c", paddingTop: 8 }}
              />
              <Bar dataKey="Ours" fill="#2ee6b6" radius={[3, 3, 0, 0]} maxBarSize={36} />
              <Bar dataKey="DefiLlama" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Two-column: Category + Chain Tables ── */}
      <div className="row">
        {/* By Category */}
        <div className="card">
          <h2>By Category</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th {...catSort.th("category", "Category")} />
                  <th {...catSort.th("protocol", "DL Protocol")} />
                  <th {...catSort.th("ours", "Ours", "text-right")} />
                  <th {...catSort.th("defillama", "DefiLlama", "text-right")} />
                  <th {...catSort.th("diff", "Delta", "text-right")} />
                  <th {...catSort.th("diffPct", "Diff %", "text-right")} />
                  <th style={{ width: "120px" }}>Relative</th>
                </tr>
              </thead>
              <tbody>
                {sortedCats.map((c) => {
                  const dp = diffPct(c.ours, c.defillama);
                  const oursPct = (c.ours / catMax) * 100;
                  const dlPct = (c.defillama / catMax) * 100;
                  return (
                    <tr key={c.category}>
                      <td>
                        <span
                          className={`badge badge-${c.category}`}
                          style={{ textTransform: "uppercase" }}
                        >
                          {c.category}
                        </span>
                      </td>
                      <td className="text-dim">{c.defillamaProtocol}</td>
                      <td className="text-right">{fmt(c.ours)}</td>
                      <td className="text-right">{fmt(c.defillama)}</td>
                      <td className={`text-right ${c.difference >= 0 ? "text-green" : "text-red"}`}>
                        {fmt(c.difference)}
                      </td>
                      <td className={`text-right ${dp >= 0 ? "text-green" : "text-red"}`}>
                        {pct(dp)}
                      </td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div className="inline-bar">
                            <div className="inline-bar-track">
                              <div
                                className="inline-bar-fill"
                                style={{ width: `${oursPct}%`, background: "var(--accent)" }}
                              />
                            </div>
                          </div>
                          <div className="inline-bar">
                            <div className="inline-bar-track">
                              <div
                                className="inline-bar-fill fill-blue"
                                style={{ width: `${dlPct}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* By Chain */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>By Chain</h2>
            <button className="btn-export" onClick={() => exportCSV("comparison-by-chain.csv", ["Chain", "Ours", "DefiLlama", "Delta", "Delta %"], sortedChains.map(c => [CHAIN_NAMES[Number(c.chain)] || c.chain, c.ours, c.defillama, c.difference, diffPct(c.ours, c.defillama).toFixed(1) + "%"]))}>Export CSV</button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th {...chainSort.th("chain", "Chain")} />
                  <th {...chainSort.th("ours", "Ours", "text-right")} />
                  <th {...chainSort.th("defillama", "DefiLlama", "text-right")} />
                  <th {...chainSort.th("diff", "Delta", "text-right")} />
                  <th {...chainSort.th("diffPct", "Delta %", "text-right")} />
                  <th style={{ width: "100px" }}>Delta Bar</th>
                </tr>
              </thead>
              <tbody>
                {sortedChains.map((c) => {
                  const dp = diffPct(c.ours, c.defillama);
                  const chainName = CHAIN_NAMES[Number(c.chain)] || c.chain;
                  const barWidth = Math.min(Math.abs(c.difference) / chainMax * 100, 100);
                  const isPositive = c.difference >= 0;
                  return (
                    <tr key={c.chain}>
                      <td>{chainName}</td>
                      <td className="text-right">{fmt(c.ours)}</td>
                      <td className="text-right">{fmt(c.defillama)}</td>
                      <td className={`text-right ${isPositive ? "text-green" : "text-red"}`}>
                        {fmt(c.difference)}
                      </td>
                      <td className={`text-right ${dp >= 0 ? "text-green" : "text-red"}`}>
                        {pct(dp)}
                      </td>
                      <td>
                        <div className="inline-bar">
                          <div className="inline-bar-track">
                            <div
                              className={`inline-bar-fill ${isPositive ? "fill-green" : "fill-red"}`}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                        </div>
                      </td>
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
