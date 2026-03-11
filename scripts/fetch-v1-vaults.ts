/**
 * Fetch V1 vault data from on-chain (Ethereum only).
 * V1 vaults use getPricePerFullShare() instead of totalAssets().
 * TVL = totalSupply × pricePerFullShare / 1e18, priced via DefiLlama.
 */
import { createPublicClient, http, parseAbi, formatUnits, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { db, vaults, vaultSnapshots } from "@yearn-tvl/db";
import { eq, and } from "drizzle-orm";
import { V1_VAULTS } from "@yearn-tvl/shared";

const V1_ABI = parseAbi([
  "function token() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function getPricePerFullShare() view returns (uint256)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const ERC20_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const DL_PRICE_URL = "https://coins.llama.fi/prices/current";

async function fetchTokenPrices(addresses: string[]): Promise<Map<string, number>> {
  const coins = addresses.map((a) => `ethereum:${a}`).join(",");
  try {
    const res = await fetch(`${DL_PRICE_URL}/${coins}`);
    if (!res.ok) return new Map();
    const data = (await res.json()) as {
      coins: Record<string, { price: number }>;
    };
    const prices = new Map<string, number>();
    for (const [key, info] of Object.entries(data.coins)) {
      const addr = key.split(":")[1]?.toLowerCase();
      if (addr && info.price > 0) prices.set(addr, info.price);
    }
    return prices;
  } catch {
    return new Map();
  }
}

export async function fetchV1Vaults() {
  const rpcUrl = process.env.RPC_URI_FOR_1 || process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    console.error("No Ethereum RPC URL configured (RPC_URI_FOR_1 or ETH_RPC_URL)");
    return { stored: 0, errors: 0 };
  }

  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  console.log(`Reading ${V1_VAULTS.length} V1 vaults on-chain...\n`);

  // Read on-chain data for all vaults
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

  const vaultData: V1Data[] = [];
  const tokenAddresses = new Set<string>();

  for (const address of V1_VAULTS) {
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

      tokenAddresses.add(token.toLowerCase());
      vaultData.push({
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
  }

  console.log(`  Read ${vaultData.length}/${V1_VAULTS.length} vaults successfully`);

  // Fetch token prices from DefiLlama
  const prices = await fetchTokenPrices([...tokenAddresses]);
  console.log(`  Got prices for ${prices.size}/${tokenAddresses.size} tokens\n`);

  let stored = 0;
  let errors = 0;
  const now = new Date().toISOString();

  for (const v of vaultData) {
    try {
      const addr = getAddress(v.address);

      // TVL = totalSupply * pricePerFullShare / 1e18 (in underlying tokens)
      const underlyingAmount =
        Number(v.totalSupply) * Number(v.pricePerFullShare) / 1e18 / 10 ** v.tokenDecimals;
      const tokenPrice = prices.get(v.token.toLowerCase()) ?? 0;
      const tvlUsd = underlyingAmount * tokenPrice;

      // Upsert vault
      const existing = await db.query.vaults.findFirst({
        where: and(eq(vaults.address, addr), eq(vaults.chainId, 1)),
      });

      let vaultId: number;
      if (existing) {
        await db.update(vaults).set({
          name: v.name,
          category: "v1",
          source: "onchain",
          assetAddress: v.token,
          assetSymbol: v.tokenSymbol,
          assetDecimals: v.tokenDecimals,
          isRetired: false,
          updatedAt: now,
        }).where(eq(vaults.id, existing.id));
        vaultId = existing.id;
      } else {
        const [inserted] = await db.insert(vaults).values({
          address: addr,
          chainId: 1,
          name: v.name,
          v3: false,
          yearn: true,
          category: "v1",
          source: "onchain",
          assetAddress: v.token,
          assetSymbol: v.tokenSymbol,
          assetDecimals: v.tokenDecimals,
          isRetired: false,
          createdAt: now,
          updatedAt: now,
        }).returning({ id: vaults.id });
        vaultId = inserted.id;
      }

      // Insert snapshot
      const totalAssetsStr = (
        (v.totalSupply * v.pricePerFullShare) / BigInt(1e18)
      ).toString();

      await db.insert(vaultSnapshots).values({
        vaultId,
        tvlUsd,
        totalAssets: totalAssetsStr,
        pricePerShare: v.pricePerFullShare.toString(),
        timestamp: now,
      });

      stored++;
      const tvlStr = tvlUsd > 0 ? `$${(tvlUsd / 1e3).toFixed(1)}K` : "no price";
      console.log(`  ${v.name}: ${tvlStr} (${v.tokenSymbol})`);
    } catch (err) {
      errors++;
      console.warn(`  Error storing ${v.address}: ${(err as Error).message?.slice(0, 80)}`);
    }
  }

  console.log(`\nStored ${stored} V1 vaults, ${errors} errors`);
  return { stored, errors };
}

if (import.meta.main) {
  const result = await fetchV1Vaults();
  console.log("Done:", result);
}
