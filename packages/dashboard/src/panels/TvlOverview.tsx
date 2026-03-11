import { useFetch, fmt } from "../hooks";
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

const COLORS = ["#0075ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#79c0ff", "#f0883e"];

export function TvlOverview() {
  const { data, loading, error } = useFetch<TvlSummary>("/api/tvl");

  if (loading) return <div className="loading">Loading TVL data...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const chainData = Object.entries(data.tvlByChain)
    .map(([chain, tvl]) => ({ chain, tvl }))
    .sort((a, b) => b.tvl - a.tvl);

  const categoryData = [
    { name: "V1", tvl: data.v1Tvl },
    { name: "V2", tvl: data.v2Tvl },
    { name: "V3", tvl: data.v3Tvl },
    { name: "Curation", tvl: data.curationTvl },
  ].filter((c) => c.tvl > 0);

  return (
    <>
      <div className="metric-grid">
        <div className="metric">
          <div className="label">Total TVL (Active)</div>
          <div className="value">{fmt(data.totalTvl)}</div>
          <div className="sub">{data.vaultCount.active} active vaults</div>
        </div>
        {data.v1Tvl > 0 && (
          <div className="metric">
            <div className="label">V1 TVL</div>
            <div className="value">{fmt(data.v1Tvl)}</div>
            <div className="sub">{data.vaultCount.v1} vaults</div>
          </div>
        )}
        <div className="metric">
          <div className="label">V2 TVL</div>
          <div className="value">{fmt(data.v2Tvl)}</div>
          <div className="sub">{data.vaultCount.v2} vaults</div>
        </div>
        <div className="metric">
          <div className="label">V3 TVL</div>
          <div className="value">{fmt(data.v3Tvl)}</div>
          <div className="sub">{data.vaultCount.v3} vaults</div>
        </div>
        <div className="metric">
          <div className="label">Curation TVL</div>
          <div className="value">{fmt(data.curationTvl)}</div>
          <div className="sub">{data.vaultCount.curation} vaults</div>
        </div>
        <div className="metric">
          <div className="label">Overlap Deducted</div>
          <div className="value text-yellow">{fmt(data.overlapAmount)}</div>
          <div className="sub">V3 allocator double-count</div>
        </div>
        <div className="metric">
          <div className="label">Retired Vaults</div>
          <div className="value text-dim">{data.vaultCount.retired}</div>
          <div className="sub">Excluded from totals</div>
        </div>
      </div>

      <div className="row">
        <div className="card">
          <h2>TVL by Chain</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chainData} layout="vertical" margin={{ left: 80 }}>
                <XAxis type="number" tickFormatter={(v) => fmt(v, 0)} />
                <YAxis type="category" dataKey="chain" width={75} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => fmt(v, 2)} />
                <Bar dataKey="tvl" radius={[0, 4, 4, 0]}>
                  {chainData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h2>TVL by Category</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryData} margin={{ left: 20 }}>
                <XAxis dataKey="name" />
                <YAxis tickFormatter={(v) => fmt(v, 0)} />
                <Tooltip formatter={(v: number) => fmt(v, 2)} />
                <Bar dataKey="tvl" radius={[4, 4, 0, 0]}>
                  {categoryData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </>
  );
}
