import { useMemo, useState, type FormEvent } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CHAIN_NAMES,
  CHART_COLORS,
  EXPLORER_URLS,
  SkeletonCards,
  SkeletonChart,
  exportCSV,
  fmt,
  pctFmt,
  shortAddr,
  timeAgo,
  useDebouncedValue,
  useFetch,
  useSort,
} from "../hooks";

const EXAMPLE_ADDRESS = "0x93a62da5a14c80f265dabc077fcee437b1a0efde";
const UNKNOWN_MODE_ORDER = ["windfall", "zero_basis", "strict"] as const;

type VaultVersion = "all" | "v2" | "v3";
type UnknownMode = "strict" | "zero_basis" | "windfall";
type VaultStatus = "ok" | "missing_metadata" | "missing_price" | "missing_pps";
type CostBasisStatus = "complete" | "partial";

interface HoldingsHistoryResponse {
  address: string;
  version?: VaultVersion;
  dataPoints: Array<{
    date: string;
    value: number;
  }>;
}

interface HoldingsPnLVault {
  chainId: number;
  vaultAddress: string;
  stakingVaultAddress: string | null;
  status: VaultStatus;
  costBasisStatus: CostBasisStatus;
  unknownTransferInPnlMode: UnknownMode;
  shares: string;
  sharesFormatted: number;
  walletShares: string;
  walletSharesFormatted: number;
  stakedShares: string;
  stakedSharesFormatted: number;
  knownCostBasisShares: string;
  unknownCostBasisShares: string;
  pricePerShare: number;
  tokenPrice: number;
  currentValueUsd: number;
  walletValueUsd: number;
  stakedValueUsd: number;
  unknownCostBasisValueUsd: number;
  windfallPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalEconomicGainUsd: number;
  totalDepositedUnderlying: number;
  totalWithdrawnUnderlying: number;
  eventCounts: {
    underlyingDeposits: number;
    underlyingWithdrawals: number;
    stakingWraps: number;
    stakingUnwraps: number;
    externalTransfersIn: number;
    externalTransfersOut: number;
    migrationsIn: number;
    migrationsOut: number;
    unknownCostBasisTransfersIn: number;
    withdrawalsWithUnknownCostBasis: number;
  };
  metadata: {
    symbol: string;
    decimals: number;
    tokenAddress: string;
  } | null;
}

interface HoldingsPnLResponse {
  address: string;
  version: VaultVersion;
  unknownTransferInPnlMode: UnknownMode;
  generatedAt: string;
  summary: {
    totalVaults: number;
    completeVaults: number;
    partialVaults: number;
    totalCurrentValueUsd: number;
    totalUnknownCostBasisValueUsd: number;
    totalWindfallPnlUsd: number;
    totalRealizedPnlUsd: number;
    totalUnrealizedPnlUsd: number;
    totalPnlUsd: number;
    totalEconomicGainUsd: number;
    isComplete: boolean;
  };
  vaults: HoldingsPnLVault[];
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 },
  labelStyle: { color: "#eaecef" },
  itemStyle: { color: "#848e9c" },
};

