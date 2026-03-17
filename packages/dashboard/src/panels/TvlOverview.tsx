import { useMemo } from "react";
import { useFetch, fmt, CAT_COLORS, CHART_COLORS, CHAIN_SHORT, CHAIN_NAMES, SkeletonCards, SkeletonChart, exportCSV } from "../hooks";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

interface TvlSummary {
  totalTvl: number;
  v1Tvl: number;
  v2Tvl: number;
  v3Tvl: number;
  curationTvl: number;
  overlapAmount: number;
  tvlByChain: Record<string, number>;
  vaultCount: { total: number; v1: number; v2: number; v3: number; curation: number; active: number; retired: number };
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 },
  labelStyle: { color: "#eaecef" },
  itemStyle: { color: "#848e9c" },
};

const AXIS_TICK = { fill: "#5e6673", fontSize: 11 };

function share(part: number, total: number): string {
  if (total === 0) return "0%";
  return `${((part / total) * 100).toFixed(1)}% of total`;
}

export function TvlOverview() {
  const { data, loading, error } = useFetch<TvlSummary>("/api/tvl");

  // All hooks must be called unconditionally (before any early returns)
  const chainData = useMemo(
    () =>
      data
        ? Object.entries(data.tvlByChain)
            .map(([chain, tvl]) => ({ chain, label: CHAIN_NAMES[Number(chain)] || CHAIN_SHORT[Number(chain)] || chain, tvl }))
            .sort((a, b) => b.tvl - a.tvl)
        : [],
    [data],
  );

  const categories = useMemo(
    () =>
      data
        ? [
            { key: "v1", name: "V1", tvl: data.v1Tvl, color: CAT_COLORS.v1, vaults: data.vaultCount.v1 },
            { key: "v2", name: "V2", tvl: data.v2Tvl, color: CAT_COLORS.v2, vaults: data.vaultCount.v2 },
            { key: "v3", name: "V3", tvl: data.v3Tvl, color: CAT_COLORS.v3, vaults: data.vaultCount.v3 },
            { key: "curation", name: "Curation", tvl: data.curationTvl, color: CAT_COLORS.curation, vaults: data.vaultCount.curation },
          ]
        : [],
    [data],
  );

  const activeCategories = useMemo(() => categories.filter((c) => c.tvl > 0), [categories]);

  const categoryChartData = useMemo(
    () => activeCategories.map((c) => ({ name: c.name, tvl: c.tvl, color: c.color })),
    [activeCategories],
  );

  if (loading) return <><SkeletonCards count={6} /><SkeletonChart /></>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const grossTvl = data.v1Tvl + data.v2Tvl + data.v3Tvl + data.curationTvl;
  const maxChainTvl = chainData.length > 0 ? chainData[0].tvl : 1;

  return (
    <>
      {/* ── Metric Cards ── */}
      <div className="metric-grid">
        <div className="metric metric-accent">
          <div className="label">Total TVL (Active)</div>
          <div className="value">{fmt(data.totalTvl)}</div>
          <div className="sub">{data.vaultCount.active} active vaults across {Object.keys(data.tvlByChain).length} chains</div>
        </div>
        {data.v1Tvl > 0 && (
          <div className="metric">
            <div className="label">V1 Legacy</div>
            <div className="value text-dim">{fmt(data.v1Tvl)}</div>
            <div className="sub">{share(data.v1Tvl, grossTvl)} &middot; {data.vaultCount.v1} vaults</div>
          </div>
        )}
        <div className="metric metric-blue">
          <div className="label">V2 TVL</div>
          <div className="value">{fmt(data.v2Tvl)}</div>
          <div className="sub">{share(data.v2Tvl, grossTvl)} &middot; {data.vaultCount.v2} vaults</div>
        </div>
        <div className="metric metric-green">
          <div className="label">V3 TVL</div>
          <div className="value">{fmt(data.v3Tvl)}</div>
          <div className="sub">{share(data.v3Tvl, grossTvl)} &middot; {data.vaultCount.v3} vaults</div>
        </div>
        <div className="metric metric-yellow">
          <div className="label">Curation TVL</div>
          <div className="value">{fmt(data.curationTvl)}</div>
          <div className="sub">{share(data.curationTvl, grossTvl)} &middot; {data.vaultCount.curation} vaults</div>
        </div>
        <div className="metric metric-red">
          <div className="label">Overlap Deducted</div>
          <div className="value text-red">{fmt(data.overlapAmount)}</div>
          <div className="sub">
            {grossTvl > 0 ? `${((data.overlapAmount / grossTvl) * 100).toFixed(1)}%` : "0%"} double-count removed
          </div>
        </div>
        <div className="metric">
          <div className="label">Retired Vaults</div>
          <div className="value text-dim">{data.vaultCount.retired}</div>
          <div className="sub">Excluded from active totals</div>
        </div>
      </div>

      {/* ── TVL Composition Bar ── */}
      <div className="card">
        <h2>TVL Composition</h2>
        <div className="composition-bar">
          {activeCategories.map((c) => (
            <div
              key={c.key}
              style={{
                width: `${(c.tvl / grossTvl) * 100}%`,
                background: c.color,
                borderRadius: 2,
              }}
              title={`${c.name}: ${fmt(c.tvl)}`}
            />
          ))}
        </div>
        <div className="composition-legend">
          {activeCategories.map((c) => (
            <span key={c.key}>
              <span className="legend-dot" style={{ background: c.color }} />
              {c.name} &mdash; {fmt(c.tvl)} ({((c.tvl / grossTvl) * 100).toFixed(1)}%)
            </span>
          ))}
        </div>
      </div>

      {/* ── Charts Row ── */}
      <div className="row">
        {/* TVL by Chain — Horizontal Bar Chart */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>TVL by Chain</h2>
            <button
              className="btn-export"
              onClick={() =>
                exportCSV("tvl-by-chain.csv", ["Chain", "TVL (USD)"], chainData.map(c => [CHAIN_NAMES[Number(c.chain)] || c.chain, c.tvl]))
              }
            >
              Export CSV
            </button>
          </div>
          <div className="chart-container" style={{ height: Math.max(280, chainData.length * 36) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chainData}
                layout="vertical"
                margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
                barCategoryGap="20%"
              >
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => fmt(v, 0)}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, "dataMax"]}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={90}
                  tick={{ fill: "#eaecef", fontSize: 11, fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(v: number) => [fmt(v, 2), "TVL"]}
                  labelFormatter={(label: string) => label}
                  {...TOOLTIP_STYLE}
                  cursor={{ fill: "rgba(46, 230, 182, 0.04)" }}
                />
                <Bar dataKey="tvl" radius={[0, 4, 4, 0]} maxBarSize={28}>
                  {chainData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Chain stat rows with inline bars */}
          <div style={{ marginTop: "0.75rem" }}>
            {chainData.slice(0, 5).map((c, i) => (
              <div className="stat-row" key={c.chain}>
                <span className="stat-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 48 }}>
                  <span className="legend-dot" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                  {c.label}
                </span>
                <span style={{ flex: 1, padding: "0 1rem" }}>
                  <div className="inline-bar">
                    <div className="inline-bar-track">
                      <div
                        className="inline-bar-fill"
                        style={{
                          width: `${(c.tvl / maxChainTvl) * 100}%`,
                          background: CHART_COLORS[i % CHART_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                </span>
                <span className="stat-value">{fmt(c.tvl)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* TVL by Category — Vertical Bar Chart + Stat Rows */}
        <div className="card">
          <h2>TVL by Category</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={categoryChartData}
                margin={{ top: 8, right: 16, bottom: 4, left: 16 }}
                barCategoryGap="25%"
              >
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#eaecef", fontSize: 11, fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => fmt(v, 0)}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={60}
                />
                <Tooltip
                  formatter={(v: number) => [fmt(v, 2), "TVL"]}
                  {...TOOLTIP_STYLE}
                  cursor={{ fill: "rgba(46, 230, 182, 0.04)" }}
                />
                <Bar dataKey="tvl" radius={[4, 4, 0, 0]} maxBarSize={56}>
                  {categoryChartData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Category stat rows with inline bars */}
          <div style={{ marginTop: "0.75rem" }}>
            {activeCategories.map((c) => {
              const pctOfTotal = grossTvl > 0 ? (c.tvl / grossTvl) * 100 : 0;
              return (
                <div className="stat-row" key={c.key}>
                  <span className="stat-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 80 }}>
                    <span className={`badge badge-${c.key}`}>{c.name}</span>
                  </span>
                  <span style={{ flex: 1, padding: "0 0.75rem" }}>
                    <div className="inline-bar">
                      <div className="inline-bar-track">
                        <div
                          className="inline-bar-fill"
                          style={{
                            width: `${pctOfTotal}%`,
                            background: c.color,
                          }}
                        />
                      </div>
                      <span style={{ fontSize: "0.72rem", color: "#5e6673", minWidth: 36, textAlign: "right" }}>
                        {pctOfTotal.toFixed(1)}%
                      </span>
                    </div>
                  </span>
                  <span className="stat-value">{fmt(c.tvl)}</span>
                </div>
              );
            })}
            {/* Overlap row */}
            {data.overlapAmount > 0 && (
              <div className="stat-row">
                <span className="stat-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ color: "#f6465d", fontSize: "0.72rem", fontWeight: 600 }}>OVERLAP</span>
                </span>
                <span style={{ flex: 1, padding: "0 0.75rem" }}>
                  <div className="inline-bar">
                    <div className="inline-bar-track">
                      <div
                        className="inline-bar-fill fill-red"
                        style={{
                          width: `${grossTvl > 0 ? (data.overlapAmount / grossTvl) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <span style={{ fontSize: "0.72rem", color: "#5e6673", minWidth: 36, textAlign: "right" }}>
                      -{grossTvl > 0 ? ((data.overlapAmount / grossTvl) * 100).toFixed(1) : "0"}%
                    </span>
                  </div>
                </span>
                <span className="stat-value text-red">-{fmt(data.overlapAmount)}</span>
              </div>
            )}
            {/* Net total */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                paddingTop: "0.6rem",
                marginTop: "0.25rem",
                borderTop: "1px solid #1f2637",
                fontSize: "0.82rem",
              }}
            >
              <span style={{ color: "#eaecef", fontWeight: 600 }}>Net Total</span>
              <span className="text-accent" style={{ fontWeight: 700, fontSize: "0.9rem" }}>
                {fmt(data.totalTvl)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
