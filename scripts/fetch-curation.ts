/**
 * Fetch curation vault data from three sources:
 * 1. Morpho Blue API — primary vault discovery by owner/creator/curator address
 * 2. On-chain factory event scanning — catches vaults the API misses (matches DL behavior)
 * 3. Turtle Club on-chain reads (Ethereum ERC4626 vaults)
 *
 * For vaults discovered on-chain without USD pricing, falls back to DefiLlama
 * current token prices, then stablecoin assumptions.
 */

import { db, vaultSnapshots, vaults } from "@yearn-tvl/db";
import { CHAIN_PREFIXES, CURATION_CHAINS, TURTLE_CLUB_VAULTS, YEARN_CURATOR_OWNERS } from "@yearn-tvl/shared";
import { and, desc, eq } from "drizzle-orm";
import { type Address, type Chain, createPublicClient, formatUnits, getAddress, http, type PublicClient, parseAbiItem } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// --- Types ---

interface MorphoVault {
  address: string;
  chain: { id: number; network: string };
  name: string;
  symbol: string;
  asset: { address: string; symbol: string; decimals: number };
  state: { totalAssets: string; totalAssetsUsd: number | null };
}

// --- ABIs ---

const ERC4626_ABI = [
  { name: "totalAssets", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "asset", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { name: "name", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

const ERC20_ABI = [
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
] as const;

const OWNER_ABI = [{ name: "owner", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const;

// MetaMorpho V1 factory event
const CREATE_META_MORPHO_V1 = parseAbiItem(
  "event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address asset, string name, string symbol, bytes32 salt)",
);

// MetaMorpho V2 factory event (different event name)
const CREATE_META_MORPHO_V2 = parseAbiItem(
  "event CreateMetaMorphoV2(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address asset, string name, string symbol, bytes32 salt)",
);

// Custom chain definitions for chains not in viem/chains
const katana: Chain = {
  id: 747474,
  name: "Katana",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.katana.network"] } },
};

const hyperliquid: Chain = {
  id: 999,
  name: "Hyperliquid",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz"] } },
};

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  747474: katana,
  999: hyperliquid,
};

// --- 1. Morpho API fetch ---

const fetchMorphoVaults = async (): Promise<MorphoVault[]> => {
  const owners = JSON.stringify([...YEARN_CURATOR_OWNERS]);
  const fields = `
    address
    chain { id network }
    name
    symbol
    asset { address symbol decimals }
    state { totalAssets totalAssetsUsd }
  `;

  // Query by owner, creator, and curator — DL uses initialOwner from factory events
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
  const allItems = [...json.data.byOwner.items, ...json.data.byCreator.items, ...json.data.byCurator.items];
  return [...new Map(allItems.map((v) => [`${v.chain.id}:${v.address.toLowerCase()}`, v])).values()];
};

// --- 2. On-chain factory event scanning ---

/** Read vault metadata from on-chain contracts */
const readVaultOnChain = async (
  client: PublicClient,
  vaultAddress: Address,
  chainId: number,
  chainName: string,
): Promise<MorphoVault | null> => {
  try {
    const [totalAssets, assetAddress, name] = await Promise.all([
      client.readContract({ address: vaultAddress, abi: ERC4626_ABI, functionName: "totalAssets" }),
      client.readContract({ address: vaultAddress, abi: ERC4626_ABI, functionName: "asset" }),
      client.readContract({ address: vaultAddress, abi: ERC4626_ABI, functionName: "name" }),
    ]);

    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: assetAddress as Address, abi: ERC20_ABI, functionName: "symbol" }),
      client.readContract({ address: assetAddress as Address, abi: ERC20_ABI, functionName: "decimals" }),
    ]);

    return {
      address: vaultAddress,
      chain: { id: chainId, network: chainName.toLowerCase() },
      name: name as string,
      symbol: "",
      asset: { address: assetAddress as string, symbol: symbol as string, decimals: decimals as number },
      state: { totalAssets: totalAssets.toString(), totalAssetsUsd: null },
    };
  } catch (err) {
    console.warn(`    Failed to read vault ${vaultAddress}: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
};

/**
 * Scan Morpho factory contracts for CreateMetaMorpho events, filter by owner.
 * This matches DL's curators helper behavior: discover vaults from factory events
 * rather than relying solely on the Morpho API.
 */
const fetchMorphoVaultsOnChain = async (alreadyFound: Set<string>): Promise<MorphoVault[]> => {
  const ownerSet = new Set(YEARN_CURATOR_OWNERS.map((a) => a.toLowerCase()));

  const chainResults = await CURATION_CHAINS.reduce(
    async (accPromise, chainConfig) => {
      const acc = await accPromise;
      const rpcUrl = process.env[`RPC_URI_FOR_${chainConfig.chainId}`] || process.env.ETH_RPC_URL;
      if (!rpcUrl) {
        console.warn(`    No RPC for chain ${chainConfig.chainId}, skipping factory scan`);
        return acc;
      }

      const viemChain = CHAIN_MAP[chainConfig.chainId];
      if (!viemChain) return acc;

      const client = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });

      const factoryResults = await chainConfig.factories.reduce(
        async (facAccPromise, factory) => {
          const facAcc = await facAccPromise;
          try {
            // Try V1 event first, then V2 if no results
            const event = factory.version === "v1" ? CREATE_META_MORPHO_V1 : CREATE_META_MORPHO_V2;

            const initialLogs = await client.getLogs({
              address: factory.address,
              event,
              fromBlock: factory.fromBlock,
              toBlock: "latest",
            });

            // If V2 event returned nothing, try V1 event name (some V2 factories reuse it)
            const logs =
              initialLogs.length === 0 && factory.version === "v2"
                ? await client.getLogs({
                    address: factory.address,
                    event: CREATE_META_MORPHO_V1,
                    fromBlock: factory.fromBlock,
                    toBlock: "latest",
                  })
                : initialLogs;

            const { vaults: newVaults, count: newCount } = await logs.reduce(
              async (logAccPromise, log) => {
                const logAcc = await logAccPromise;
                const vaultAddress = log.args.metaMorpho;
                if (!vaultAddress) return logAcc;

                const key = `${chainConfig.chainId}:${vaultAddress.toLowerCase()}`;
                if (alreadyFound.has(key)) return logAcc;

                // Check owner
                try {
                  const owner = await client.readContract({
                    address: vaultAddress,
                    abi: OWNER_ABI,
                    functionName: "owner",
                  });
                  if (!ownerSet.has(owner.toLowerCase())) return logAcc;
                } catch {
                  return logAcc; // Can't read owner, skip
                }

                const vault = await readVaultOnChain(client, vaultAddress, chainConfig.chainId, chainConfig.name);
                if (vault) {
                  alreadyFound.add(key);
                  return { vaults: [...logAcc.vaults, vault], count: logAcc.count + 1 };
                }
                return logAcc;
              },
              Promise.resolve({ vaults: [] as MorphoVault[], count: 0 }),
            );

            if (newCount > 0) {
              console.log(
                `    ${chainConfig.name} factory ${factory.version} (${factory.address.slice(0, 10)}...): ${newCount} new vaults`,
              );
            }

            return [...facAcc, ...newVaults];
          } catch (err) {
            console.warn(`    Failed to scan factory ${factory.address} on ${chainConfig.name}: ${(err as Error).message.slice(0, 100)}`);
            return facAcc;
          }
        },
        Promise.resolve([] as MorphoVault[]),
      );

      return [...acc, ...factoryResults];
    },
    Promise.resolve([] as MorphoVault[]),
  );

  return chainResults;
};

// --- 3. Turtle Club on-chain reads (Ethereum only) ---

const fetchTurtleClubVaults = async (): Promise<MorphoVault[]> => {
  const rpcUrl = process.env.RPC_URI_FOR_1 || process.env.ETH_RPC_URL;
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const results = await TURTLE_CLUB_VAULTS.reduce(
    async (accPromise, address) => {
      const acc = await accPromise;
      const vault = await readVaultOnChain(client, address, 1, "ethereum");
      return vault ? [...acc, vault] : acc;
    },
    Promise.resolve([] as MorphoVault[]),
  );

  return results;
};

// --- Price fallback: DefiLlama current prices for on-chain discovered vaults ---

const priceVaultsViaDeFiLlama = async (vaultList: MorphoVault[]): Promise<void> => {
  const needsPricing = vaultList.filter((v) => v.state.totalAssetsUsd === null);
  if (needsPricing.length === 0) return;

  const tokens = needsPricing
    .map((v) => {
      const prefix = CHAIN_PREFIXES[v.chain.id];
      if (!prefix || !v.asset.address) return null;
      return { key: `${prefix}:${v.asset.address}`, vault: v };
    })
    .filter(Boolean) as { key: string; vault: MorphoVault }[];

  if (tokens.length === 0) return;

  const coinKeys = [...new Set(tokens.map((t) => t.key))].join(",");

  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${coinKeys}`);
    if (!res.ok) return;
    const data = (await res.json()) as { coins: Record<string, { price: number }> };

    tokens.forEach(({ key, vault }) => {
      const priceInfo = data.coins[key];
      if (!priceInfo || priceInfo.price <= 0) return;

      const totalAssets = BigInt(vault.state.totalAssets || "0");
      if (totalAssets === 0n) return;

      vault.state.totalAssetsUsd = (Number(totalAssets) / 10 ** vault.asset.decimals) * priceInfo.price;
    });
  } catch {
    console.warn("  Failed to fetch fallback prices from DefiLlama");
  }
};

