import { useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import { DashboardContext } from "../App";
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
import { IconLinkOut } from "../components/IconLinkOut";

const EXAMPLE_ADDRESS = "0x93a62da5a14c80f265dabc077fcee437b1a0efde";
const UNKNOWN_MODE_ORDER = ["windfall", "zero_basis", "strict"] as const;
const DEFAULT_FETCH_TYPE = "parallel" as const;
const DEFAULT_PAGINATION_MODE = "paged" as const;

type VaultVersion = "all" | "v2" | "v3";
type UnknownMode = "strict" | "zero_basis" | "windfall";
type FetchType = "seq" | "parallel";
type PaginationMode = "paged" | "all";
type VaultStatus = "ok" | "missing_metadata" | "missing_price" | "missing_pps";
type CostBasisStatus = "complete" | "partial";
type LotLocation = "vault" | "staked";
type IncomingLotLocation = LotLocation | "wallet";

interface HoldingsHistoryResponse {
  address: string;
  version?: VaultVersion;
  dataPoints: Array<{
    date: string;
    value: number;
  }>;
}

interface HoldingsPnlSummary {
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
}

interface HoldingsVaultMetadata {
  symbol: string;
  decimals: number;
  assetDecimals: number;
  tokenAddress: string;
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
  vaultShares: string;
  vaultSharesFormatted: number;
  walletShares?: string;
  walletSharesFormatted?: number;
  stakedShares: string;
  stakedSharesFormatted: number;
  knownCostBasisShares: string;
  unknownCostBasisShares: string;
  pricePerShare: number;
  tokenPrice: number;
  currentUnderlying: number;
  vaultUnderlying: number;
  walletUnderlying?: number;
  stakedUnderlying: number;
  currentKnownUnderlying: number;
  currentUnknownUnderlying: number;
  knownCostBasisUnderlying: number;
  knownCostBasisUsd: number;
  currentValueUsd: number;
  vaultValueUsd: number;
  walletValueUsd?: number;
  stakedValueUsd: number;
  unknownCostBasisValueUsd: number;
  windfallPnlUsd: number;
  realizedPnlUnderlying: number;
  realizedPnlUsd: number;
  unrealizedPnlUnderlying: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  totalEconomicGainUsd: number;
  totalDepositedUnderlying: number;
  totalWithdrawnUnderlying: number;
  eventCounts: {
    underlyingDeposits: number;
    underlyingWithdrawals: number;
    stakes: number;
    unstakes: number;
    stakingWraps?: number;
    stakingUnwraps?: number;
    externalTransfersIn: number;
    externalTransfersOut: number;
    migrationsIn: number;
    migrationsOut: number;
    unknownCostBasisTransfersIn: number;
    withdrawalsWithUnknownCostBasis: number;
  };
  metadata: HoldingsVaultMetadata | null;
}

interface HoldingsPnLLot {
  index: number;
  shares: string;
  sharesFormatted: number;
  costBasis: string | null;
  costBasisFormatted: number | null;
  acquiredAt: number | null;
  costBasisUsd: number | null;
  pricePerShareAtAcquisition: number;
  tokenPriceAtAcquisition: number;
  currentUnderlying: number;
  currentValueUsd: number;
}

interface HoldingsPnLRealizedEntry {
  timestamp: number;
  proceedsAssets: string;
  proceedsUnderlying: number;
  proceedsUsd: number;
  basisAssets: string;
  basisUnderlying: number;
  basisUsd: number;
  pnlAssets: string;
  pnlUnderlying: number;
  pnlUsd: number;
  consumedLots: HoldingsPnLLot[];
}

interface HoldingsPnLUnknownTransferInEntry {
  timestamp: number;
  location: IncomingLotLocation;
  shares: string;
  sharesFormatted: number;
  pricePerShareAtReceipt: number;
  tokenPriceAtReceipt: number;
  receiptUnderlying: number;
  receiptValueUsd: number;
}

interface HoldingsPnLUnknownWithdrawalEntry {
  timestamp: number;
  shares: string;
  sharesFormatted: number;
  proceedsAssets: string;
  proceedsUnderlying: number;
  proceedsUsd: number;
  consumedLots: HoldingsPnLLot[];
}

interface HoldingsPnlJournalLotSummary {
  lotCount: number;
  totalShares: string;
  knownShares: string;
  unknownShares: string;
  totalKnownCostBasis: string;
  totalSharesFormatted: number;
  knownSharesFormatted: number;
  unknownSharesFormatted: number;
  totalKnownCostBasisFormatted: number;
}

interface HoldingsPnLJournalEntry {
  timestamp: number;
  txHash: string;
  view: string;
  hasAddressActivity: boolean;
  rawEvents: string;
  depositShares: string;
  depositSharesFormatted: number;
  depositAssets: string;
  depositAssetsFormatted: number;
  withdrawShares: string;
  withdrawSharesFormatted: number;
  withdrawAssets: string;
  withdrawAssetsFormatted: number;
  stakeShares: string;
  stakeSharesFormatted: number;
  wrapShares?: string;
  wrapSharesFormatted?: number;
  unstakeShares: string;
  unstakeSharesFormatted: number;
  unwrapShares?: string;
  unwrapSharesFormatted?: number;
  unknownInVaultShares: string;
  unknownInVaultSharesFormatted: number;
  unknownInWalletShares?: string;
  unknownInWalletSharesFormatted?: number;
  unknownInStakedShares: string;
  unknownInStakedSharesFormatted: number;
  transferOutVaultShares: string;
  transferOutVaultSharesFormatted: number;
  transferOutWalletShares?: string;
  transferOutWalletSharesFormatted?: number;
  transferOutStakedShares: string;
  transferOutStakedSharesFormatted: number;
  realizedKnownShares: string;
  realizedKnownSharesFormatted: number;
  realizedProceedsAssets: string;
  realizedProceedsAssetsFormatted: number;
  realizedBasisAssets: string;
  realizedBasisAssetsFormatted: number;
  realizedPnlAssets: string;
  realizedPnlAssetsFormatted: number;
  vaultLotsBefore: HoldingsPnlJournalLotSummary;
  walletLotsBefore?: HoldingsPnlJournalLotSummary;
  stakedLotsBefore: HoldingsPnlJournalLotSummary;
  vaultLotsAfter: HoldingsPnlJournalLotSummary;
  walletLotsAfter?: HoldingsPnlJournalLotSummary;
  stakedLotsAfter: HoldingsPnlJournalLotSummary;
}

interface HoldingsPnLResponse {
  address: string;
  version: VaultVersion;
  unknownTransferInPnlMode: UnknownMode;
  generatedAt: string;
  summary: HoldingsPnlSummary;
  vaults: HoldingsPnLVault[];
}

interface HoldingsPnLDrilldownVault extends HoldingsPnLVault {
  currentLots: {
    vault: HoldingsPnLLot[];
    wallet?: HoldingsPnLLot[];
    staked: HoldingsPnLLot[];
  };
  realizedEntries: HoldingsPnLRealizedEntry[];
  unknownTransferInEntries: HoldingsPnLUnknownTransferInEntry[];
  unknownWithdrawalEntries: HoldingsPnLUnknownWithdrawalEntry[];
  journal: HoldingsPnLJournalEntry[];
}

interface HoldingsPnLDrilldownResponse {
  address: string;
  version: VaultVersion;
  unknownTransferInPnlMode: UnknownMode;
  generatedAt: string;
  summary: HoldingsPnlSummary;
  vaults: HoldingsPnLDrilldownVault[];
}

interface WarningItem {
  tone: "warning" | "danger" | "info";
  title: string;
  description: string;
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#151a23", border: "1px solid #1f2637", borderRadius: 8 },
  labelStyle: { color: "#eaecef" },
  itemStyle: { color: "#848e9c" },
};

const UNKNOWN_MODE_COPY: Record<UnknownMode, { title: string; description: string }> = {
  windfall: {
    title: "Windfall",
    description:
      "Unknown inbound shares are valued at receipt and attributed to windfall, while later market movement stays in realized or unrealized PnL.",
  },
  zero_basis: {
    title: "Zero Basis",
    description:
      "Unknown inbound shares are assumed to have zero basis, so their current value flows directly into realized or unrealized market PnL.",
  },
  strict: {
    title: "Strict",
    description:
      "Unknown inbound shares stay outside PnL. Their current value is isolated in unknown-basis value until the engine can prove cost basis.",
  },
};

const STATUS_LABELS: Record<VaultStatus, { label: string; tone: "healthy" | "warning" | "danger" | "info" }> = {
  ok: { label: "OK", tone: "healthy" },
  missing_metadata: { label: "Missing Metadata", tone: "danger" },
  missing_price: { label: "Missing Price", tone: "warning" },
  missing_pps: { label: "Missing PPS", tone: "info" },
};

function buildApiPath(path: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${path}?${search.toString()}`;
}

function formatAxis(value: number | null | undefined): string {
  const safeValue = Number.isFinite(value) ? (value as number) : 0;
  if (Math.abs(safeValue) >= 1e9) return `$${(safeValue / 1e9).toFixed(1)}B`;
  if (Math.abs(safeValue) >= 1e6) return `$${(safeValue / 1e6).toFixed(0)}M`;
  if (Math.abs(safeValue) >= 1e3) return `$${(safeValue / 1e3).toFixed(0)}K`;
  return `$${safeValue.toFixed(0)}`;
}

function formatUsdDetail(value: number | null | undefined, digits = 2): string {
  if (value == null) return "Unknown";
  const fractionDigits = Math.abs(value) > 0 && Math.abs(value) < 1 ? 4 : digits;
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatAmount(value: number | null | undefined, digits = 4): string {
  if (value == null) return "Unknown";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1 ? Math.max(digits, 6) : digits,
  });
}

function formatRatio(value: number, total: number): string {
  if (total <= 0) return "0.00%";
  return pctFmt(value / total);
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp * 1000));
}

function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function explorerAddressHref(chainId: number, address: string): string | null {
  const base = EXPLORER_URLS[chainId];
  return base ? `${base}/${address}` : null;
}

function explorerTxHref(chainId: number, txHash: string): string | null {
  const base = EXPLORER_URLS[chainId];
  return base ? `${base.replace("/address", "/tx")}/${txHash}` : null;
}

function explorerName(chainId: number): string {
  switch (chainId) {
    case 1:
      return "Etherscan";
    case 10:
      return "Optimistic Etherscan";
    case 137:
      return "PolygonScan";
    case 250:
      return "FTMScan";
    case 8453:
      return "BaseScan";
    case 42161:
      return "Arbiscan";
    case 100:
      return "GnosisScan";
    case 747474:
      return "KatanaScan";
    case 999:
      return "HyperEVM Scan";
    case 80094:
      return "BeraScan";
    case 146:
      return "SonicScan";
    default:
      return "Explorer";
  }
}

function pnlTextClass(value: number): string {
  return value >= 0 ? "text-green" : "text-red";
}

function eventIntensity(vault: HoldingsPnLVault): number {
  return (
    vault.eventCounts.underlyingDeposits +
    vault.eventCounts.underlyingWithdrawals +
    vault.eventCounts.stakes +
    vault.eventCounts.unstakes +
    vault.eventCounts.externalTransfersIn +
    vault.eventCounts.externalTransfersOut +
    vault.eventCounts.migrationsIn +
    vault.eventCounts.migrationsOut +
    vault.eventCounts.unknownCostBasisTransfersIn +
    vault.eventCounts.withdrawalsWithUnknownCostBasis
  );
}

function statusBadge(status: VaultStatus) {
  const meta = STATUS_LABELS[status];
  return <span className={`badge badge-${meta.tone}`}>{meta.label}</span>;
}

function costBasisBadge(status: CostBasisStatus) {
  return status === "complete" ? (
    <span className="badge badge-healthy">Complete Basis</span>
  ) : (
    <span className="badge badge-low-yield">Partial Basis</span>
  );
}

function locationBadge(location: LotLocation) {
  return (
    <span className={`badge ${location === "vault" ? "badge-info" : "badge-v2"}`}>
      {location === "vault" ? "Vault" : "Staked"}
    </span>
  );
}

function emptyLotSummary(): HoldingsPnlJournalLotSummary {
  return {
    lotCount: 0,
    totalShares: "0",
    knownShares: "0",
    unknownShares: "0",
    totalKnownCostBasis: "0",
    totalSharesFormatted: 0,
    knownSharesFormatted: 0,
    unknownSharesFormatted: 0,
    totalKnownCostBasisFormatted: 0,
  };
}

function normalizeLotLocation(location: IncomingLotLocation | null | undefined): LotLocation {
  return location === "staked" ? "staked" : "vault";
}

function normalizeVault(vault: HoldingsPnLVault): HoldingsPnLVault {
  return {
    ...vault,
    vaultShares: vault.vaultShares ?? vault.walletShares ?? "0",
    vaultSharesFormatted: vault.vaultSharesFormatted ?? vault.walletSharesFormatted ?? 0,
    vaultUnderlying: vault.vaultUnderlying ?? vault.walletUnderlying ?? 0,
    vaultValueUsd: vault.vaultValueUsd ?? vault.walletValueUsd ?? 0,
    eventCounts: {
      ...vault.eventCounts,
      stakes: vault.eventCounts.stakes ?? vault.eventCounts.stakingWraps ?? 0,
      unstakes: vault.eventCounts.unstakes ?? vault.eventCounts.stakingUnwraps ?? 0,
    },
  };
}

function normalizeJournalEntry(entry: HoldingsPnLJournalEntry): HoldingsPnLJournalEntry {
  return {
    ...entry,
    stakeShares: entry.stakeShares ?? entry.wrapShares ?? "0",
    stakeSharesFormatted: entry.stakeSharesFormatted ?? entry.wrapSharesFormatted ?? 0,
    unstakeShares: entry.unstakeShares ?? entry.unwrapShares ?? "0",
    unstakeSharesFormatted: entry.unstakeSharesFormatted ?? entry.unwrapSharesFormatted ?? 0,
    unknownInVaultShares: entry.unknownInVaultShares ?? entry.unknownInWalletShares ?? "0",
    unknownInVaultSharesFormatted: entry.unknownInVaultSharesFormatted ?? entry.unknownInWalletSharesFormatted ?? 0,
    transferOutVaultShares: entry.transferOutVaultShares ?? entry.transferOutWalletShares ?? "0",
    transferOutVaultSharesFormatted:
      entry.transferOutVaultSharesFormatted ?? entry.transferOutWalletSharesFormatted ?? 0,
    vaultLotsBefore: entry.vaultLotsBefore ?? entry.walletLotsBefore ?? emptyLotSummary(),
    vaultLotsAfter: entry.vaultLotsAfter ?? entry.walletLotsAfter ?? emptyLotSummary(),
  };
}

function normalizeDrilldownVault(vault: HoldingsPnLDrilldownVault): HoldingsPnLDrilldownVault {
  const normalizedVault = normalizeVault(vault);
  return {
    ...vault,
    ...normalizedVault,
    currentLots: {
      vault: vault.currentLots.vault ?? vault.currentLots.wallet ?? [],
      staked: vault.currentLots.staked ?? [],
    },
    realizedEntries: vault.realizedEntries,
    unknownTransferInEntries: vault.unknownTransferInEntries.map((entry) => ({
      ...entry,
      location: normalizeLotLocation(entry.location),
    })),
    unknownWithdrawalEntries: vault.unknownWithdrawalEntries,
    journal: vault.journal.map(normalizeJournalEntry),
  };
}

function normalizePnlResponse(response: HoldingsPnLResponse | null): HoldingsPnLResponse | null {
  if (!response) return null;
  return {
    ...response,
    vaults: response.vaults.map(normalizeVault),
  };
}

function normalizeDrilldownResponse(
  response: HoldingsPnLDrilldownResponse | null,
): HoldingsPnLDrilldownResponse | null {
  if (!response) return null;
  return {
    ...response,
    vaults: response.vaults.map(normalizeDrilldownVault),
  };
}

function lotSummaryCard(title: string, summary: HoldingsPnlJournalLotSummary) {
  return (
    <div className="pnl-journal-summary-card">
      <div className="pnl-journal-summary-title">{title}</div>
      <div className="stat-row">
        <span className="stat-label">Lots</span>
        <span className="stat-value">{summary.lotCount}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Total Shares</span>
        <span className="stat-value">{formatAmount(summary.totalSharesFormatted)}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Known Shares</span>
        <span className="stat-value">{formatAmount(summary.knownSharesFormatted)}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Unknown Shares</span>
        <span className="stat-value">{formatAmount(summary.unknownSharesFormatted)}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Known Basis</span>
        <span className="stat-value">{formatAmount(summary.totalKnownCostBasisFormatted)}</span>
      </div>
    </div>
  );
}

function LotTable({
  title,
  lots,
  emptyMessage,
}: {
  title: string;
  lots: HoldingsPnLLot[];
  emptyMessage: string;
}) {
  return (
    <div className="card pnl-drawer-card">
      <h2>{title}</h2>
      {lots.length === 0 ? (
        <div className="pnl-empty-state">{emptyMessage}</div>
      ) : (
        <div className="table-scroll">
          <table className="pnl-detail-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Acquired</th>
                <th className="text-right">Shares</th>
                <th className="text-right">Basis</th>
                <th className="text-right">Basis USD</th>
                <th className="text-right">Current Underlying</th>
                <th className="text-right">Current Value</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <tr key={`${title}-${lot.index}-${lot.acquiredAt ?? "unknown"}`}>
                  <td>#{lot.index}</td>
                  <td>{formatDate(lot.acquiredAt)}</td>
                  <td className="text-right">{formatAmount(lot.sharesFormatted)}</td>
                  <td className="text-right">
                    {lot.costBasisFormatted == null ? "Unknown" : formatAmount(lot.costBasisFormatted)}
                  </td>
                  <td className="text-right">{formatUsdDetail(lot.costBasisUsd)}</td>
                  <td className="text-right">{formatAmount(lot.currentUnderlying)}</td>
                  <td className="text-right">{formatUsdDetail(lot.currentValueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConsumedLotsTable({ lots }: { lots: HoldingsPnLLot[] }) {
  if (lots.length === 0) {
    return <div className="pnl-empty-state">No lot consumption was recorded for this entry.</div>;
  }

  return (
    <div className="table-scroll">
      <table className="pnl-detail-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Acquired</th>
            <th className="text-right">Shares</th>
            <th className="text-right">Basis</th>
            <th className="text-right">Basis USD</th>
            <th className="text-right">Current Value</th>
          </tr>
        </thead>
        <tbody>
          {lots.map((lot) => (
            <tr key={`consumed-${lot.index}-${lot.acquiredAt ?? "unknown"}`}>
              <td>#{lot.index}</td>
              <td>{formatDate(lot.acquiredAt)}</td>
              <td className="text-right">{formatAmount(lot.sharesFormatted)}</td>
              <td className="text-right">
                {lot.costBasisFormatted == null ? "Unknown" : formatAmount(lot.costBasisFormatted)}
              </td>
              <td className="text-right">{formatUsdDetail(lot.costBasisUsd)}</td>
              <td className="text-right">{formatUsdDetail(lot.currentValueUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderJournalDeltas(entry: HoldingsPnLJournalEntry): ReactNode[] {
  const items: Array<{ key: string; label: string; value: number; tone: string }> = [
    { key: "deposit", label: "Deposit", value: entry.depositAssetsFormatted, tone: "healthy" },
    { key: "withdraw", label: "Withdraw", value: entry.withdrawAssetsFormatted, tone: "warning" },
    { key: "stake", label: "Stake", value: entry.stakeSharesFormatted, tone: "info" },
    { key: "unstake", label: "Unstake", value: entry.unstakeSharesFormatted, tone: "info" },
    { key: "unknown-vault", label: "Unknown In Vault", value: entry.unknownInVaultSharesFormatted, tone: "warning" },
    { key: "unknown-staked", label: "Unknown In Staked", value: entry.unknownInStakedSharesFormatted, tone: "warning" },
    { key: "xfer-out-vault", label: "Transfer Out Vault", value: entry.transferOutVaultSharesFormatted, tone: "danger" },
    { key: "xfer-out-staked", label: "Transfer Out Staked", value: entry.transferOutStakedSharesFormatted, tone: "danger" },
    { key: "realized", label: "Realized", value: entry.realizedPnlAssetsFormatted, tone: entry.realizedPnlAssetsFormatted >= 0 ? "healthy" : "danger" },
  ];

  return items
    .filter((item) => Math.abs(item.value) > 0)
    .map((item) => (
      <span key={item.key} className={`pnl-delta-chip pnl-delta-chip-${item.tone}`}>
        {item.label}: {formatAmount(item.value)}
      </span>
    ));
}

function DrilldownDrawer({
  address,
  selectedVault,
  version,
  unknownMode,
  onClose,
}: {
  address: string;
  selectedVault: HoldingsPnLVault | null;
  version: VaultVersion;
  unknownMode: UnknownMode;
  onClose: () => void;
}) {
  const drawerUrl =
    address && selectedVault
      ? buildApiPath("/api/holdings/pnl/drilldown", {
          address,
          vault: selectedVault.vaultAddress.toLowerCase(),
          version,
          unknownMode,
          fetchType: DEFAULT_FETCH_TYPE,
          paginationMode: DEFAULT_PAGINATION_MODE,
        })
      : null;

  const {
    data: drilldownDataRaw,
    loading: drilldownLoading,
    error: drilldownError,
    fetchedAt: drilldownFetchedAt,
  } = useFetch<HoldingsPnLDrilldownResponse>(drawerUrl);
  const drilldownData = useMemo(() => normalizeDrilldownResponse(drilldownDataRaw), [drilldownDataRaw]);

  const drilldownVault = drilldownData?.vaults[0] ?? null;
  const activeVault = drilldownVault || selectedVault;
  const journalEntries = useMemo(
    () => (drilldownVault ? [...drilldownVault.journal].reverse() : []),
    [drilldownVault],
  );

  useEffect(() => {
    if (!selectedVault) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, selectedVault]);

  if (!selectedVault || !activeVault) return null;

  const addressHref = explorerAddressHref(activeVault.chainId, activeVault.vaultAddress);
  const stakingHref =
    activeVault.stakingVaultAddress == null
      ? null
      : explorerAddressHref(activeVault.chainId, activeVault.stakingVaultAddress);
  const tokenHref =
    activeVault.metadata == null ? null : explorerAddressHref(activeVault.chainId, activeVault.metadata.tokenAddress);
  const explorer = explorerName(activeVault.chainId);
  const totalShares = activeVault.sharesFormatted;

  return (
    <div className="pnl-drawer-backdrop" onClick={onClose}>
      <aside
        className="pnl-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Vault PnL drilldown"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pnl-drawer-header">
          <div>
            <div className="pnl-eyebrow">Vault Drilldown</div>
            <div className="pnl-drawer-title">
              {activeVault.metadata?.symbol || shortAddr(activeVault.vaultAddress)}
            </div>
            <div className="pnl-drawer-subtitle">
              {CHAIN_NAMES[activeVault.chainId] || `Chain ${activeVault.chainId}`} · {shortAddr(activeVault.vaultAddress)}
            </div>
            <div className="pnl-drawer-links">
              {addressHref && (
                <a href={addressHref} target="_blank" rel="noreferrer" className="pnl-drawer-link">
                  <span className="pnl-drawer-link-title">Vault on {explorer}</span>
                  <span className="pnl-drawer-link-meta">{shortAddr(activeVault.vaultAddress)}</span>
                  <IconLinkOut className="pnl-drawer-link-icon" />
                </a>
              )}
              {stakingHref && activeVault.stakingVaultAddress && (
                <a href={stakingHref} target="_blank" rel="noreferrer" className="pnl-drawer-link">
                  <span className="pnl-drawer-link-title">Staking on {explorer}</span>
                  <span className="pnl-drawer-link-meta">{shortAddr(activeVault.stakingVaultAddress)}</span>
                  <IconLinkOut className="pnl-drawer-link-icon" />
                </a>
              )}
              {tokenHref && activeVault.metadata && (
                <a href={tokenHref} target="_blank" rel="noreferrer" className="pnl-drawer-link">
                  <span className="pnl-drawer-link-title">Asset token on {explorer}</span>
                  <span className="pnl-drawer-link-meta">
                    {activeVault.metadata.symbol} · {shortAddr(activeVault.metadata.tokenAddress)}
                  </span>
                  <IconLinkOut className="pnl-drawer-link-icon" />
                </a>
              )}
            </div>
          </div>

          <div className="pnl-drawer-actions">
            {drilldownFetchedAt && (
              <div className="pnl-helper">Detailed data refreshed {timeAgo(drilldownFetchedAt)}</div>
            )}
            <button type="button" className="btn-export" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="pnl-drawer-body">
          <div className="pnl-inline-badges">
            {costBasisBadge(activeVault.costBasisStatus)}
            {statusBadge(activeVault.status)}
            <span className="badge badge-v3">{unknownMode.replace("_", " ")}</span>
          </div>

          <div className="metric-grid pnl-drawer-metrics">
            <div className="metric metric-accent">
              <div className="label">Current Value</div>
              <div className="value">{fmt(activeVault.currentValueUsd)}</div>
              <div className="sub">{formatAmount(activeVault.currentUnderlying)} underlying</div>
            </div>
            <div className={`metric ${activeVault.realizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className="label">Realized PnL</div>
              <div className={`value ${pnlTextClass(activeVault.realizedPnlUsd)}`}>{fmt(activeVault.realizedPnlUsd)}</div>
              <div className="sub">{formatAmount(activeVault.realizedPnlUnderlying)} underlying crystallized</div>
            </div>
            <div className={`metric ${activeVault.unrealizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className="label">Unrealized PnL</div>
              <div className={`value ${pnlTextClass(activeVault.unrealizedPnlUsd)}`}>{fmt(activeVault.unrealizedPnlUsd)}</div>
              <div className="sub">{formatAmount(activeVault.unrealizedPnlUnderlying)} underlying mark-to-market</div>
            </div>
            <div className={`metric ${activeVault.totalPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
              <div className="label">Total PnL</div>
              <div className={`value ${pnlTextClass(activeVault.totalPnlUsd)}`}>{fmt(activeVault.totalPnlUsd)}</div>
              <div className="sub">Known-basis realized + unrealized</div>
            </div>
            <div className="metric metric-blue">
              <div className="label">Known Basis USD</div>
              <div className="value">{fmt(activeVault.knownCostBasisUsd)}</div>
              <div className="sub">{formatAmount(activeVault.knownCostBasisUnderlying)} underlying basis</div>
            </div>
            {activeVault.unknownCostBasisValueUsd > 0 && (
              <div className="metric metric-yellow">
                <div className="label">Unknown Basis Value</div>
                <div className="value">{fmt(activeVault.unknownCostBasisValueUsd)}</div>
                <div className="sub">{formatAmount(activeVault.currentUnknownUnderlying)} current unknown underlying</div>
              </div>
            )}
          </div>

          {drilldownError && <div className="error">Error loading drilldown: {drilldownError}</div>}

          {!drilldownVault && drilldownLoading && (
            <>
              <SkeletonCards count={4} />
              <SkeletonChart />
            </>
          )}

          {drilldownVault && (
            <>
              <div className="pnl-lot-stack">
                <div className="card pnl-drawer-card">
                  <h2>Current Lots Summary</h2>
                  <div className="pnl-inline-stats">
                    <div className="pnl-mini-stat">
                      <span className="label">Total Shares</span>
                      <span className="value">{formatAmount(totalShares)}</span>
                    </div>
                    <div className="pnl-mini-stat">
                      <span className="label">Vault Shares %</span>
                      <span className="value">{formatRatio(activeVault.vaultSharesFormatted, totalShares)}</span>
                    </div>
                    <div className="pnl-mini-stat">
                      <span className="label">Staked Shares %</span>
                      <span className="value">{formatRatio(activeVault.stakedSharesFormatted, totalShares)}</span>
                    </div>
                    <div className="pnl-mini-stat">
                      <span className="label">Known Basis USD</span>
                      <span className="value">{formatUsdDetail(activeVault.knownCostBasisUsd)}</span>
                    </div>
                    <div className="pnl-mini-stat">
                      <span className="label">Unknown Basis USD</span>
                      <span className="value">{formatUsdDetail(activeVault.unknownCostBasisValueUsd)}</span>
                    </div>
                  </div>
                </div>

                <LotTable
                  title="Current Vault Lots"
                  lots={drilldownVault.currentLots.vault}
                  emptyMessage="No vault lots remain for this family."
                />
                <LotTable
                  title="Current Staked Lots"
                  lots={drilldownVault.currentLots.staked}
                  emptyMessage="No staked lots remain for this family."
                />
              </div>

              <div className="card pnl-drawer-card">
                <h2>Realized Entries</h2>
                <div className="pnl-section-note">
                  Explorer tx links are available in the journal section below. The realized-entry rows themselves do not carry tx hashes in the current backend response.
                </div>
                {drilldownVault.realizedEntries.length === 0 ? (
                  <div className="pnl-empty-state">No realized entries were recorded for this family.</div>
                ) : (
                  <div className="pnl-stack">
                    {drilldownVault.realizedEntries
                      .slice()
                      .reverse()
                      .map((entry, index) => (
                        <details key={`realized-${entry.timestamp}-${index}`} className="pnl-detail-card">
                          <summary className="pnl-detail-summary">
                            <div>
                              <div className="pnl-detail-title">{formatDateTime(entry.timestamp)}</div>
                              <div className="pnl-helper">
                                Proceeds {formatUsdDetail(entry.proceedsUsd)} · Basis {formatUsdDetail(entry.basisUsd)}
                              </div>
                            </div>
                            <div className={`pnl-detail-value ${pnlTextClass(entry.pnlUsd)}`}>
                              {formatUsdDetail(entry.pnlUsd)}
                            </div>
                          </summary>
                          <div className="pnl-detail-body">
                            <div className="pnl-inline-stats">
                              <div className="pnl-mini-stat">
                                <span className="label">Pnl Underlying</span>
                                <span className="value">{formatAmount(entry.pnlUnderlying)}</span>
                              </div>
                              <div className="pnl-mini-stat">
                                <span className="label">Consumed Lots</span>
                                <span className="value">{entry.consumedLots.length}</span>
                              </div>
                            </div>
                            <ConsumedLotsTable lots={entry.consumedLots} />
                          </div>
                        </details>
                      ))}
                  </div>
                )}
              </div>

              <div className="pnl-stack">
                <div className="card pnl-drawer-card">
                  <h2>Unknown Transfer-ins</h2>
                  <div className="pnl-section-note">
                    Receipt tx hashes are not exposed on these rows yet. Use the journal timeline for linked transaction inspection.
                  </div>
                  {drilldownVault.unknownTransferInEntries.length === 0 ? (
                    <div className="pnl-empty-state">No unknown-basis receipts were recorded for this family.</div>
                  ) : (
                    <div className="table-scroll">
                      <table className="pnl-detail-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Location</th>
                            <th className="text-right">Shares</th>
                            <th className="text-right">Receipt Underlying</th>
                            <th className="text-right">Receipt Value</th>
                            <th className="text-right">PPS</th>
                            <th className="text-right">Token Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drilldownVault.unknownTransferInEntries
                            .slice()
                            .reverse()
                            .map((entry, index) => (
                              <tr key={`unknown-in-${entry.timestamp}-${index}`}>
                                <td>{formatDateTime(entry.timestamp)}</td>
                                <td>{locationBadge(normalizeLotLocation(entry.location))}</td>
                                <td className="text-right">{formatAmount(entry.sharesFormatted)}</td>
                                <td className="text-right">{formatAmount(entry.receiptUnderlying)}</td>
                                <td className="text-right">{formatUsdDetail(entry.receiptValueUsd)}</td>
                                <td className="text-right">{formatAmount(entry.pricePerShareAtReceipt, 6)}</td>
                                <td className="text-right">{formatUsdDetail(entry.tokenPriceAtReceipt, 4)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="card pnl-drawer-card">
                  <h2>Unknown Withdrawals</h2>
                  <div className="pnl-section-note">
                    Withdrawal tx hashes are not exposed on these rows yet. Use the journal timeline for explorer links where available.
                  </div>
                  {drilldownVault.unknownWithdrawalEntries.length === 0 ? (
                    <div className="pnl-empty-state">No withdrawals consumed unknown-basis lots in this family.</div>
                  ) : (
                    <div className="pnl-stack">
                      {drilldownVault.unknownWithdrawalEntries
                        .slice()
                        .reverse()
                        .map((entry, index) => (
                          <details key={`unknown-withdraw-${entry.timestamp}-${index}`} className="pnl-detail-card">
                            <summary className="pnl-detail-summary">
                              <div>
                                <div className="pnl-detail-title">{formatDateTime(entry.timestamp)}</div>
                                <div className="pnl-helper">
                                  {formatAmount(entry.sharesFormatted)} shares · Proceeds {formatUsdDetail(entry.proceedsUsd)}
                                </div>
                              </div>
                              <div className="pnl-detail-value">{formatUsdDetail(entry.proceedsUsd)}</div>
                            </summary>
                            <div className="pnl-detail-body">
                              <ConsumedLotsTable lots={entry.consumedLots} />
                            </div>
                          </details>
                        ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="card pnl-drawer-card">
                <h2>Journal Timeline</h2>
                {journalEntries.length === 0 ? (
                  <div className="pnl-empty-state">No journal rows are available for this family.</div>
                ) : (
                  <div className="pnl-stack">
                    {journalEntries.map((entry, index) => {
                      const txHref = explorerTxHref(drilldownVault.chainId, entry.txHash);
                      const deltaChips = renderJournalDeltas(entry);
                      return (
                        <details key={`journal-${entry.txHash}-${index}`} className="pnl-detail-card">
                          <summary className="pnl-detail-summary">
                            <div>
                              <div className="pnl-detail-title">
                                {formatDateTime(entry.timestamp)} · {entry.view}
                              </div>
                              <div className="pnl-helper">
                                {entry.rawEvents}
                                {txHref && (
                                  <a href={txHref} target="_blank" rel="noreferrer" className="pnl-inline-action">
                                    <span>View tx on {explorer}</span>
                                    <span className="pnl-inline-action-meta">{shortAddr(entry.txHash)}</span>
                                    <IconLinkOut className="pnl-inline-action-icon" />
                                  </a>
                                )}
                              </div>
                            </div>
                            <div className="pnl-inline-badges">
                              {entry.hasAddressActivity ? (
                                <span className="badge badge-healthy">Address Activity</span>
                              ) : (
                                <span className="badge badge-info">Tx Context</span>
                              )}
                            </div>
                          </summary>
                          <div className="pnl-detail-body">
                            <div className="pnl-delta-chip-row">
                              {deltaChips.length > 0 ? deltaChips : <span className="pnl-helper">No balance-changing deltas in this computed view.</span>}
                            </div>
                            <div className="row">
                              <div className="pnl-journal-summary-grid">
                                {lotSummaryCard("Vault Lots Before", entry.vaultLotsBefore)}
                                {lotSummaryCard("Vault Lots After", entry.vaultLotsAfter)}
                              </div>
                              <div className="pnl-journal-summary-grid">
                                {lotSummaryCard("Staked Before", entry.stakedLotsBefore)}
                                {lotSummaryCard("Staked After", entry.stakedLotsAfter)}
                              </div>
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export function PnlPanel() {
  const { setLastFetchedAt } = useContext(DashboardContext);
  const [address, setAddress] = useState("");
  const [submittedAddress, setSubmittedAddress] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [version, setVersion] = useState<VaultVersion>("all");
  const [unknownMode, setUnknownMode] = useState<UnknownMode>("windfall");
  const [vaultFilter, setVaultFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | VaultStatus | CostBasisStatus>("all");
  const [selectedVaultAddress, setSelectedVaultAddress] = useState<string | null>(null);
  const debouncedVaultFilter = useDebouncedValue(vaultFilter);
  const vaultSort = useSort("currentValueUsd");

  const historyUrl = submittedAddress
    ? buildApiPath("/api/holdings/history", { address: submittedAddress, version })
    : null;
  const pnlUrl = submittedAddress
    ? buildApiPath("/api/holdings/pnl", {
        address: submittedAddress,
        version,
        unknownMode,
        fetchType: DEFAULT_FETCH_TYPE,
        paginationMode: DEFAULT_PAGINATION_MODE,
      })
    : null;

  const { data: history, loading: historyLoading, error: historyError, fetchedAt: historyFetchedAt } =
    useFetch<HoldingsHistoryResponse>(historyUrl);
  const { data: pnlRaw, loading: pnlLoading, error: pnlError, fetchedAt: pnlFetchedAt } =
    useFetch<HoldingsPnLResponse>(pnlUrl);
  const pnl = useMemo(() => normalizePnlResponse(pnlRaw), [pnlRaw]);

  const activeFetchedAt = Math.max(historyFetchedAt || 0, pnlFetchedAt || 0) || null;
  const isOverviewLoading = submittedAddress !== "" && (!history || !pnl) && (historyLoading || pnlLoading);
  const combinedError = formError || pnlError || historyError;

  useEffect(() => {
    if (activeFetchedAt) setLastFetchedAt(activeFetchedAt);
  }, [activeFetchedAt, setLastFetchedAt]);

  useEffect(() => {
    if (!selectedVaultAddress || !pnl) return;
    const stillExists = pnl.vaults.some((vault) => vault.vaultAddress.toLowerCase() === selectedVaultAddress);
    if (!stillExists) setSelectedVaultAddress(null);
  }, [pnl, selectedVaultAddress]);

  const selectedVault = useMemo(
    () =>
      pnl?.vaults.find((vault) => vault.vaultAddress.toLowerCase() === (selectedVaultAddress || "")) || null,
    [pnl, selectedVaultAddress],
  );

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

  const qualityStats = useMemo(() => {
    if (!pnl) {
      return {
        vaultValueUsd: 0,
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
        vaultValueUsd: totals.vaultValueUsd + vault.vaultValueUsd,
        stakedValueUsd: totals.stakedValueUsd + vault.stakedValueUsd,
        completeValueUsd:
          totals.completeValueUsd + (vault.costBasisStatus === "complete" ? vault.currentValueUsd : 0),
        partialValueUsd:
          totals.partialValueUsd + (vault.costBasisStatus === "partial" ? vault.currentValueUsd : 0),
        missingMetadata: totals.missingMetadata + (vault.status === "missing_metadata" ? 1 : 0),
        missingPrice: totals.missingPrice + (vault.status === "missing_price" ? 1 : 0),
        missingPps: totals.missingPps + (vault.status === "missing_pps" ? 1 : 0),
      }),
      {
        vaultValueUsd: 0,
        stakedValueUsd: 0,
        completeValueUsd: 0,
        partialValueUsd: 0,
        missingMetadata: 0,
        missingPrice: 0,
        missingPps: 0,
      },
    );
  }, [pnl]);

  const warnings = useMemo<WarningItem[]>(() => {
    if (!pnl) return [];

    const items: WarningItem[] = [];
    if (!pnl.summary.isComplete) {
      items.push({
        tone: "danger",
        title: "Accounting is partial",
        description: `${pnl.summary.partialVaults} of ${pnl.summary.totalVaults} vault families still have ambiguous cost basis.`,
      });
    }
    if (pnl.summary.totalUnknownCostBasisValueUsd > 0) {
      items.push({
        tone: "warning",
        title: "Unknown-basis value is excluded from PnL",
        description: `${formatUsdDetail(pnl.summary.totalUnknownCostBasisValueUsd)} is currently isolated because strict mode is surfacing unresolved basis.`,
      });
    } else if (pnl.summary.partialVaults > 0 && unknownMode !== "strict") {
      items.push({
        tone: "info",
        title: "Partial basis exists even though unknown value is zero",
        description: `In ${unknownMode.replace("_", " ")} mode, ambiguous receipts are re-attributed instead of being isolated as unknown-basis value.`,
      });
    }
    if (qualityStats.missingMetadata + qualityStats.missingPrice + qualityStats.missingPps > 0) {
      items.push({
        tone: "warning",
        title: "Valuation inputs are incomplete for some families",
        description: `${qualityStats.missingMetadata} missing metadata, ${qualityStats.missingPrice} missing token price, ${qualityStats.missingPps} missing PPS.`,
      });
    }

    return items;
  }, [pnl, qualityStats, unknownMode]);

  const chainRows = useMemo(() => {
    if (!pnl) return [];
    const map = new Map<
      number,
      {
        chainId: number;
        currentValueUsd: number;
        totalPnlUsd: number;
        economicGainUsd: number;
        unknownBasisUsd: number;
        vaultCount: number;
      }
    >();

    for (const vault of pnl.vaults) {
      const existing = map.get(vault.chainId) || {
        chainId: vault.chainId,
        currentValueUsd: 0,
        totalPnlUsd: 0,
        economicGainUsd: 0,
        unknownBasisUsd: 0,
        vaultCount: 0,
      };
      existing.currentValueUsd += vault.currentValueUsd;
      existing.totalPnlUsd += vault.totalPnlUsd;
      existing.economicGainUsd += vault.totalEconomicGainUsd;
      existing.unknownBasisUsd += vault.unknownCostBasisValueUsd;
      existing.vaultCount += 1;
      map.set(vault.chainId, existing);
    }

    return [...map.values()].sort((a, b) => b.currentValueUsd - a.currentValueUsd);
  }, [pnl]);

  const topVaultChart = useMemo(() => {
    if (!pnl) return [];

    return [...pnl.vaults]
      .sort((a, b) => b.currentValueUsd - a.currentValueUsd)
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
      knownCostBasisUsd: (vault) => vault.knownCostBasisUsd,
      unknownCostBasisValueUsd: (vault) => vault.unknownCostBasisValueUsd,
      eventIntensity: (vault) => eventIntensity(vault),
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
    setSelectedVaultAddress(null);
  };

  const loadExample = () => {
    setFormError(null);
    setAddress(EXAMPLE_ADDRESS);
    setSubmittedAddress(EXAMPLE_ADDRESS);
    setSelectedVaultAddress(null);
  };

  return (
    <>
      <div className="pnl-page">
        <div className="card pnl-lookup-card">
          <h2>PnL Lookup</h2>
          <div className="pnl-hero">
            <div className="pnl-hero-copy">
              <div className="pnl-eyebrow">Address Page</div>
              <div className="pnl-headline">Inspect Yearn holdings, PnL, and lot provenance from one address view.</div>
              <div className="pnl-helper">
                Overview cards and tables come from the compact `/api/holdings/pnl` response. Lot-level inspection is loaded on demand from the excessive drilldown route for the selected vault family.
              </div>
              <div className="pnl-helper">
                Fetch profile: <span className="text-accent">{DEFAULT_FETCH_TYPE}</span> +{" "}
                <span className="text-accent">{DEFAULT_PAGINATION_MODE}</span>
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

              {activeFetchedAt && <div className="pnl-helper">Last refreshed {timeAgo(activeFetchedAt)}.</div>}
            </div>

            <form className="pnl-address-form" onSubmit={handleSubmit}>
              <label className="pnl-form-label" htmlFor="holdings-address">
                Address
              </label>
              <input
                id="holdings-address"
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
                  <option value="all">All Vault Families</option>
                  <option value="v3">V3 Only</option>
                  <option value="v2">V2 Only</option>
                </select>

                <select
                  className="filter-select"
                  value={unknownMode}
                  onChange={(event) => setUnknownMode(event.target.value as UnknownMode)}
                >
                  <option value="windfall">Windfall Mode</option>
                  <option value="zero_basis">Zero Basis Mode</option>
                  <option value="strict">Strict Mode</option>
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
                {submittedAddress
                  ? `Current lookup: ${submittedAddress}`
                  : "No request will be sent until an address is submitted."}
              </div>
            </form>
          </div>
        </div>
        {combinedError && <div className="error">Error: {combinedError}</div>}

        {!submittedAddress && !combinedError && (
          <div className="card">
            <h2>Ready For Lookup</h2>
            <p className="text-dim" style={{ marginBottom: 0 }}>
              Submit an address to load a compact portfolio overview first, then inspect individual vault families with the excessive drilldown drawer only when needed.
            </p>
          </div>
        )}

        {isOverviewLoading && (
          <>
            <SkeletonCards count={6} />
            <SkeletonChart />
          </>
        )}

        {pnl && history && !isOverviewLoading && (
          <>
            {warnings.length > 0 && (
              <div className="pnl-alert-grid">
                {warnings.map((warning) => (
                  <div key={warning.title} className={`pnl-alert pnl-alert-${warning.tone}`}>
                    <div className="pnl-alert-title">{warning.title}</div>
                    <div className="pnl-alert-body">{warning.description}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="metric-grid">
              <div className="metric metric-accent">
                <div className="label">Current Value</div>
                <div className="value">{fmt(pnl.summary.totalCurrentValueUsd)}</div>
                <div className="sub">{pnl.summary.totalVaults} vault families</div>
              </div>
              <div className={`metric ${pnl.summary.totalPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
                <div className="label">Total PnL</div>
                <div className={`value ${pnlTextClass(pnl.summary.totalPnlUsd)}`}>{fmt(pnl.summary.totalPnlUsd)}</div>
                <div className="sub">Known-basis realized + unrealized PnL</div>
              </div>
              <div className={`metric ${pnl.summary.totalRealizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
                <div className="label">Realized PnL</div>
                <div className={`value ${pnlTextClass(pnl.summary.totalRealizedPnlUsd)}`}>
                  {fmt(pnl.summary.totalRealizedPnlUsd)}
                </div>
                <div className="sub">Closed lot outcomes</div>
              </div>
              <div className={`metric ${pnl.summary.totalUnrealizedPnlUsd >= 0 ? "metric-green" : "metric-red"}`}>
                <div className="label">Unrealized PnL</div>
                <div className={`value ${pnlTextClass(pnl.summary.totalUnrealizedPnlUsd)}`}>
                  {fmt(pnl.summary.totalUnrealizedPnlUsd)}
                </div>
                <div className="sub">Open known-basis lots marked to market</div>
              </div>
              <div className="metric metric-yellow">
                <div className="label">Windfall PnL</div>
                <div className="value">{fmt(pnl.summary.totalWindfallPnlUsd)}</div>
                <div className="sub">Receipt-time value isolated from market PnL in {unknownMode.replace("_", " ")} mode</div>
              </div>
              <div className={`metric ${pnl.summary.totalEconomicGainUsd >= 0 ? "metric-green" : "metric-red"}`}>
                <div className="label">Total Economic Gain</div>
                <div className={`value ${pnlTextClass(pnl.summary.totalEconomicGainUsd)}`}>
                  {fmt(pnl.summary.totalEconomicGainUsd)}
                </div>
                <div className="sub">Total PnL + windfall attribution</div>
              </div>
              {pnl.summary.totalUnknownCostBasisValueUsd > 0 && (
                <div className="metric metric-blue">
                  <div className="label">Unknown Basis Value</div>
                  <div className="value">{fmt(pnl.summary.totalUnknownCostBasisValueUsd)}</div>
                  <div className="sub">
                    {unknownMode === "strict"
                      ? "Excluded from PnL until basis is known"
                      : "Strict mode surfaces this separately"}
                  </div>
                </div>
              )}
              <div className="metric metric-purple">
                <div className="label">Basis Coverage</div>
                <div className="value">{formatRatio(qualityStats.completeValueUsd, pnl.summary.totalCurrentValueUsd)}</div>
                <div className="sub">{formatUsdDetail(qualityStats.completeValueUsd)} of current value is on complete-basis families</div>
              </div>
              <div className={`metric ${pnl.summary.isComplete ? "metric-green" : "metric-yellow"}`}>
                <div className="label">Accounting State</div>
                <div className="value">
                  {pnl.summary.completeVaults} / {pnl.summary.totalVaults}
                </div>
                <div className="sub">
                  {pnl.summary.isComplete ? "All families are complete" : `${pnl.summary.partialVaults} families remain partial`}
                </div>
              </div>
            </div>

            <div className="row">
              <div className="card">
                <h2>Portfolio Value History</h2>
                <div className="pnl-list" style={{ marginBottom: "1rem" }}>
                  <div className="pnl-list-row">
                    365d change: {fmt(historyStats.changeUsd)} ({pctFmt(historyStats.changePct)})
                  </div>
                  <div className="pnl-list-row">
                    Peak value: {fmt(historyStats.peakValue)}. Current vs peak: {pctFmt(historyStats.drawdownPct)}
                  </div>
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
                      <XAxis
                        type="number"
                        tickFormatter={formatAxis}
                        tick={{ fill: "#5e6673", fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        dataKey="name"
                        type="category"
                        tick={{ fill: "#848e9c", fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                        width={88}
                      />
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
                    Complete families: {pnl.summary.completeVaults} / {pnl.summary.totalVaults}
                  </div>
                  <div className="pnl-list-row">
                    Complete-basis value: {formatUsdDetail(qualityStats.completeValueUsd)} · Partial-basis value:{" "}
                    {formatUsdDetail(qualityStats.partialValueUsd)}
                  </div>
                  <div className="pnl-list-row">
                    Direct vault vs staked value: {formatUsdDetail(qualityStats.vaultValueUsd)} /{" "}
                    {formatUsdDetail(qualityStats.stakedValueUsd)}
                  </div>
                  <div className="pnl-list-row">
                  Missing inputs: {qualityStats.missingMetadata} metadata, {qualityStats.missingPrice} price,{" "}
                  {qualityStats.missingPps} PPS
                </div>
                <div className="pnl-list-row">
                  Economic bridge: {formatUsdDetail(pnl.summary.totalPnlUsd)} PnL +{" "}
                  {formatUsdDetail(pnl.summary.totalWindfallPnlUsd)} windfall ={" "}
                  {formatUsdDetail(pnl.summary.totalEconomicGainUsd)}
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
                        <th className="text-right">Unknown Basis</th>
                        <th className="text-right">Vaults</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chainRows.map((row) => (
                        <tr key={row.chainId}>
                          <td>{CHAIN_NAMES[row.chainId] || `Chain ${row.chainId}`}</td>
                          <td className="text-right">{fmt(row.currentValueUsd)}</td>
                          <td className={`text-right ${pnlTextClass(row.totalPnlUsd)}`}>{fmt(row.totalPnlUsd)}</td>
                          <td className={`text-right ${pnlTextClass(row.economicGainUsd)}`}>{fmt(row.economicGainUsd)}</td>
                          <td className="text-right">{fmt(row.unknownBasisUsd)}</td>
                          <td className="text-right">{row.vaultCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="pnl-table-header">
                <div>
                  <h2 style={{ marginBottom: "0.4rem" }}>Vault Breakdown</h2>
                  <div className="pnl-helper">
                    Compact overview data comes from `/api/holdings/pnl`. Use `Inspect` for excessive lot and journal detail on demand.
                  </div>
                </div>

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
                    <option value="all">All Families</option>
                    <option value="complete">Complete Basis</option>
                    <option value="partial">Partial Basis</option>
                    <option value="ok">OK</option>
                    <option value="missing_price">Missing Price</option>
                    <option value="missing_pps">Missing PPS</option>
                    <option value="missing_metadata">Missing Metadata</option>
                  </select>
                  <button
                    className="btn-export"
                    onClick={() =>
                      exportCSV(
                        "yearn-pnl-vaults.csv",
                        [
                          "Chain",
                          "Symbol",
                          "Vault",
                          "Current Value USD",
                          "Known Basis USD",
                          "Unknown Basis USD",
                          "Total PnL USD",
                          "Realized PnL USD",
                          "Unrealized PnL USD",
                          "Windfall PnL USD",
                          "Cost Basis Status",
                          "Status",
                        ],
                        visibleVaults.map((vault) => [
                          CHAIN_NAMES[vault.chainId] || vault.chainId,
                          vault.metadata?.symbol || "",
                          vault.vaultAddress,
                          vault.currentValueUsd,
                          vault.knownCostBasisUsd,
                          vault.unknownCostBasisValueUsd,
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
                      <th>Inspect</th>
                      <th {...vaultSort.th("symbol", "Vault")} />
                      <th {...vaultSort.th("chain", "Chain")} />
                      <th {...vaultSort.th("currentValueUsd", "Current", "text-right")} />
                      <th {...vaultSort.th("knownCostBasisUsd", "Known Basis", "text-right")} />
                      <th {...vaultSort.th("unknownCostBasisValueUsd", "Unknown Basis", "text-right")} />
                      <th {...vaultSort.th("totalPnlUsd", "Total PnL", "text-right")} />
                      <th {...vaultSort.th("realizedPnlUsd", "Realized", "text-right")} />
                      <th {...vaultSort.th("unrealizedPnlUsd", "Unrealized", "text-right")} />
                      <th {...vaultSort.th("windfallPnlUsd", "Windfall", "text-right")} />
                      <th {...vaultSort.th("eventIntensity", "Activity", "text-right")} />
                      <th>Basis</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVaults.map((vault) => {
                      const href = explorerAddressHref(vault.chainId, vault.vaultAddress);
                      const explorer = explorerName(vault.chainId);
                      const isSelected = selectedVaultAddress === vault.vaultAddress.toLowerCase();
                      return (
                        <tr
                          key={`${vault.chainId}:${vault.vaultAddress}`}
                          className={isSelected ? "pnl-row-selected" : undefined}
                        >
                          <td>
                            <button
                              type="button"
                              className="btn-export pnl-inspect-btn"
                              onClick={() => setSelectedVaultAddress(vault.vaultAddress.toLowerCase())}
                            >
                              Inspect
                            </button>
                          </td>
                          <td>
                            <div className="vault-name">
                              <span>{vault.metadata?.symbol || "Unknown Vault"}</span>
                            </div>
                            {href ? (
                              <a href={href} target="_blank" rel="noreferrer" className="explorer-link vault-explorer-link">
                                <span>View on {explorer}</span>
                                <span className="vault-explorer-link-meta">{shortAddr(vault.vaultAddress)}</span>
                                <IconLinkOut className="vault-explorer-link-icon" />
                              </a>
                            ) : (
                              <span className="text-dim">{shortAddr(vault.vaultAddress)}</span>
                            )}
                          </td>
                          <td>{CHAIN_NAMES[vault.chainId] || `Chain ${vault.chainId}`}</td>
                          <td className="text-right">{fmt(vault.currentValueUsd)}</td>
                          <td className="text-right">{fmt(vault.knownCostBasisUsd)}</td>
                          <td className="text-right">{fmt(vault.unknownCostBasisValueUsd)}</td>
                          <td className={`text-right ${pnlTextClass(vault.totalPnlUsd)}`}>{fmt(vault.totalPnlUsd)}</td>
                          <td className={`text-right ${pnlTextClass(vault.realizedPnlUsd)}`}>{fmt(vault.realizedPnlUsd)}</td>
                          <td className={`text-right ${pnlTextClass(vault.unrealizedPnlUsd)}`}>{fmt(vault.unrealizedPnlUsd)}</td>
                          <td className="text-right">{fmt(vault.windfallPnlUsd)}</td>
                          <td className="text-right">
                            <div>{eventIntensity(vault)}</div>
                            <div className="text-dim" style={{ fontSize: "0.7rem" }}>
                              {vault.eventCounts.unknownCostBasisTransfersIn} unknown in ·{" "}
                              {vault.eventCounts.withdrawalsWithUnknownCostBasis} unknown wd
                            </div>
                          </td>
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
      </div>

      <DrilldownDrawer
        address={submittedAddress}
        selectedVault={selectedVault}
        version={version}
        unknownMode={unknownMode}
        onClose={() => setSelectedVaultAddress(null)}
      />
    </>
  );
}
