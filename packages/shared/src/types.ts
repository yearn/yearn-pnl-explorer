export type VaultCategory = "v1" | "v2" | "v3" | "curation";

export interface TvlSummary {
  totalTvl: number;       // active + retired - overlap
  activeTvl: number;      // active only, no overlap deduction
  retiredTvl: number;     // retired only
  v1Tvl: number;
  v2Tvl: number;
  v3Tvl: number;
  curationTvl: number;
  overlapAmount: number;
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
  overlapUsd: number;
  sourceCategory: VaultCategory;
  targetCategory: VaultCategory;
  detectionMethod: "auto" | "registry";
  label?: string;
}

export interface DefillamaComparison {
  ourTotal: number;
  defillamaTotal: number;
  difference: number;
  differencePercent: number;
  retiredTvl: number;
  overlapDeducted: number;
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
