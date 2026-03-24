export type VaultCategory = "v1" | "v2" | "v3" | "curation";

export interface TvlSummary {
  totalTvl: number; // active + retired - overlap
  activeTvl: number; // active only, no overlap deduction
  retiredTvl: number; // retired only
  v1Tvl: number;
  v2Tvl: number;
  v3Tvl: number;
  curationTvl: number;
  overlapAmount: number;
  crossChainOverlap: number;
  crossChainOverlapByCategory: Record<VaultCategory, number>;
  overlapByChain: Record<string, number>;
  crossChainOverlapByChain: Record<string, number>;
  tvlByChain: Record<string, number>;
  tvlByCategory: Record<VaultCategory, number>;
  retiredTvlByCategory: Record<VaultCategory, number>;
  vaultCount: {
    total: number;
    v1: number;
    v2: number;
    v3: number;
    curation: number;
    active: number;
    retired: number;
  };
}

export interface VaultTvl {
  address: string;
  chainId: number;
  name: string | null;
  category: VaultCategory;
  vaultType: number | null;
  tvlUsd: number;
  isRetired: boolean;
}

export interface OverlapDetail {
  sourceVault: string;
  targetVault: string;
  strategyAddress: string;
  chainId: number;
  overlapUsd: number;
  sourceCategory: VaultCategory;
  targetCategory: VaultCategory;
  detectionMethod: "auto" | "registry";
  label?: string;
}

export interface GapComponent {
  label: string;
  amount: number;
  explanation: string;
}

export interface DefillamaComparison {
  ourTotal: number;
  defillamaTotal: number;
  difference: number;
  differencePercent: number;
  retiredTvl: number;
  overlapDeducted: number;
  crossChainOverlap: number;
  grossTvl: number;
  gapComponents: GapComponent[];
  retiredTvlByChain: Record<string, number>;
  notes: string[];
  byChain: Array<{
    chain: string;
    ours: number;
    defillama: number;
    difference: number;
  }>;
  byCategory: Array<{
    category: string;
    defillamaProtocol: string;
    ours: number;
    defillama: number;
    difference: number;
  }>;
}

export interface VaultStickiness {
  address: string;
  chainId: number;
  name: string | null;
  currentTvl: number;
  scores: {
    "30d": StickinessScore | null;
    "90d": StickinessScore | null;
    "365d": StickinessScore | null;
  };
  history: Array<{ timestamp: number; tvlUsd: number }>;
}

export interface StickinessScore {
  score: number;
  grade: string;
  dataPoints: number;
}

export interface TvlHistoryPoint {
  timestamp: number;
  tvlUsd: number;
  chain?: string;
  protocol?: string;
}

/** Fee stacking analysis types — tree structure for vault→vault fee chains */
export interface FeeStackNode {
  vault: { address: string; chainId: number; name: string | null };
  perfFee: number; // bps
  mgmtFee: number; // bps
  capitalUsd: number; // debtUsd flowing into this vault
  children: FeeStackNode[]; // downstream vaults this vault deposits into
}

export interface FeeStackChain {
  root: FeeStackNode;
  maxDepth: number;
  effectivePerfFee: number; // compound bps across deepest path
  effectiveMgmtFee: number; // additive bps across deepest path
}

export interface FeeStackSummary {
  chains: FeeStackChain[];
  maxDepth: number;
  maxEffectivePerfFee: number;
  avgEffectivePerfFee: number;
  totalStackedCapital: number;
}

/** Raw Kong GraphQL vault response shape */
export interface KongVault {
  address: string;
  name: string;
  chainId: number;
  apiVersion: string;
  v3: boolean;
  yearn: boolean;
  vaultType: number;
  tvl: { close: number; blockTime: string };
  totalAssets: string;
  totalIdle: string;
  asset: { address: string; symbol: string; decimals: number };
  debts: Array<{
    strategy: string;
    currentDebt: string;
    currentDebtUsd: number;
    maxDebt: string;
  }>;
  fees: { managementFee: number; performanceFee: number };
  meta: { isRetired: boolean };
  strategies: string[];
}