const UNKNOWN_MODE_COPY: Record<UnknownMode, { title: string; description: string }> = {
  windfall: {
    title: "Windfall",
    description: "Unknown inbound shares are treated as windfall gain, so value is counted without inventing a purchase price.",
  },
  zero_basis: {
    title: "Zero Basis",
    description: "Unknown inbound shares are assumed to have a $0 basis, so their current value flows into market PnL.",
  },
  strict: {
    title: "Strict",
    description: "Unknown inbound shares stay outside PnL math and remain tracked as unknown-basis value until cost basis is known.",
  },
};

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function statusBadge(status: VaultStatus) {
  const colors: Record<VaultStatus, { color: string; bg: string }> = {
    ok: { color: "var(--green)", bg: "var(--green-dim)" },
    missing_metadata: { color: "var(--red)", bg: "var(--red-dim)" },
    missing_price: { color: "var(--yellow)", bg: "var(--yellow-dim)" },
    missing_pps: { color: "var(--blue)", bg: "var(--blue-dim)" },
  };
  const style = colors[status];
  return (
    <span className="badge" style={{ color: style.color, background: style.bg }}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

function costBasisBadge(status: CostBasisStatus) {
  if (status === "complete") {
    return <span className="badge badge-healthy">complete</span>;
  }
  return <span className="badge badge-low-yield">partial</span>;
}

function explorerHref(chainId: number, address: string): string | null {
  const base = EXPLORER_URLS[chainId];
  return base ? `${base}/${address}` : null;
}

export function PnlPanel() {
  const [address, setAddress] = useState("");
  const [submittedAddress, setSubmittedAddress] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [version, setVersion] = useState<VaultVersion>("all");
  const [unknownMode, setUnknownMode] = useState<UnknownMode>("windfall");
  const [vaultFilter, setVaultFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | VaultStatus | CostBasisStatus>("all");
  const debouncedVaultFilter = useDebouncedValue(vaultFilter);
  const vaultSort = useSort("currentValueUsd");

  const historyUrl = submittedAddress
    ? `/api/holdings/history?address=${submittedAddress}&version=${version}`
    : null;
  const pnlUrl = submittedAddress
    ? `/api/holdings/pnl?address=${submittedAddress}&version=${version}&unknownMode=${unknownMode}`
    : null;

  const { data: history, loading: historyLoading, error: historyError, fetchedAt: historyFetchedAt } =
    useFetch<HoldingsHistoryResponse>(historyUrl);
  const { data: pnl, loading: pnlLoading, error: pnlError, fetchedAt: pnlFetchedAt } =
    useFetch<HoldingsPnLResponse>(pnlUrl);

  const activeFetchedAt = Math.max(historyFetchedAt || 0, pnlFetchedAt || 0) || null;
  const initialLoading = submittedAddress !== "" && (!history || !pnl) && (historyLoading || pnlLoading);
  const combinedError = formError || pnlError || historyError;

  const historyStats = useMemo(() => {
    if (!history || history.dataPoints.length === 0) {
      return { startValue: 0, endValue: 0, changeUsd: 0, changePct: 0, peakValue: 0, drawdownPct: 0 };
    }
    const startValue = history.dataPoints[0].value;
    const endValue = history.dataPoints[history.dataPoints.length - 1].value;
    const peakValue = history.dataPoints.reduce((max, point) => Math.max(max, point.value), 0);
    const changeUsd = endValue - startValue;
    const changePct = startValue > 0 ? changeUsd / startValue : 0;
    const drawdownPct = peakValue > 0 ? (endValue - peakValue) / peakValue : 0;
    return { startValue, endValue, changeUsd, changePct, peakValue, drawdownPct };
  }, [history]);

  const chainRows = useMemo(() => {
    if (!pnl) return [];
    const map = new Map<number, { chainId: number; currentValueUsd: number; totalPnlUsd: number; economicGainUsd: number; vaultCount: number }>();
    for (const vault of pnl.vaults) {
      const existing = map.get(vault.chainId) || {
        chainId: vault.chainId,
        currentValueUsd: 0,
        totalPnlUsd: 0,
        economicGainUsd: 0,
        vaultCount: 0,
      };
      existing.currentValueUsd += vault.currentValueUsd;
      existing.totalPnlUsd += vault.totalPnlUsd;
      existing.economicGainUsd += vault.totalEconomicGainUsd;
      existing.vaultCount += 1;
      map.set(vault.chainId, existing);
    }
    return [...map.values()].sort((a, b) => b.currentValueUsd - a.currentValueUsd);
  }, [pnl]);

  const qualityStats = useMemo(() => {
    if (!pnl) {
      return {
        walletValueUsd: 0,
        stakedValueUsd: 0,
        completeValueUsd: 0,
        partialValueUsd: 0,
        missingMetadata: 0,
        missingPrice: 0,
        missingPps: 0,
      };
    }
    return pnl.vaults.reduce(
      (totals, vault) => ({
        walletValueUsd: totals.walletValueUsd + vault.walletValueUsd,
        stakedValueUsd: totals.stakedValueUsd + vault.stakedValueUsd,
        completeValueUsd: totals.completeValueUsd + (vault.costBasisStatus === "complete" ? vault.currentValueUsd : 0),
        partialValueUsd: totals.partialValueUsd + (vault.costBasisStatus === "partial" ? vault.currentValueUsd : 0),
        missingMetadata: totals.missingMetadata + (vault.status === "missing_metadata" ? 1 : 0),
        missingPrice: totals.missingPrice + (vault.status === "missing_price" ? 1 : 0),
        missingPps: totals.missingPps + (vault.status === "missing_pps" ? 1 : 0),
      }),
      {
        walletValueUsd: 0,
        stakedValueUsd: 0,
        completeValueUsd: 0,
        partialValueUsd: 0,
        missingMetadata: 0,
        missingPrice: 0,
        missingPps: 0,
      },
    );
  }, [pnl]);

  const topVaultChart = useMemo(() => {
    if (!pnl) return [];
    return pnl.vaults
      .filter((vault) => vault.currentValueUsd > 0)
      .slice(0, 8)
      .map((vault) => ({
        name: vault.metadata?.symbol || shortAddr(vault.vaultAddress),
        currentValueUsd: vault.currentValueUsd,
      }));
  }, [pnl]);

  const visibleVaults = useMemo(() => {
    if (!pnl) return [];
    let rows = pnl.vaults;
    if (statusFilter !== "all") {
      rows = rows.filter((vault) => vault.status === statusFilter || vault.costBasisStatus === statusFilter);
    }
    if (debouncedVaultFilter.trim()) {
      const query = debouncedVaultFilter.toLowerCase();
      rows = rows.filter((vault) => {
        const symbol = vault.metadata?.symbol?.toLowerCase() || "";
        const chain = (CHAIN_NAMES[vault.chainId] || String(vault.chainId)).toLowerCase();
        return (
          symbol.includes(query) ||
          chain.includes(query) ||
          vault.vaultAddress.toLowerCase().includes(query) ||
          (vault.stakingVaultAddress || "").toLowerCase().includes(query)
        );
      });
    }
    return vaultSort.sorted(rows, {
      symbol: (vault) => vault.metadata?.symbol || "",
      chain: (vault) => CHAIN_NAMES[vault.chainId] || String(vault.chainId),
      currentValueUsd: (vault) => vault.currentValueUsd,
      totalPnlUsd: (vault) => vault.totalPnlUsd,
      realizedPnlUsd: (vault) => vault.realizedPnlUsd,
      unrealizedPnlUsd: (vault) => vault.unrealizedPnlUsd,
      windfallPnlUsd: (vault) => vault.windfallPnlUsd,
      walletValueUsd: (vault) => vault.walletValueUsd,
      stakedValueUsd: (vault) => vault.stakedValueUsd,
    });
  }, [debouncedVaultFilter, pnl, statusFilter, vaultSort]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = address.trim().toLowerCase();
    if (!isValidAddress(normalized)) {
      setFormError("Enter a valid Ethereum address.");
      return;
    }
    setFormError(null);
    setSubmittedAddress(normalized);
  };

  const loadExample = () => {
    setFormError(null);
    setAddress(EXAMPLE_ADDRESS);
    setSubmittedAddress(EXAMPLE_ADDRESS);
  };

  if (initialLoading) {
    return (
      <>
        <SkeletonCards count={6} />
        <SkeletonChart />
      </>
    );
  }

  return (
    <>
      <div className="card">
        <h2>PnL Lookup</h2>
        <div className="pnl-hero">
          <div className="pnl-hero-copy">
            <div className="pnl-eyebrow">Live API</div>
            <div className="pnl-headline">Explore wallet-level PnL, current value, and vault exposure.</div>
            <div className="pnl-helper">
              Unknown transfer-ins change how PnL is classified. The selected mode controls that treatment.
            </div>
            <div className="pnl-list pnl-mode-list">
              {UNKNOWN_MODE_ORDER.map((mode) => (
                <div
                  key={mode}
                  className={`pnl-list-row pnl-mode-row${mode === unknownMode ? " is-active" : ""}`}
                >
                  <div className="pnl-mode-label">
                    <span>{UNKNOWN_MODE_COPY[mode].title}</span>
                    {mode === unknownMode && <span className="badge badge-healthy">active</span>}
                  </div>
                  <div className="pnl-mode-desc">{UNKNOWN_MODE_COPY[mode].description}</div>
                </div>
              ))}
            </div>
            {activeFetchedAt && (
              <div className="pnl-helper">Last refreshed {timeAgo(activeFetchedAt)}.</div>
            )}
          </div>

          <form className="pnl-address-form" onSubmit={handleSubmit}>
            <label className="pnl-form-label" htmlFor="wallet-address">
              Wallet Address
            </label>
            <input
              id="wallet-address"
              className="search-input pnl-address-input"
              placeholder={EXAMPLE_ADDRESS}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="filter-bar" style={{ marginBottom: 0 }}>
              <select
                className="filter-select"
                value={version}
                onChange={(event) => setVersion(event.target.value as VaultVersion)}
              >
                <option value="all">All vaults</option>
                <option value="v3">V3 only</option>
                <option value="v2">V2 only</option>
              </select>

              <select
                className="filter-select"
                value={unknownMode}
                onChange={(event) => setUnknownMode(event.target.value as UnknownMode)}
              >
                <option value="windfall">Windfall mode</option>
                <option value="zero_basis">Zero basis mode</option>
                <option value="strict">Strict mode</option>
              </select>
            </div>
            <div className="pnl-form-actions">
              <button type="submit" className="btn-primary">
                Load PnL
              </button>
              <button type="button" className="btn-export" onClick={loadExample}>
                Load Example
              </button>
            </div>
            <div className="pnl-helper">
              {submittedAddress ? `Current lookup: ${submittedAddress}` : "Submit an address to fetch live data."}
            </div>
          </form>
        </div>
      </div>

      {combinedError && <div className="error">Error: {combinedError}</div>}

      {!submittedAddress && !combinedError && (
        <div className="card">
          <h2>Ready For Lookup</h2>
          <p className="text-dim" style={{ marginBottom: 0 }}>
            Enter a wallet address or use the example button to load live holdings history and PnL from the
            external `yearn.fi` API.
          </p>
        </div>
      )}

      {pnl && history && (
        <>
          <div className="metric-grid">
            <div className="metric metric-accent">
              <div className="label">Current Value</div>
              <div className="value">{fmt(pnl.summary.totalCurrentValueUsd)}</div>
              <div className="sub">{pnl.summary.totalVaults} vault families</div>
            </div>
            <div className={`metric ${pnl.summary.totalPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className="label">Total PnL</div>
              <div className={`value ${pnl.summary.totalPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                {fmt(pnl.summary.totalPnlUsd)}
              </div>
              <div className="sub">Realized + unrealized market PnL</div>
            </div>
            <div className={`metric ${pnl.summary.totalRealizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className="label">Realized PnL</div>
              <div className={`value ${pnl.summary.totalRealizedPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                {fmt(pnl.summary.totalRealizedPnlUsd)}
              </div>
              <div className="sub">Closed lot outcomes only</div>
            </div>
            <div className={`metric ${pnl.summary.totalUnrealizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className={`value ${pnl.summary.totalUnrealizedPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                {fmt(pnl.summary.totalUnrealizedPnlUsd)}
              </div>
              <div className="label">Unrealized PnL</div>
              <div className="sub">Mark-to-market on open lots</div>
            </div>
            <div className="metric metric-blue">
              <div className="label">Economic Gain</div>
              <div className="value">{fmt(pnl.summary.totalEconomicGainUsd)}</div>
              <div className="sub">Market PnL + windfall attribution</div>
            </div>
            <div className="metric metric-yellow">
              <div className="label">Windfall PnL</div>
              <div className="value">{fmt(pnl.summary.totalWindfallPnlUsd)}</div>
              <div className="sub">{unknownMode.replace("_", " ")} mode</div>
            </div>
          </div>

          <div className="row">
            <div className="card">
              <h2>Portfolio Value History</h2>
              <div className="pnl-list" style={{ marginBottom: "1rem" }}>
                <div className="pnl-list-row">365d change: {fmt(historyStats.changeUsd)} ({pctFmt(historyStats.changePct)})</div>
                <div className="pnl-list-row">Peak value: {fmt(historyStats.peakValue)}. Current vs peak: {pctFmt(historyStats.drawdownPct)}</div>
              </div>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={history.dataPoints}>
                    <defs>
                      <linearGradient id="pnlHistoryFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2ee6b6" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#2ee6b6" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "#848e9c", fontSize: 11 }}
                      tickFormatter={(value: string) => value.slice(5)}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={formatAxis}
                      tick={{ fill: "#5e6673", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={60}
                    />
                    <Tooltip
                      formatter={(value: number) => fmt(value)}
                      labelFormatter={(label: string) => label}
                      {...TOOLTIP_STYLE}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#2ee6b6"
                      strokeWidth={2}
                      fill="url(#pnlHistoryFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card">
              <h2>Top Current Positions</h2>
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topVaultChart} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 16 }}>
                    <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
                    <XAxis type="number" tickFormatter={formatAxis} tick={{ fill: "#5e6673", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis dataKey="name" type="category" tick={{ fill: "#848e9c", fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip
                      formatter={(value: number) => fmt(value)}
                      cursor={{ fill: "rgba(255, 255, 255, 0.025)" }}
                      {...TOOLTIP_STYLE}
                    />
                    <Bar
                      dataKey="currentValueUsd"
                      radius={[0, 6, 6, 0]}
                      activeBar={{ fillOpacity: 0.9, strokeOpacity: 0 }}
                    >
                      {topVaultChart.map((entry, index) => (
                        <Cell key={`${entry.name}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="card">
              <h2>Accounting Quality</h2>
              <div className="pnl-list">
                <div className="pnl-list-row">
                  <span>Complete vaults: {pnl.summary.completeVaults} / {pnl.summary.totalVaults}</span>
                </div>
                <div className="pnl-list-row">
                  <span>Complete-basis value: {fmt(qualityStats.completeValueUsd)}</span>
                </div>
                <div className="pnl-list-row">
                  <span>Partial-basis value: {fmt(qualityStats.partialValueUsd)}</span>
                </div>
                <div className="pnl-list-row">
                  <span>Wallet vs staked: {fmt(qualityStats.walletValueUsd)} / {fmt(qualityStats.stakedValueUsd)}</span>
                </div>
                <div className="pnl-list-row">
                  <span>Status gaps: {qualityStats.missingMetadata} metadata, {qualityStats.missingPrice} price, {qualityStats.missingPps} PPS</span>
                </div>
              </div>
            </div>

            <div className="card">
              <h2>By Chain</h2>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Chain</th>
                      <th className="text-right">Current</th>
                      <th className="text-right">Total PnL</th>
                      <th className="text-right">Economic Gain</th>
                      <th className="text-right">Vaults</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.map((row) => (
                      <tr key={row.chainId}>
                        <td>{CHAIN_NAMES[row.chainId] || `Chain ${row.chainId}`}</td>
                        <td className="text-right">{fmt(row.currentValueUsd)}</td>
                        <td className={`text-right ${row.totalPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                          {fmt(row.totalPnlUsd)}
                        </td>
                        <td className={`text-right ${row.economicGainUsd >= 0 ? "text-green" : "text-red"}`}>
                          {fmt(row.economicGainUsd)}
                        </td>
                        <td className="text-right">{row.vaultCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
              <h2 style={{ marginBottom: 0 }}>Vault Breakdown</h2>
              <div className="filter-bar" style={{ marginBottom: 0 }}>
                <input
                  className="search-input"
                  placeholder="Filter vaults, symbols, chains..."
                  value={vaultFilter}
                  onChange={(event) => setVaultFilter(event.target.value)}
                />
                <select
                  className="filter-select"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as "all" | VaultStatus | CostBasisStatus)}
                >
                  <option value="all">All statuses</option>
                  <option value="complete">Complete basis</option>
                  <option value="partial">Partial basis</option>
                  <option value="ok">OK</option>
                  <option value="missing_price">Missing price</option>
                  <option value="missing_pps">Missing PPS</option>
                  <option value="missing_metadata">Missing metadata</option>
                </select>
                <button
                  className="btn-export"
                  onClick={() =>
                    exportCSV(
                      "pnl-vault-breakdown.csv",
                      ["Chain", "Symbol", "Vault", "Current Value", "Total PnL", "Realized", "Unrealized", "Windfall", "Cost Basis", "Status"],
                      visibleVaults.map((vault) => [
                        CHAIN_NAMES[vault.chainId] || vault.chainId,
                        vault.metadata?.symbol || "",
                        vault.vaultAddress,
                        vault.currentValueUsd,
                        vault.totalPnlUsd,
                        vault.realizedPnlUsd,
                        vault.unrealizedPnlUsd,
                        vault.windfallPnlUsd,
                        vault.costBasisStatus,
                        vault.status,
                      ]),
                    )
                  }
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th {...vaultSort.th("symbol", "Vault")} />
                    <th {...vaultSort.th("chain", "Chain")} />
                    <th {...vaultSort.th("currentValueUsd", "Current", "text-right")} />
                    <th {...vaultSort.th("totalPnlUsd", "Total PnL", "text-right")} />
                    <th {...vaultSort.th("realizedPnlUsd", "Realized", "text-right")} />
                    <th {...vaultSort.th("unrealizedPnlUsd", "Unrealized", "text-right")} />
                    <th {...vaultSort.th("windfallPnlUsd", "Windfall", "text-right")} />
                    <th {...vaultSort.th("walletValueUsd", "Wallet", "text-right")} />
                    <th {...vaultSort.th("stakedValueUsd", "Staked", "text-right")} />
                    <th>Basis</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleVaults.map((vault) => {
                    const href = explorerHref(vault.chainId, vault.vaultAddress);
                    return (
                      <tr key={`${vault.chainId}:${vault.vaultAddress}`}>
                        <td>
                          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                            <strong>{vault.metadata?.symbol || "Unknown"}</strong>
                            {href ? (
                              <a href={href} target="_blank" rel="noreferrer" className="text-dim">
                                {shortAddr(vault.vaultAddress)}
                              </a>
                            ) : (
                              <span className="text-dim">{shortAddr(vault.vaultAddress)}</span>
                            )}
                          </div>
                        </td>
                        <td>{CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`}</td>
                        <td className="text-right">{fmt(vault.currentValueUsd)}</td>
                        <td className={`text-right ${vault.totalPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                          {fmt(vault.totalPnlUsd)}
                        </td>
                        <td className={`text-right ${vault.realizedPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                          {fmt(vault.realizedPnlUsd)}
                        </td>
                        <td className={`text-right ${vault.unrealizedPnlUsd >= 0 ? "text-green" : "text-red"}`}>
                          {fmt(vault.unrealizedPnlUsd)}
                        </td>
                        <td className="text-right">{fmt(vault.windfallPnlUsd)}</td>
                        <td className="text-right">{fmt(vault.walletValueUsd)}</td>
                        <td className="text-right">{fmt(vault.stakedValueUsd)}</td>
                        <td>{costBasisBadge(vault.costBasisStatus)}</td>
                        <td>{statusBadge(vault.status)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
