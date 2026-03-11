import { useFetch, fmt } from "../hooks";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
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

export function FeesPanel() {
  const { data: summary, loading: l1 } = useFetch<FeeSummary>("/api/fees");
  const { data: history, loading: l2 } = useFetch<FeeHistory>("/api/fees/history?interval=monthly");
  const { data: vaultData, loading: l3 } = useFetch<{ count: number; vaults: VaultFee[] }>("/api/fees/vaults");

  if (l1 || l2 || l3) return <div className="loading">Loading fee data...</div>;
  if (!summary || !history || !vaultData) return null;

  return (
    <>
      <div className="metric-grid">
        <div className="metric">
          <div className="label">Total Fee Revenue</div>
          <div className="value">{fmt(summary.totalFeeRevenue)}</div>
          <div className="sub">{summary.reportCount} harvest reports</div>
        </div>
        <div className="metric">
          <div className="label">Performance Fees</div>
          <div className="value text-green">{fmt(summary.performanceFeeRevenue)}</div>
          <div className="sub">From {fmt(summary.totalGains)} gains</div>
        </div>
        <div className="metric">
          <div className="label">Management Fees</div>
          <div className="value">{fmt(summary.managementFeeRevenue)}</div>
          <div className="sub">AUM-based (estimated)</div>
        </div>
        <div className="metric">
          <div className="label">Vaults with Fees</div>
          <div className="value">{summary.vaultCount}</div>
        </div>
      </div>

      <div className="card">
        <h2>Monthly Performance Fee Revenue</h2>
        <div className="chart-container" style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history.buckets}>
              <XAxis
                dataKey="period"
                tick={{ fontSize: 11 }}
                interval={2}
              />
              <YAxis tickFormatter={(v) => fmt(v, 0)} />
              <Tooltip
                formatter={(v: number) => fmt(v, 2)}
                labelStyle={{ color: "#e6edf3" }}
                contentStyle={{ background: "#161b22", border: "1px solid #30363d" }}
              />
              <Area
                type="monotone"
                dataKey="performanceFeeRevenue"
                stroke="#3fb950"
                fill="rgba(63, 185, 80, 0.15)"
                name="Perf Fees"
              />
              <Area
                type="monotone"
                dataKey="gains"
                stroke="#0075ff"
                fill="rgba(0, 117, 255, 0.08)"
                name="Gains"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="row">
        <div className="card">
          <h2>Fee Revenue by Chain</h2>
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th className="text-right">Fee Revenue</th>
                <th className="text-right">Gains</th>
                <th className="text-right">Vaults</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.byChain)
                .sort((a, b) => b[1].feeRevenue - a[1].feeRevenue)
                .map(([chain, d]) => (
                  <tr key={chain}>
                    <td>{chain}</td>
                    <td className="text-right">{fmt(d.feeRevenue)}</td>
                    <td className="text-right">{fmt(d.gains)}</td>
                    <td className="text-right">{d.vaultCount}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Top Earning Vaults</h2>
          <table>
            <thead>
              <tr>
                <th>Vault</th>
                <th className="text-right">TVL</th>
                <th className="text-right">Fees</th>
                <th className="text-right">Reports</th>
              </tr>
            </thead>
            <tbody>
              {vaultData.vaults.slice(0, 15).map((v) => (
                <tr key={`${v.chainId}:${v.address}`}>
                  <td>{v.name?.slice(0, 25) || v.address.slice(0, 10)}</td>
                  <td className="text-right">{fmt(v.tvlUsd)}</td>
                  <td className="text-right text-green">{fmt(v.totalFeeRevenue)}</td>
                  <td className="text-right text-dim">{v.reportCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
