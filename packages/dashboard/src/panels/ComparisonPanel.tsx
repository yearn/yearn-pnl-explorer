import { useFetch, fmt, pct, useSort } from "../hooks";

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

export function ComparisonPanel() {
  const { data, loading, error } = useFetch<Comparison>("/api/comparison");
  const catSort = useSort("ours");
  const chainSort = useSort("ours");

  if (loading) return <div className="loading">Loading comparison...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  const diffColor = Math.abs(data.differencePercent) < 5 ? "text-green" : "text-yellow";

  const sortedCats = catSort.sorted(data.byCategory, {
    category: (c) => c.category,
    protocol: (c) => c.defillamaProtocol,
    ours: (c) => c.ours,
    defillama: (c) => c.defillama,
    diff: (c) => c.difference,
  });

  const sortedChains = chainSort.sorted(data.byChain, {
    chain: (c) => c.chain,
    ours: (c) => c.ours,
    defillama: (c) => c.defillama,
    diff: (c) => c.difference,
  });

  return (
    <>
      <div className="metric-grid">
        <div className="metric">
          <div className="label">Our Total</div>
          <div className="value">{fmt(data.ourTotal)}</div>
        </div>
        <div className="metric">
          <div className="label">DefiLlama Total</div>
          <div className="value">{fmt(data.defillamaTotal)}</div>
        </div>
        <div className="metric">
          <div className="label">Difference</div>
          <div className={`value ${diffColor}`}>
            {fmt(data.difference)} ({pct(data.differencePercent)})
          </div>
        </div>
        <div className="metric">
          <div className="label">Retired TVL</div>
          <div className="value text-dim">{fmt(data.retiredTvl)}</div>
          <div className="sub">Excluded from both</div>
        </div>
      </div>

      {data.notes.length > 0 && (
        <div className="card">
          <h2>Notes</h2>
          <ul style={{ paddingLeft: "1.2rem", color: "var(--text-dim)", fontSize: "0.85rem" }}>
            {data.notes.map((n, i) => (
              <li key={i} style={{ marginBottom: "0.3rem" }}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="row">
        <div className="card">
          <h2>By Category</h2>
          <table>
            <thead>
              <tr>
                <th {...catSort.th("category", "Category")} />
                <th {...catSort.th("protocol", "DL Protocol")} />
                <th {...catSort.th("ours", "Ours", "text-right")} />
                <th {...catSort.th("defillama", "DefiLlama", "text-right")} />
                <th {...catSort.th("diff", "Diff", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sortedCats.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td className="text-dim">{c.defillamaProtocol}</td>
                  <td className="text-right">{fmt(c.ours)}</td>
                  <td className="text-right">{fmt(c.defillama)}</td>
                  <td className={`text-right ${c.difference >= 0 ? "text-green" : "text-red"}`}>
                    {fmt(c.difference)}
                  </td>
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
                <th {...chainSort.th("ours", "Ours", "text-right")} />
                <th {...chainSort.th("defillama", "DefiLlama", "text-right")} />
                <th {...chainSort.th("diff", "Diff", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sortedChains.map((c) => (
                <tr key={c.chain}>
                  <td>{c.chain}</td>
                  <td className="text-right">{fmt(c.ours)}</td>
                  <td className="text-right">{fmt(c.defillama)}</td>
                  <td className={`text-right ${c.difference >= 0 ? "text-green" : "text-red"}`}>
                    {fmt(c.difference)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