// --- Persist ---

const persistCurationVault = async (mv: MorphoVault) => {
  const now = new Date().toISOString();
  const address = getAddress(mv.address);
  const chainId = mv.chain.id;

  const existing = await db.query.vaults.findFirst({
    where: and(eq(vaults.address, address), eq(vaults.chainId, chainId)),
  });

  const vaultId = existing
    ? await db
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
        .where(eq(vaults.id, existing.id))
        .then(() => existing.id)
    : (
        await db
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
          .returning({ id: vaults.id })
      )[0].id;

  // Use Morpho API USD price if available, else fall back to existing snapshot or stablecoin approximation
  const tvlUsd =
    mv.state.totalAssetsUsd ??
    (await (async () => {
      const lastSnapshot = await db.query.vaultSnapshots.findFirst({
        where: eq(vaultSnapshots.vaultId, vaultId),
        orderBy: [desc(vaultSnapshots.id)],
      });
      if (lastSnapshot?.tvlUsd) return lastSnapshot.tvlUsd;

      const stablecoins = ["USDC", "USDT", "DAI", "FRAX", "LUSD"];
      if (stablecoins.includes(mv.asset.symbol)) {
        return Number(formatUnits(BigInt(mv.state.totalAssets), mv.asset.decimals));
      }
      return null;
    })());

  await db.insert(vaultSnapshots).values({
    vaultId,
    tvlUsd,
    totalAssets: mv.state.totalAssets,
    timestamp: now,
  });

  return { vaultId, tvlUsd: tvlUsd ?? 0 };
};

