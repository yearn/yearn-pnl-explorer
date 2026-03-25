import type { TvlSummary } from "@yearn-tvl/shared";
import { useContext, useEffect, useMemo } from "react";
import { DashboardContext } from "../App";
import { CAT_COLORS, CHAIN_NAMES, CHAIN_SHORT, CHART_COLORS, exportCSV, fmt, SkeletonCards, useFetch } from "../hooks";

export function TvlOverview() {
  const { chainFilter, setLastFetchedAt } = useContext(DashboardContext);
  const { data, loading, error, fetchedAt, retry } = useFetch<TvlSummary>("/api/tvl");

  useEffect(() => {
    if (fetchedAt) setLastFetchedAt(fetchedAt);
  }, [fetchedAt, setLastFetchedAt]);

  const chainData = useMemo(
    () =>
      data
        ? Object.entries(data.tvlByChain)
            .filter(([chain]) => chainFilter === "all" || chain === chainFilter)
            .map(([chain, rawTvl]) => {
              const overlap = (data.overlapByChain[chain] || 0) + (data.crossChainOverlapByChain[chain] || 0);
              return { chain, label: CHAIN_NAMES[Number(chain)] || CHAIN_SHORT[Number(chain)] || chain, tvl: rawTvl - overlap };
            })
            .filter((c) => c.tvl > 0)
            .sort((a, b) => b.tvl - a.tvl)
        : [],
    [data, chainFilter],
  );

  const categories = useMemo(
    () =>
      data
        ? [
            { key: "v1", name: "V1", tvl: data.v1Tvl, color: CAT_COLORS.v1 },
            { key: "v2", name: "V2", tvl: data.v2Tvl, color: CAT_COLORS.v2 },
            { key: "v3", name: "V3", tvl: data.v3Tvl, color: CAT_COLORS.v3 },
            { key: "curation", name: "Curation", tvl: data.curationTvl, color: CAT_COLORS.curation },
          ]
        : [],
    [data],
  );

  const activeCategories = useMemo(() => categories.filter((c) => c.tvl > 0), [categories]);

  if (loading) return <SkeletonCards count={1} />;
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

  const grossTvl = data.v1Tvl + data.v2Tvl + data.v3Tvl + data.curationTvl;
  const totalOverlap = data.overlapAmount + data.crossChainOverlap;
  const maxChainTvl = chainData.length > 0 ? chainData[0].tvl : 1;

  return (
    <>
      {/* ── Metric Cards ── */}
      <div className="metric-grid">
        <div className="metric metric-accent">
          <div className="label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Total TVL (Active)
            <span
              title="Sum of all deposits in active (non-retired) vaults across V1, V2, V3, and Curation categories, minus any double-counted capital where one vault deposits into another."
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "1px solid var(--text-3)",
                fontSize: "0.6rem",
                color: "var(--text-3)",
                cursor: "help",
                flexShrink: 0,
              }}
              role="img"
              aria-label="Sum of all deposits in active (non-retired) vaults across V1, V2, V3, and Curation categories, minus any double-counted capital where one vault deposits into another."
            >
              ?
            </span>
          </div>
          <div className="value">{fmt(data.totalTvl)}</div>
          <div className="sub">
            {data.vaultCount.active} active vaults across {Object.keys(data.tvlByChain).length} chains
          </div>
        </div>

        <div className="metric">
          <div className="label">Gross TVL</div>
          <div className="value text-dim">{fmt(data.activeTvl + data.retiredTvl)}</div>
          <div className="sub">All vaults before deductions</div>
        </div>

        <div className="metric metric-red">
          <div className="label">Overlap Deducted</div>
          <div className="value" style={{ color: "var(--red)" }}>
            {fmt(totalOverlap)}
          </div>
          <div className="sub">
            {fmt(data.overlapAmount)} auto+registry + {fmt(data.crossChainOverlap)} cross-chain
          </div>
        </div>

        <div className="metric">
          <div className="label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
            Retired TVL
            <span
              title="TVL sitting in vaults that are no longer actively managed — they've been shut down but still hold depositor funds that haven't been withdrawn yet."
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 16,
                height: 16,
                borderRadius: "50%",
                border: "1px solid var(--text-3)",
                fontSize: "0.6rem",
                color: "var(--text-3)",
                cursor: "help",
                flexShrink: 0,
              }}
              role="img"
              aria-label="TVL sitting in vaults that are no longer actively managed — they've been shut down but still hold depositor funds that haven't been withdrawn yet."
            >
              ?
            </span>
          </div>
          <div className="value text-dim">{fmt(data.retiredTvl)}</div>
          <div className="sub">{data.vaultCount.retired} retired vaults still holding funds</div>
        </div>
      </div>

      {/* ── TVL Composition Bar ── */}
      <div className="card">
        <h2>TVL Composition</h2>
        <div
          className="composition-bar"
          role="img"
          aria-label={`TVL composition: ${activeCategories.map((c) => `${c.name} ${fmt(c.tvl)}`).join(", ")}`}
        >
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

      {/* ── TVL by Chain ── */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>TVL by Chain</h2>
          <button
            className="btn-export"
            onClick={() =>
              exportCSV(
                "tvl-by-chain.csv",
                ["Chain", "TVL (USD)"],
                chainData.map((c) => [CHAIN_NAMES[Number(c.chain)] || c.chain, c.tvl]),
              )
            }
          >
            Export CSV
          </button>
        </div>
        <div style={{ marginTop: "0.25rem" }}>
          {chainData.map((c, i) => (
            <div className="stat-row" key={c.chain}>
              <span className="stat-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: 100, flexShrink: 0 }}>
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
          {chainData.length === 0 && (
            <div className="text-dim" style={{ textAlign: "center", padding: "1rem" }}>
              No data for selected chain
            </div>
          )}
        </div>
      </div>
    </>
  );
}
