import { useState } from "react";
import { useFetch, fmt, shortAddr } from "../hooks";

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
  count: number;
  overlaps: Array<{
    sourceVault: string;
    targetVault: string;
    strategyAddress: string;
    overlapUsd: number;
    sourceCategory: string;
    targetCategory: string;
  }>;
}

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum", 137: "Polygon", 42161: "Arbitrum", 8453: "Base", 100: "Gnosis", 747474: "Katana", 999: "Hyperliquid",
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
};

export function VaultsPanel() {
  const [includeRetired, setIncludeRetired] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const url = `/api/tvl/vaults?includeRetired=${includeRetired}${categoryFilter !== "all" ? `&category=${categoryFilter}` : ""}`;
  const { data, loading } = useFetch<{ count: number; vaults: VaultTvl[] }>(url);
  const { data: overlap } = useFetch<Overlap>("/api/tvl/overlap");

  if (loading) return <div className="loading">Loading vaults...</div>;
  if (!data) return null;

  return (
    <>
      <div className="card" style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
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
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Vault</th>
              <th>Address</th>
              <th>Chain</th>
              <th>Cat</th>
              <th>Type</th>
              <th className="text-right">TVL</th>
              <th>Retired</th>
            </tr>
          </thead>
          <tbody>
            {data.vaults.slice(0, 50).map((v) => (
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
                <td className="text-right">{fmt(v.tvlUsd)}</td>
                <td>{v.isRetired ? <span className="text-red">Yes</span> : ""}</td>
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
          <h2>V3 Overlap Flows ({overlap.count} flows, {fmt(overlap.totalOverlap)} total)</h2>
          <table>
            <thead>
              <tr>
                <th>Source Vault</th>
                <th>Target Vault</th>
                <th>Via Strategy</th>
                <th>Flow</th>
                <th className="text-right">Overlap</th>
              </tr>
            </thead>
            <tbody>
              {overlap.overlaps.slice(0, 20).map((o, i) => (
                <tr key={i}>
                  <td>{shortAddr(o.sourceVault)}</td>
                  <td>{shortAddr(o.targetVault)}</td>
                  <td className="text-dim">{shortAddr(o.strategyAddress)}</td>
                  <td className="text-dim">{o.sourceCategory} → {o.targetCategory}</td>
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
