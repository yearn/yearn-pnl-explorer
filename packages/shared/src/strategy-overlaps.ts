/**
 * Strategy overlap registry: strategies that deposit into another Yearn vault
 * through an intermediary contract (strategy address ≠ target vault address).
 *
 * Auto-detection catches cases where strategy address = vault address.
 * This registry covers intermediary depositor contracts that can't be auto-detected.
 *
 * To find new entries: run `bun run scripts/detect-overlaps.ts`
 */
export interface StrategyOverlap {
  /** The intermediary strategy contract address */
  strategyAddress: `0x${string}`;
  chainId: number;
  /** The Yearn vault this strategy ultimately deposits into */
  targetVaultAddress: `0x${string}`;
  /** Human-readable label */
  label: string;
}

/**
 * Cross-chain overlap registry: vaults on one chain whose capital has migrated
 * to vaults on another chain. The source vault still holds deposits (users haven't
 * withdrawn), but the capital is already counted in the destination vault's TVL.
 *
 * This prevents double-counting when retired TVL is included in totals.
 */
export interface CrossChainOverlap {
  /** The source vault that held pre-migration deposits */
  sourceVaultAddress: `0x${string}`;
  sourceChainId: number;
  /** The destination chain where capital now lives */
  targetChainId: number;
  /** Human-readable label */
  label: string;
}

export const CROSS_CHAIN_OVERLAP_REGISTRY: CrossChainOverlap[] = [
  // V3 Katana Pre-Deposit vaults (from Kong)
  {
    sourceVaultAddress: "0x7B5A0182E400b241b317e781a4e9dEdFc1429822",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit USDC (v3)",
  },
  {
    sourceVaultAddress: "0xcc6a16Be713f6a714f68b0E1f4914fD3db15fBeF",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit WETH (v3)",
  },
  {
    sourceVaultAddress: "0x48c03B6FfD0008460F8657Db1037C7e09dEedfcb",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit USDT (v3)",
  },
  {
    sourceVaultAddress: "0x92C82f5F771F6A44CfA09357DD0575B81BF5F728",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit WBTC (v3)",
  },
  // Turtle Club Katana Pre-Deposit vaults (curation)
  {
    sourceVaultAddress: "0xF470EB50B4a60c9b069F7Fd6032532B8F5cC014d",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit USDC (curation)",
  },
  {
    sourceVaultAddress: "0xA5DaB32DbE68E6fa784e1e50e4f620a0477D3896",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit USDT (curation)",
  },
  {
    sourceVaultAddress: "0xe1Ac97e2616Ad80f69f705ff007A4bbb3655544a",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit WBTC (curation)",
  },
  {
    sourceVaultAddress: "0x77570CfEcf83bc6bB08E2cD9e8537aeA9F97eA2F",
    sourceChainId: 1,
    targetChainId: 747474,
    label: "Katana Pre-Deposit WETH (curation)",
  },
];

export const STRATEGY_OVERLAP_REGISTRY: StrategyOverlap[] = [
  {
    strategyAddress: "0x39c0aEc5738ED939876245224aFc7E09C8480a52",
    chainId: 1,
    targetVaultAddress: "0x182863131F9a4630fF9E27830d945B1413e347E8",
    label: "unknown → USDS-1 yVault",
  },
  {
    strategyAddress: "0xfF03Dce6d95aa7a30B75EFbaFD11384221B9f9B5",
    chainId: 1,
    targetVaultAddress: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204",
    label: "unknown → USDC-1 yVault",
  },
  {
    strategyAddress: "0xAeDF7d5F3112552E110e5f9D08c9997Adce0b78d",
    chainId: 1,
    targetVaultAddress: "0x182863131F9a4630fF9E27830d945B1413e347E8",
    label: "unknown → USDS-1 yVault",
  },
  {
    strategyAddress: "0x9e0A5943dFc1A85B48C191aa7c10487297aA675b",
    chainId: 1,
    targetVaultAddress: "0xc9f01b5c6048B064E6d925d1c2d7206d4fEeF8a3",
    label: "unknown → Spark USDS Compounder",
  },
];
