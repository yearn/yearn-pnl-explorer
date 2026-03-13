import { useState } from "react";
import { useFetch, fmt, shortAddr, useSort } from "../hooks";

interface VaultTvl {
  address: string;
  chainId: number;
  name: string | null;
  category: string;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
}

interface Overlap {
  totalOverlap: number;
  autoOverlap: number;
  registryOverlap: number;
  count: number;
  overlaps: Array<{
    sourceVault: string;
    targetVault: string;
    strategyAddress: string;
    overlapUsd: number;
    sourceCategory: string;
    targetCategory: string;
    detectionMethod: "auto" | "registry";
    label?: string;
  }>;
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 137: "Polygon", 42161: "Arbitrum", 8453: "Base", 100: "Gnosis", 747474: "Katana", 999: "Hyperliquid", 80094: "Berachain", 146: "Sonic",
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

export function VaultsPanel() {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const vaultSort = useSort("tvl");
  const overlapSort = useSort("overlap");

  const url = `/api/tvl/vaults?includeRetired=${includeRetired}${categoryFilter !== "all" ? `&category=${categoryFilter}` : ""}`;
  const { data, loading } = useFetch<{ count: number; vaults: VaultTvl[] }>(url);
  const { data: overlap } = useFetch<Overlap>("/api/tvl/overlap");

  if (loading) return <div className="loading">Loading vaults...</div>;
  if (!data) return null;

  // Build per-vault overlap map (source vault → total overlap deducted)
  const vaultOverlapMap = new Map<string, number>();
  if (overlap) {
    for (const o of overlap.overlaps) {
      const key = `${o.sourceVault.toLowerCase()}`;
      vaultOverlapMap.set(key, (vaultOverlapMap.get(key) || 0) + o.overlapUsd);
    }
  }

  const sortedVaults = vaultSort.sorted(data.vaults, {
    name: (v) => v.name || "",
    address: (v) => v.address,
    chain: (v) => CHAIN_NAMES[v.chainId] || String(v.chainId),
    category: (v) => v.category,
    type: (v) => v.vaultType ?? 0,
    tvl: (v) => v.tvlUsd,
  });

  const sortedOverlaps = overlap
    ? overlapSort.sorted(overlap.overlaps, {
        source: (o) => o.sourceVault,
        target: (o) => o.targetVault,
        strategy: (o) => o.strategyAddress,
        flow: (o) => `${o.sourceCategory} → ${o.targetCategory}`,
        detection: (o) => o.detectionMethod,
        overlap: (o) => o.overlapUsd,
      })
    : [];

  return (
    <>
      <div className="card" style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: "0.85rem" }}>
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => setIncludeRetired(e.target.checked)}
            style={{ marginRight: "0.4rem" }}
          />
          Include retired
        </label>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{
            background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)",
            borderRadius: 4, padding: "0.3rem 0.5rem", fontSize: "0.85rem",
          }}
        >
          <option value="all">All categories</option>
          <option value="v2">V2</option>
          <option value="v3">V3</option>
          <option value="curation">Curation</option>
        </select>
        <span className="text-dim" style={{ fontSize: "0.85rem" }}>{data.count} vaults</span>
        {overlap && overlap.totalOverlap > 0 && (
          <span className="text-dim" style={{ fontSize: "0.8rem", marginLeft: "auto" }}>
            <span className="text-yellow">(-$X)</span> = vault-to-vault overlap deducted from TVL ({fmt(overlap.totalOverlap)} total)
          </span>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th {...vaultSort.th("name", "Vault")} />
              <th {...vaultSort.th("address", "Address")} />
              <th {...vaultSort.th("chain", "Chain")} />
              <th {...vaultSort.th("category", "Cat")} />
              <th {...vaultSort.th("type", "Type")} />
              <th {...vaultSort.th("tvl", "TVL", "text-right")} />
            </tr>
          </thead>
          <tbody>
            {sortedVaults.slice(0, 50).map((v) => (
              <tr key={`${v.chainId}:${v.address}`}>
                <td>{v.name?.slice(0, 30) || "-"}</td>
                <td className="text-dim">
                  {EXPLORER_URLS[v.chainId] ? (
                    <a href={`${EXPLORER_URLS[v.chainId]}/${v.address}`} target="_blank" rel="noopener noreferrer" style={{ color: "white" }}>{shortAddr(v.address)}</a>
                  ) : shortAddr(v.address)}
                </td>
                <td>{CHAIN_NAMES[v.chainId] || v.chainId}</td>
                <td className="text-dim">{v.category}</td>
                <td className="text-dim">{v.vaultType === 1 ? "Alloc" : v.vaultType === 2 ? "Strat" : "-"}</td>
                <td className="text-right">
                  {fmt(v.tvlUsd)}
                  {vaultOverlapMap.has(v.address.toLowerCase()) && (
                    <div className="text-yellow" style={{ fontSize: "0.75rem" }}>(-{fmt(vaultOverlapMap.get(v.address.toLowerCase())!)})</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.count > 50 && (
          <div className="text-dim" style={{ textAlign: "center", padding: "0.5rem", fontSize: "0.8rem" }}>
            Showing 50 of {data.count}
          </div>
        )}
      </div>

      {overlap && (
        <div className="card">
          <h2>Vault Overlap Flows ({overlap.count} flows, {fmt(overlap.totalOverlap)} total)</h2>
          <div className="text-dim" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }}>
            Auto-detected: {fmt(overlap.autoOverlap)} | Registry: {fmt(overlap.registryOverlap)}
          </div>
          <table>
            <thead>
              <tr>
                <th {...overlapSort.th("source", "Source Vault")} />
                <th {...overlapSort.th("target", "Target Vault")} />
                <th {...overlapSort.th("strategy", "Via Strategy")} />
                <th {...overlapSort.th("flow", "Flow")} />
                <th {...overlapSort.th("detection", "Detection")} />
                <th {...overlapSort.th("overlap", "Overlap", "text-right")} />
              </tr>
            </thead>
            <tbody>
              {sortedOverlaps.slice(0, 20).map((o, i) => (
                <tr key={i}>
                  <td>{shortAddr(o.sourceVault)}</td>
                  <td>{shortAddr(o.targetVault)}</td>
                  <td className="text-dim">{shortAddr(o.strategyAddress)}</td>
                  <td className="text-dim">{o.sourceCategory} → {o.targetCategory}</td>
                  <td>{o.detectionMethod === "registry" ? <span className="text-yellow" title={o.label}>{o.label || "registry"}</span> : <span className="text-dim">auto</span>}</td>
                  <td className="text-right text-yellow">{fmt(o.overlapUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
