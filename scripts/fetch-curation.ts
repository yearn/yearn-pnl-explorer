/**
 * Fetch curation vault data from Morpho Blue API + on-chain reads for Turtle Club.
 * Morpho API provides vault discovery by owner address with USD-priced TVL.
 * Turtle Club vaults (Ethereum) are read directly via viem.
 */
import { createPublicClient, http, formatUnits, getAddress, type PublicClient, type Address } from "viem";
import { mainnet } from "viem/chains";
import { db, vaults, vaultSnapshots } from "@yearn-tvl/db";
import { eq, and, desc } from "drizzle-orm";
import { YEARN_CURATOR_OWNERS, TURTLE_CLUB_VAULTS } from "@yearn-tvl/shared";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// --- Morpho API types ---

interface MorphoVault {
  address: string;
  chain: { id: number; network: string };
  name: string;
  symbol: string;
  asset: { address: string; symbol: string; decimals: number };
  state: { totalAssets: string; totalAssetsUsd: number | null };
}

// --- Morpho API fetch ---

async function fetchMorphoVaults(): Promise<MorphoVault[]> {
  const owners = JSON.stringify([...YEARN_CURATOR_OWNERS]);
  const fields = `
    address
    chain { id network }
    name
    symbol
    asset { address symbol decimals }
    state { totalAssets totalAssetsUsd }
  `;

  // Query by both owner and creator — DefiLlama uses initialOwner from factory events
  // which maps to creatorAddress, while current owner may have changed
  const query = `{
    byOwner: vaults(where: { ownerAddress_in: ${owners} }, first: 200) {
      items { ${fields} }
    }
    byCreator: vaults(where: { creatorAddress_in: ${owners} }, first: 200) {
      items { ${fields} }
    }
    byCurator: vaults(where: { curatorAddress_in: ${owners} }, first: 200) {
      items { ${fields} }
    }
  }`;

  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`Morpho API error: ${res.status}`);
  const json = (await res.json()) as {
    data: {
      byOwner: { items: MorphoVault[] };
      byCreator: { items: MorphoVault[] };
      byCurator: { items: MorphoVault[] };
    };
  };

  // Merge and deduplicate
  const seen = new Set<string>();
  const merged: MorphoVault[] = [];
  for (const v of [...json.data.byOwner.items, ...json.data.byCreator.items, ...json.data.byCurator.items]) {
    const key = `${v.chain.id}:${v.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(v);
    }
  }
  return merged;
}

// --- Turtle Club on-chain reads (Ethereum only) ---

const ERC4626_ABI = [
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "asset", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { name: "name", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

const ERC20_ABI = [
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

async function fetchTurtleClubVaults(): Promise<MorphoVault[]> {
  const rpcUrl = process.env.RPC_URI_FOR_1 || process.env.ETH_RPC_URL;
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const results: MorphoVault[] = [];

  for (const address of TURTLE_CLUB_VAULTS) {
    try {
      const [totalAssets, assetAddress, name] = await Promise.all([
        client.readContract({ address, abi: ERC4626_ABI, functionName: "totalAssets" }),
        client.readContract({ address, abi: ERC4626_ABI, functionName: "asset" }),
        client.readContract({ address, abi: ERC4626_ABI, functionName: "name" }),
      ]);

      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "symbol" }),
        client.readContract({ address: assetAddress, abi: ERC20_ABI, functionName: "decimals" }),
      ]);

      const formatted = Number(formatUnits(totalAssets, decimals));

      results.push({
        address,
        chain: { id: 1, network: "ethereum" },
        name: name as string,
        symbol: "",
        asset: { address: assetAddress, symbol, decimals },
        state: { totalAssets: totalAssets.toString(), totalAssetsUsd: null },
      });
    } catch (err) {
      console.warn(`  Failed to read Turtle Club vault ${address}:`, (err as Error).message);
    }
  }

  return results;
}

// --- Persist ---

async function persistCurationVault(mv: MorphoVault) {
  const now = new Date().toISOString();
  const address = getAddress(mv.address);
  const chainId = mv.chain.id;

  const existing = await db.query.vaults.findFirst({
    where: and(eq(vaults.address, address), eq(vaults.chainId, chainId)),
  });

  let vaultId: number;
  if (existing) {
    await db
      .update(vaults)
      .set({
        name: mv.name,
        category: "curation",
        source: "onchain",
        assetAddress: mv.asset.address,
        assetSymbol: mv.asset.symbol,
        assetDecimals: mv.asset.decimals,
        updatedAt: now,
      })
      .where(eq(vaults.id, existing.id));
    vaultId = existing.id;
  } else {
    const [inserted] = await db
      .insert(vaults)
      .values({
        address,
        chainId,
        name: mv.name,
        v3: false,
        yearn: true,
        category: "curation",
        source: "onchain",
        assetAddress: mv.asset.address,
        assetSymbol: mv.asset.symbol,
        assetDecimals: mv.asset.decimals,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: vaults.id });
    vaultId = inserted.id;
  }

  // Use Morpho API USD price if available, else fall back to existing snapshot or stablecoin approximation
  let tvlUsd = mv.state.totalAssetsUsd;
  if (!tvlUsd) {
    const lastSnapshot = await db.query.vaultSnapshots.findFirst({
      where: eq(vaultSnapshots.vaultId, vaultId),
      orderBy: [desc(vaultSnapshots.id)],
    });
    tvlUsd = lastSnapshot?.tvlUsd ?? null;

    const stablecoins = ["USDC", "USDT", "DAI", "FRAX", "LUSD"];
    if (!tvlUsd && stablecoins.includes(mv.asset.symbol)) {
      tvlUsd = Number(formatUnits(BigInt(mv.state.totalAssets), mv.asset.decimals));
    }
  }

  await db.insert(vaultSnapshots).values({
    vaultId,
    tvlUsd,
    totalAssets: mv.state.totalAssets,
    timestamp: now,
  });

  return { vaultId, tvlUsd: tvlUsd ?? 0 };
}

// --- Main ---

export async function fetchAndStoreCurationData() {
  console.log("Fetching curation vaults...");

  // 1. Morpho API — primary source for all Morpho vaults
  console.log("\n  [Morpho API] Querying by owner addresses...");
  const morphoVaults = await fetchMorphoVaults();
  console.log(`  [Morpho API] Found ${morphoVaults.length} vaults`);

  // 2. Turtle Club — on-chain reads for Ethereum ERC4626 vaults not in Morpho
  console.log("\n  [Turtle Club] Reading on-chain (Ethereum)...");
  const turtleVaults = await fetchTurtleClubVaults();
  console.log(`  [Turtle Club] Found ${turtleVaults.length} vaults`);

  // Merge, deduplicate by address+chainId
  const seen = new Set<string>();
  const allVaults: MorphoVault[] = [];
  for (const v of [...morphoVaults, ...turtleVaults]) {
    const key = `${v.chain.id}:${v.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      allVaults.push(v);
    }
  }

  // Persist
  let totalTvl = 0;
  const byChain: Record<string, { count: number; tvl: number }> = {};

  for (const v of allVaults) {
    const { tvlUsd } = await persistCurationVault(v);
    totalTvl += tvlUsd;

    const chainName = v.chain.network || `Chain ${v.chain.id}`;
    if (!byChain[chainName]) byChain[chainName] = { count: 0, tvl: 0 };
    byChain[chainName].count++;
    byChain[chainName].tvl += tvlUsd;
  }

  console.log(`\nStored ${allVaults.length} curation vaults, $${(totalTvl / 1e6).toFixed(1)}M total`);
  for (const [chain, data] of Object.entries(byChain).sort((a, b) => b[1].tvl - a[1].tvl)) {
    console.log(`  ${chain}: ${data.count} vaults, $${(data.tvl / 1e6).toFixed(1)}M`);
  }

  return { totalVaults: allVaults.length, totalTvl };
}

if (import.meta.main) {
  const result = await fetchAndStoreCurationData();
  console.log("Done:", result);
}
