/**
 * Fetch V1 vault data from on-chain (Ethereum only).
 * V1 vaults use getPricePerFullShare() instead of totalAssets().
 * TVL = totalSupply × pricePerFullShare / 1e18, priced via DefiLlama.
 */

import { db, vaultSnapshots, vaults } from "@yearn-tvl/db";
import { fetchCurrentPrices, V1_VAULTS } from "@yearn-tvl/shared";
import { and, eq } from "drizzle-orm";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

const V1_ABI = parseAbi([
  "function token() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

const STABLE_LP_SYMBOLS = [
  "yDAI+yUSDC+yUSDT+yTUSD",
  "yDAI+yUSDC+yUSDT+yBUSD",
  "crvPlain3andSUSD",
  "dusd3CRV",
  "usdp3CRV",
  "musd3CRV",
  "ust3CRV",
  "gusd3CRV",
  "husd3CRV",
  "usdn3CRV",
  "rsv3CRV",
  "tusd3CRV",
  "busd3CRV",
  "pax3CRV",
];

interface V1Data {
  address: `0x${string}`;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  name: string;
  totalSupply: bigint;
  pricePerFullShare: bigint;
  decimals: number;
}

const upsertVault = async (existing: { id: number } | undefined, addr: string, v: V1Data, now: string): Promise<number> => {
  const shared = {
    name: v.name,
    category: "v1" as const,
    source: "onchain" as const,
    assetAddress: v.token,
    assetSymbol: v.tokenSymbol,
    assetDecimals: v.tokenDecimals,
    isRetired: false,
  };

  if (existing) {
    await db
      .update(vaults)
      .set({ ...shared, updatedAt: now })
      .where(eq(vaults.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(vaults)
    .values({
      ...shared,
      address: addr,
      chainId: 1,
      v3: false,
      yearn: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: vaults.id });
  return inserted.id;
};

export const fetchV1Vaults = async () => {
  const rpcUrl = process.env.RPC_URI_FOR_1 || process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    console.error("No Ethereum RPC URL configured (RPC_URI_FOR_1 or ETH_RPC_URL)");
    return { stored: 0, errors: 0 };
  }

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  console.log(`Reading ${V1_VAULTS.length} V1 vaults on-chain...\n`);

  const vaultResults = await V1_VAULTS.reduce(
    async (accP, address) => {
      const acc = await accP;
      try {
        const [token, totalSupply, pricePerFullShare, name, decimals] = await Promise.all([
          client.readContract({ address, abi: V1_ABI, functionName: "token" }),
          client.readContract({ address, abi: V1_ABI, functionName: "totalSupply" }),
          client.readContract({ address, abi: V1_ABI, functionName: "getPricePerFullShare" }),
          client.readContract({ address, abi: V1_ABI, functionName: "name" }),
          client.readContract({ address, abi: V1_ABI, functionName: "decimals" }),
        ]);

        const [tokenSymbol, tokenDecimals] = await Promise.all([
          client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
          client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
        ]);

        acc.tokenAddresses.add(token.toLowerCase());
        acc.vaultData.push({
          address,
          token,
          tokenSymbol,
          tokenDecimals,
          name,
          totalSupply,
          pricePerFullShare,
          decimals,
        });
      } catch (err) {
        console.warn(`  Failed to read ${address}: ${(err as Error).message?.slice(0, 80)}`);
      }
      return acc;
    },
    Promise.resolve({ vaultData: [] as V1Data[], tokenAddresses: new Set<string>() }),
  );
  const { vaultData, tokenAddresses } = vaultResults;

  console.log(`  Read ${vaultData.length}/${V1_VAULTS.length} vaults successfully`);

  // Fetch token prices from DefiLlama
  const prices = await fetchCurrentPrices([...tokenAddresses].map((address) => ({ chainId: 1, address })));
  console.log(`  Got prices for ${prices.size}/${tokenAddresses.size} tokens\n`);

  const now = new Date().toISOString();

  const { stored, errors } = await vaultData.reduce(
    async (accP, v) => {
      const acc = await accP;
      try {
        const addr = getAddress(v.address);

        // TVL = totalSupply * pricePerFullShare / 1e18 (in underlying tokens)
        const underlyingAmount = (Number(v.totalSupply) * Number(v.pricePerFullShare)) / 1e18 / 10 ** v.tokenDecimals;

        // Stablecoin Curve LP fallback: ~$1/token for pools composed of stablecoins
        const tokenPrice = prices.get(v.token.toLowerCase()) || (STABLE_LP_SYMBOLS.includes(v.tokenSymbol) ? 1 : 0);

        const tvlUsd = underlyingAmount * tokenPrice;

        // Upsert vault
        const existing = await db.query.vaults.findFirst({
          where: and(eq(vaults.address, addr), eq(vaults.chainId, 1)),
        });

        const vaultId = await upsertVault(existing, addr, v, now);

        // Insert snapshot
        const totalAssetsStr = ((v.totalSupply * v.pricePerFullShare) / BigInt(1e18)).toString();

        await db.insert(vaultSnapshots).values({
          vaultId,
          tvlUsd,
          totalAssets: totalAssetsStr,
          pricePerShare: v.pricePerFullShare.toString(),
          timestamp: now,
        });

        const tvlStr = tvlUsd > 0 ? `$${(tvlUsd / 1e3).toFixed(1)}K` : "no price";
        console.log(`  ${v.name}: ${tvlStr} (${v.tokenSymbol})`);
        return { stored: acc.stored + 1, errors: acc.errors };
      } catch (err) {
        console.warn(`  Error storing ${v.address}: ${(err as Error).message?.slice(0, 80)}`);
        return { stored: acc.stored, errors: acc.errors + 1 };
      }
    },
    Promise.resolve({ stored: 0, errors: 0 }),
  );

  console.log(`\nStored ${stored} V1 vaults, ${errors} errors`);
  return { stored, errors };
};

if (import.meta.main) {
  const result = await fetchV1Vaults();
  console.log("Done:", result);
}
