import { Fragment, useState, useContext, useMemo } from "react";
import { DashboardContext } from "../App";
import { useFetch, fmt, useSort, CHAIN_NAMES, CHART_COLORS, SkeletonCards, SkeletonChart, bpsPct } from "../hooks";
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

interface FeeStackNode {
  vault: { address: string; chainId: number; name: string | null };
  perfFee: number;
  mgmtFee: number;
  capitalUsd: number;
  children: FeeStackNode[];
}

interface FeeStackChain {
  root: FeeStackNode;
  maxDepth: number;
  effectivePerfFee: number;
  effectiveMgmtFee: number;
}

interface FeeStackSummary {
  chains: FeeStackChain[];
  maxDepth: number;
  maxEffectivePerfFee: number;
  avgEffectivePerfFee: number;
  totalStackedCapital: number;
}

/** Flatten a tree node into table rows with depth info */
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
  const { chainFilter, density } = useContext(DashboardContext);
  const [timePreset, setTimePreset] = useState(4); // default "All"

  const sinceTs = getSinceTs(TIME_PRESETS[timePreset]?.days ?? 0);
  const sinceQ = sinceTs != null ? `?since=${sinceTs}` : "";
  const { data: summary, loading: l1 } = useFetch<FeeSummary>(`/api/fees${sinceQ}`);
  const { data: history, loading: l2 } = useFetch<FeeHistory>("/api/fees/history?interval=monthly");
  const { data: vaultData, loading: l3 } = useFetch<{ count: number; vaults: VaultFee[] }>(`/api/fees/vaults${sinceQ}`);
  const { data: feeStack } = useFetch<FeeStackSummary>("/api/fees/stack");
  const stackSort = useSort("feeCaptured");
  const [expandedStack, setExpandedStack] = useState<number | null>(null);

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

  const sortedStacks = useMemo(() => {
    if (!feeStack) return [];
    type ChainWithFee = FeeStackChain & { feeCaptured: number };
    const withFees: ChainWithFee[] = feeStack.chains.map((c) => ({
      ...c,
      feeCaptured: c.root.capitalUsd * (c.effectivePerfFee / 10000),
    }));
    return stackSort.sorted(withFees, {
      name: (c) => c.root.vault.name || "",
      perfFee: (c) => c.root.perfFee,
      feeCaptured: (c) => c.feeCaptured,
      effective: (c) => c.effectivePerfFee,
    });
  }, [feeStack, stackSort.sortKey, stackSort.sortDir]);

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

      {/* ---- Fee Analysis ---- */}
      {feeStack && feeStack.chains.length > 0 && (() => {
        const maxCap = Math.max(...feeStack.chains.map((c) => c.root.capitalUsd), 1);
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
              <div className="value">{feeStack.chains.length}</div>
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
                </tr>
              </thead>
              <tbody>
                {sortedStacks.map((chain, idx) => {
                  const isOpen = expandedStack === idx;
                  const rows = flattenTree(chain.root, 0, true);
                  const feeCaptured = chain.feeCaptured;
                  const barPct = maxCap > 0 ? (chain.root.capitalUsd / maxCap) * 100 : 0;
                  return (
                    <Fragment key={`stack-${idx}`}>
                      <tr
                        onClick={() => setExpandedStack(isOpen ? null : idx)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <span style={{ color: "var(--text-3)", marginRight: 6, fontSize: "0.7rem" }}>
                            {isOpen ? "\u25BC" : "\u25B6"}
                          </span>
                          <span style={{ fontWeight: 600 }}>
                            {chain.root.vault.name?.slice(0, 30) || chain.root.vault.address.slice(0, 10)}
                          </span>
                          <span className="text-dim" style={{ marginLeft: 6, fontSize: "0.7rem" }}>
                            {CHAIN_NAMES[chain.root.vault.chainId] || chain.root.vault.chainId}
                          </span>
                        </td>
                        <td className="text-right">{bpsPct(chain.root.perfFee)}</td>
                        <td className="text-right">
                          <div className="inline-bar">
                            <span className="text-green">{fmt(feeCaptured)}</span>
                            <div className="inline-bar-track">
                              <div
                                className="inline-bar-fill fill-green"
                                style={{ width: `${barPct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="text-right">
                          <span className="text-yellow" style={{ fontWeight: 600 }}>{bpsPct(chain.effectivePerfFee)}</span>
                          <span className="text-dim" style={{ fontSize: "0.7rem", marginLeft: 4 }}>
                            depth {chain.maxDepth}
                          </span>
                        </td>
                      </tr>
                      {isOpen && rows.map(({ node, depth, isLast }, ri) => {
                        const paddingLeft = 1.0 + depth * 1.6;
                        const isRoot = depth === 0;
                        const isLeafStrategy = node.children.length === 0 && node.perfFee === 0 && !isRoot;
                        const rowOpacity = isLeafStrategy ? 0.55 : 1;
                        const hopFee = node.capitalUsd * (node.perfFee / 10000);
                        return (
                          <tr
                            key={`stack-${idx}-${ri}`}
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
                                <span className="text-dim" style={{ fontSize: "0.65rem", marginLeft: 4 }}>
                                  ({CHAIN_NAMES[node.vault.chainId] || node.vault.chainId})
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
                                <span className="text-dim" style={{ fontSize: "0.7rem" }}>root</span>
                              ) : isLeafStrategy ? (
                                <span className="text-dim" style={{ fontSize: "0.65rem" }}>strategy</span>
                              ) : (
                                <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                                  +{bpsPct(node.perfFee)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {isOpen && (
                        <tr style={{ background: "rgba(46, 230, 182, 0.06)", borderTop: "1px solid var(--border)" }}>
                          <td style={{ paddingLeft: "1rem" }}>
                            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                              Effective total
                            </span>
                          </td>
                          <td className="text-right">
                            <span className="text-yellow" style={{ fontWeight: 600 }}>{bpsPct(chain.effectivePerfFee)}</span>
                          </td>
                          <td className="text-right text-green" style={{ fontWeight: 600 }}>
                            {fmt(feeCaptured)}
                          </td>
                          <td className="text-right">
                            <span className="text-dim" style={{ fontSize: "0.7rem" }}>weighted</span>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}
    </>
  );
}
