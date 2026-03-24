import type { DefillamaComparison as Comparison } from "@yearn-tvl/shared";
import { useContext, useEffect, useMemo } from "react";
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DashboardContext } from "../App";
import { CHAIN_NAMES, fmt, pct, SkeletonCards, SkeletonChart, useFetch, useSort } from "../hooks";

const TOOLTIP_STYLE = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8 },
  labelStyle: { color: "var(--text)" },
  itemStyle: { color: "var(--text-2)" },
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
  const { chainFilter, setLastFetchedAt } = useContext(DashboardContext);
  const { data, loading, error, fetchedAt, retry } = useFetch<Comparison>("/api/comparison");
  const catSort = useSort("ours");

  useEffect(() => {
    if (fetchedAt) setLastFetchedAt(fetchedAt);
  }, [fetchedAt, setLastFetchedAt]);

  const chartData = useMemo(
    () =>
      data
        ? [...data.byChain]
            .filter((c) => chainFilter === "all" || c.chain === chainFilter)
            .sort((a, b) => b.ours - a.ours)
            .map((c) => ({ chain: CHAIN_NAMES[Number(c.chain)] || c.chain, Ours: c.ours, DefiLlama: c.defillama }))
        : [],
    [data, chainFilter],
  );

  const sortedCats = useMemo(
    () =>
      data
        ? catSort.sorted(data.byCategory, {
            category: (c) => c.category,
            protocol: (c) => c.defillamaProtocol,
            ours: (c) => c.ours,
            defillama: (c) => c.defillama,
            diff: (c) => c.difference,
            diffPct: (c) => diffPct(c.ours, c.defillama),
          })
        : [],
    [data, catSort.sorted],
  );

  const catMax = useMemo(() => (data ? Math.max(...data.byCategory.map((c) => Math.max(c.ours, c.defillama)), 1) : 1), [data]);

  if (loading)
    return (
      <>
        <SkeletonCards count={4} />
        <SkeletonChart />
      </>
    );
  if (error)
    return (
      <div className="error-retry">
        <div className="error-message">Error: {error}</div>
        <button className="page-btn" onClick={retry}>
          Retry
        </button>
      </div>
    );
  if (!data) return null;

  const aligned = Math.abs(data.differencePercent) < 5;
  const diffColor = aligned ? "text-green" : "text-red";
  const diffMetricClass = aligned ? "metric-green" : "metric-red";

  return (
    <>
      <p className="text-dim" style={{ marginBottom: "1rem", fontSize: "0.82rem" }}>
        Comparing our internally-calculated TVL against DefiLlama's reported figures for yearn-finance and yearn-curating protocols.
      </p>

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
          <div className="sub">Auto + registry overlap</div>
        </div>

        <div className="metric">
          <div className="label">Cross-Chain Overlap</div>
          <div className="value text-dim">{fmt(data.crossChainOverlap)}</div>
          <div className="sub">Katana pre-deposit deductions</div>
        </div>

        <div className="metric">
          <div className="label">Retired TVL (included)</div>
          <div className="value text-dim">{fmt(data.retiredTvl)}</div>
          <div className="sub">On-chain capital in deprecated vaults</div>
        </div>
      </div>

      {/* ── Gap Explanation ── */}
      {data.gapComponents.length > 0 && (
        <div className="card">
          <h2>Gap Breakdown</h2>
          <p className="text-dim" style={{ fontSize: "0.78rem", marginBottom: "0.75rem" }}>
            Why our net TVL ({fmt(data.ourTotal)}) differs from DefiLlama ({fmt(data.defillamaTotal)})
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {data.gapComponents.map((g, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  padding: "0.5rem 0.75rem",
                  background: "var(--surface-2)",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>{g.label}</div>
                  <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 2 }}>
                    {g.explanation}
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: "monospace",
                    fontWeight: 600,
                    fontSize: "0.85rem",
                    color: g.amount >= 0 ? "var(--green)" : "var(--red)",
                    whiteSpace: "nowrap",
                    marginLeft: "1rem",
                  }}
                >
                  {g.amount >= 0 ? "+" : ""}
                  {fmt(g.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      {data.notes.length > 0 && (
        <div className="card" style={{ padding: "0.75rem 1rem", marginBottom: "1rem" }}>
          <h2 style={{ marginBottom: "0.5rem" }}>Notes</h2>
          <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            {data.notes.map((note, i) => (
              <li key={i} className="text-dim" style={{ fontSize: "0.82rem", lineHeight: 1.5 }}>
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}

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
                tick={{ fill: "var(--text-2)", fontSize: 11 }}
                axisLine={{ stroke: "var(--border)" }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={formatAxis}
                tick={{ fill: "var(--text-3)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip formatter={(value: number) => fmt(value)} {...TOOLTIP_STYLE} cursor={{ fill: "rgba(31, 38, 55, 0.4)" }} />
              <Legend wrapperStyle={{ fontSize: "0.75rem", color: "var(--text-2)", paddingTop: 8 }} />
              <Bar dataKey="Ours" fill="#2ee6b6" radius={[3, 3, 0, 0]} maxBarSize={36} />
              <Bar dataKey="DefiLlama" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── By Category ── */}
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
                      <span className={`badge badge-${c.category}`} style={{ textTransform: "uppercase" }}>
                        {c.category}
                      </span>
                    </td>
                    <td className="text-dim">{c.defillamaProtocol}</td>
                    <td className="text-right">{fmt(c.ours)}</td>
                    <td className="text-right">{fmt(c.defillama)}</td>
                    <td className={`text-right ${c.difference >= 0 ? "text-green" : "text-red"}`}>{fmt(c.difference)}</td>
                    <td className={`text-right ${dp >= 0 ? "text-green" : "text-red"}`}>{pct(dp)}</td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <div className="inline-bar">
                          <div className="inline-bar-track">
                            <div className="inline-bar-fill" style={{ width: `${oursPct}%`, background: "var(--accent)" }} />
                          </div>
                        </div>
                        <div className="inline-bar">
                          <div className="inline-bar-track">
                            <div className="inline-bar-fill fill-blue" style={{ width: `${dlPct}%` }} />
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
    </>
  );
}
