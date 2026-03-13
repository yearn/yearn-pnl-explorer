import { useFetch, fmt, useSort } from "../hooks";

interface DeadTvlResult {
  summary: {
    totalDeadTvl: number;
    totalLowYieldTvl: number;
    healthyTvl: number;
    deadVaultCount: number;
    lowYieldCount: number;
    healthyCount: number;
  };
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: string;
    tvlUsd: number;
    gains365d: number;
    gainToTvlRatio: number;
    feeRevenue365d: number;
    classification: string;
    reportCount365d: number;
  }>;
}

interface RetiredResult {
  count: number;
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: string;
    tvlUsd: number;
  }>;
}

interface StickyResult {
  count: number;
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    tvlUsd: number;
    depositorCount: number;
    topDepositorPercent: number;
    isSingleDepositor: boolean;
  }>;
}

const CHAIN_NAMES: Record<number, string> = {
  1: "ETH", 137: "POLY", 42161: "ARB", 8453: "BASE", 100: "GNO", 747474: "KAT", 999: "HL", 80094: "BERA", 146: "SONIC",
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

function ExplorerLink({ address, chainId }: { address: string; chainId: number }) {
  const base = EXPLORER_URLS[chainId];
  if (!base) return null;
  return (
    <a href={`${base}/${address}`} target="_blank" rel="noopener noreferrer" title="View on explorer" style={{ color: "white", opacity: 0.5, textDecoration: "none", marginLeft: "0.3rem" }}>
      &#x2197;
    </a>
  );
}

function badgeClass(c: string) {
  return c === "dead" ? "badge badge-dead" : c === "low-yield" ? "badge badge-low-yield" : "badge badge-healthy";
}

export function AnalysisPanel() {
  const { data: dead, loading: l1 } = useFetch<DeadTvlResult>("/api/analysis/dead");
  const { data: retired, loading: l2 } = useFetch<RetiredResult>("/api/analysis/retired");
  const { data: sticky, loading: l3 } = useFetch<StickyResult>("/api/analysis/sticky");
  const healthSort = useSort("tvl");
  const retiredSort = useSort("tvl");
  const stickySort = useSort("tvl");

  if (l1 || l2 || l3) return <div className="loading">Loading analysis...</div>;
  if (!dead || !retired || !sticky) return null;

  const s = dead.summary;
  const totalAnalyzed = s.totalDeadTvl + s.totalLowYieldTvl + s.healthyTvl;

  const sortedHealth = healthSort.sorted(dead.vaults, {
    name: (v) => v.name || "",
    chain: (v) => CHAIN_NAMES[v.chainId] || String(v.chainId),
    category: (v) => v.category,
    tvl: (v) => v.tvlUsd,
    gains: (v) => v.gains365d,
    ratio: (v) => v.gainToTvlRatio,
    reports: (v) => v.reportCount365d,
    status: (v) => v.classification,
  });

  const sortedRetired = retiredSort.sorted(retired.vaults, {
    name: (v) => v.name || "",
    chain: (v) => CHAIN_NAMES[v.chainId] || String(v.chainId),
    tvl: (v) => v.tvlUsd,
  });

  const stickyFiltered = sticky.vaults.filter((v) => v.tvlUsd > 100_000);
  const sortedSticky = stickySort.sorted(stickyFiltered, {
    name: (v) => v.name || "",
    tvl: (v) => v.tvlUsd,
    depositors: (v) => v.depositorCount,
  });

  return (
    <>
      <div className="metric-grid">
        <div className="metric">
          <div className="label">Dead TVL</div>
          <div className="value text-red">{fmt(s.totalDeadTvl)}</div>
          <div className="sub">{s.deadVaultCount} vaults, no reports in 365d</div>
        </div>
        <div className="metric">
          <div className="label">Low-Yield TVL</div>
          <div className="value text-yellow">{fmt(s.totalLowYieldTvl)}</div>
          <div className="sub">{s.lowYieldCount} vaults, &lt;0.1% gain/TVL</div>
        </div>
        <div className="metric">
          <div className="label">Healthy TVL</div>
          <div className="value text-green">{fmt(s.healthyTvl)}</div>
          <div className="sub">{s.healthyCount} vaults</div>
        </div>
        <div className="metric">
          <div className="label">Retired (Holding TVL)</div>
          <div className="value text-dim">{fmt(retired.vaults.reduce((a, v) => a + v.tvlUsd, 0))}</div>
          <div className="sub">{retired.count} vaults</div>
        </div>
        <div className="metric">
          <div className="label">Healthy %</div>
          <div className="value">{totalAnalyzed > 0 ? ((s.healthyTvl / totalAnalyzed) * 100).toFixed(1) : 0}%</div>
          <div className="sub">of analyzed TVL</div>
        </div>
      </div>

      <div className="card">
        <h2>Vault Health (TVL &gt; $10K)</h2>
        <table>
          <thead>
            <tr>
              <th {...healthSort.th("name", "Vault")} />
              <th {...healthSort.th("chain", "Chain")} />
              <th {...healthSort.th("category", "Cat")} />
              <th {...healthSort.th("tvl", "TVL", "text-right")} />
              <th {...healthSort.th("gains", "365d Gains", "text-right")} />
              <th {...healthSort.th("ratio", "Gain/TVL", "text-right")} />
              <th {...healthSort.th("reports", "365d Reports", "text-right")} />
              <th {...healthSort.th("status", "Status")} />
            </tr>
          </thead>
          <tbody>
            {sortedHealth.slice(0, 30).map((v) => (
              <tr key={`${v.chainId}:${v.address}`}>
                <td>{v.name?.slice(0, 28) || v.address.slice(0, 10)}<ExplorerLink address={v.address} chainId={v.chainId} /></td>
                <td className="text-dim">{CHAIN_NAMES[v.chainId] || v.chainId}</td>
                <td className="text-dim">{v.category}</td>
                <td className="text-right">{fmt(v.tvlUsd)}</td>
                <td className="text-right">{fmt(v.gains365d)}</td>
                <td className="text-right">{(v.gainToTvlRatio * 100).toFixed(2)}%</td>
                <td className="text-right">{v.reportCount365d}</td>
                <td><span className={badgeClass(v.classification)}>{v.classification}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row">
        <div className="card">
          <h2>Top Retired Vaults (still holding TVL)</h2>
          <table>
            <thead>
              <tr>
                <th {...retiredSort.th("name", "Vault")} />
                <th {...retiredSort.th("chain", "Chain")} />
                <th {...retiredSort.th("tvl", "TVL", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sortedRetired.slice(0, 10).map((v) => (
                <tr key={`${v.chainId}:${v.address}`}>
                  <td>{v.name?.slice(0, 30) || v.address.slice(0, 10)}<ExplorerLink address={v.address} chainId={v.chainId} /></td>
                  <td className="text-dim">{CHAIN_NAMES[v.chainId] || v.chainId}</td>
                  <td className="text-right">{fmt(v.tvlUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Depositor Concentration (Ethereum)</h2>
          <table>
            <thead>
              <tr>
                <th {...stickySort.th("name", "Vault")} />
                <th {...stickySort.th("tvl", "TVL", "text-right")} />
                <th {...stickySort.th("depositors", "Depositors", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sortedSticky.slice(0, 15).map((v) => (
                <tr key={`${v.chainId}:${v.address}`}>
                  <td>{v.name?.slice(0, 28) || v.address.slice(0, 10)}<ExplorerLink address={v.address} chainId={v.chainId} /></td>
                  <td className="text-right">{fmt(v.tvlUsd)}</td>
                  <td className="text-right">{v.depositorCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