// --- Main ---

export const fetchAndStoreCurationData = async () => {
  console.log("Fetching curation vaults...");

  // 1. Morpho API — primary source for all Morpho vaults
  console.log("\n  [Morpho API] Querying by owner addresses...");
  const morphoVaults = await fetchMorphoVaults();
  console.log(`  [Morpho API] Found ${morphoVaults.length} vaults`);

  // Track already-found vaults for dedup
  const foundKeys = new Set(morphoVaults.map((v) => `${v.chain.id}:${v.address.toLowerCase()}`));

  // 2. Factory event scanning — catches vaults the Morpho API misses
  console.log("\n  [Factory scan] Scanning on-chain factory events...");
  const factoryVaults = await fetchMorphoVaultsOnChain(foundKeys);
  console.log(`  [Factory scan] Found ${factoryVaults.length} additional vaults`);

  // 3. Turtle Club — on-chain reads for Ethereum ERC4626 vaults not in Morpho
  console.log("\n  [Turtle Club] Reading on-chain (Ethereum)...");
  const turtleVaults = await fetchTurtleClubVaults();
  console.log(`  [Turtle Club] Found ${turtleVaults.length} vaults`);

  // Merge, deduplicate by address+chainId
  const allItems = [...morphoVaults, ...factoryVaults, ...turtleVaults];
  const allVaults = [...new Map(allItems.map((v) => [`${v.chain.id}:${v.address.toLowerCase()}`, v])).values()];

  // Price on-chain discovered vaults via DefiLlama
  await priceVaultsViaDeFiLlama(allVaults);

  // Persist
  const { totalTvl, byChain } = await allVaults.reduce(
    async (accPromise, v) => {
      const acc = await accPromise;
      const { tvlUsd } = await persistCurationVault(v);
      const chainName = v.chain.network || `Chain ${v.chain.id}`;
      const existing = acc.byChain[chainName] || { count: 0, tvl: 0 };
      return {
        totalTvl: acc.totalTvl + tvlUsd,
        byChain: { ...acc.byChain, [chainName]: { count: existing.count + 1, tvl: existing.tvl + tvlUsd } },
      };
    },
    Promise.resolve({ totalTvl: 0, byChain: {} as Record<string, { count: number; tvl: number }> }),
  );

  console.log(`\nStored ${allVaults.length} curation vaults, $${(totalTvl / 1e6).toFixed(1)}M total`);
  Object.entries(byChain)
    .sort((a, b) => b[1].tvl - a[1].tvl)
    .forEach(([chain, data]) => {
      console.log(`  ${chain}: ${data.count} vaults, $${(data.tvl / 1e6).toFixed(1)}M`);
    });

  return { totalVaults: allVaults.length, totalTvl };
};

if (import.meta.main) {
  const result = await fetchAndStoreCurationData();
  console.log("Done:", result);
}
