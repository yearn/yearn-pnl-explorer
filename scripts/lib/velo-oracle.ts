/**
 * Velodrome/Aerodrome LP token pricing via on-chain reserve decomposition.
 * Reads token0, token1, reserves, totalSupply from the pool, then prices
 * underlying tokens via DefiLlama.
 *
 * LP price = (reserve0 * price0 + reserve1 * price1) / totalSupply
 *
 * NOTE: This uses CURRENT reserves and token prices, not historical.
 * When used as a snapshot fallback for repricing old harvest reports,
 * the LP price is an approximation — it does not reflect the reserves
 * or token prices at the time of the harvest. Accurate historical pricing
 * would require archive RPC calls at each report's block + historical
 * token prices via DefiLlama's /historical endpoint.
 */

import { CHAIN_PREFIXES } from "@yearn-tvl/shared";
import { type Address, createPublicClient, http, parseAbi } from "viem";
import { base, optimism } from "viem/chains";

const PAIR_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256, uint256, uint256)",
  "function totalSupply() view returns (uint256)",
]);

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

const CHAINS: Record<number, typeof optimism | typeof base> = { 10: optimism, 8453: base };

/**
 * Price LP tokens by decomposing into underlying reserves.
 * Returns Map<lowercase_lp_address, priceUsd>.
 */
export const priceViaSugarOracle = async (chainId: number, lpAddresses: string[]): Promise<Map<string, number>> => {
  const chain = CHAINS[chainId];
  const prefix = CHAIN_PREFIXES[chainId];
  if (!chain || !prefix) return new Map();
  if (lpAddresses.length === 0) return new Map();

  const rpcUrl = process.env[`RPC_URI_FOR_${chainId}`];
  if (!rpcUrl) return new Map();

  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const prices = new Map<string, number>();

  // Collect all unique underlying tokens first
  const lpData: Array<{
    lp: string;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply: bigint;
  }> = [];

  await Promise.all(
    lpAddresses.map(async (lp) => {
      try {
        const [token0, token1, reserves, supply] = await Promise.all([
          client.readContract({ address: lp as Address, abi: PAIR_ABI, functionName: "token0" }),
          client.readContract({ address: lp as Address, abi: PAIR_ABI, functionName: "token1" }),
          client.readContract({ address: lp as Address, abi: PAIR_ABI, functionName: "getReserves" }),
          client.readContract({ address: lp as Address, abi: PAIR_ABI, functionName: "totalSupply" }),
        ]);
        if (supply > 0n) {
          lpData.push({ lp: lp.toLowerCase(), token0, token1, reserve0: reserves[0], reserve1: reserves[1], totalSupply: supply });
        }
      } catch {
        // Not a valid Solidly-style pair, skip
      }
    }),
  );

  if (lpData.length === 0) return prices;

  // Get decimals for all unique underlying tokens
  const uniqueTokens = [...new Set(lpData.flatMap((d) => [d.token0, d.token1]))];
  const decimalsMap = new Map(
    await Promise.all(
      uniqueTokens.map(async (token) => {
        try {
          const dec = await client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" });
          return [token.toLowerCase(), Number(dec)] as const;
        } catch {
          return [token.toLowerCase(), 18] as const;
        }
      }),
    ),
  );

  // Batch-fetch prices from DefiLlama
  const coinKeys = uniqueTokens.map((t) => `${prefix}:${t}`).join(",");
  const dlResult = await (async (): Promise<{ ok: true; coins: Record<string, { price: number }> } | { ok: false }> => {
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${coinKeys}`);
      if (res.ok) {
        const data = (await res.json()) as { coins: Record<string, { price: number }> };
        return { ok: true, coins: data.coins };
      }
      return { ok: true, coins: {} };
    } catch {
      return { ok: false };
    }
  })();
  if (!dlResult.ok) return prices;
  const dlPrices = dlResult.coins;

  // Compute LP token prices
  lpData.forEach((d) => {
    const dec0 = decimalsMap.get(d.token0.toLowerCase()) ?? 18;
    const dec1 = decimalsMap.get(d.token1.toLowerCase()) ?? 18;
    const p0 = dlPrices[`${prefix}:${d.token0}`]?.price ?? 0;
    const p1 = dlPrices[`${prefix}:${d.token1}`]?.price ?? 0;

    if (p0 === 0 && p1 === 0) return;

    const val0 = (Number(d.reserve0) / 10 ** dec0) * p0;
    const val1 = (Number(d.reserve1) / 10 ** dec1) * p1;
    const totalValue = val0 + val1;
    // LP tokens are 18 decimals for Solidly-style pools
    const supplyFloat = Number(d.totalSupply) / 1e18;
    if (supplyFloat === 0) return;

    const lpPrice = totalValue / supplyFloat;
    if (lpPrice > 0) {
      prices.set(d.lp, lpPrice);
    }
  });

  return prices;
};
