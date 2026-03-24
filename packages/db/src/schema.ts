import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// --- Core tables ---

export const vaults = sqliteTable("vaults", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  chainId: integer("chain_id").notNull(),
  name: text("name"),
  apiVersion: text("api_version"),
  v3: integer("v3", { mode: "boolean" }).default(false),
  vaultType: integer("vault_type"), // 1=allocator, 2=strategy
  yearn: integer("yearn", { mode: "boolean" }).default(false),
  assetAddress: text("asset_address"),
  assetSymbol: text("asset_symbol"),
  assetDecimals: integer("asset_decimals"),
  isRetired: integer("is_retired", { mode: "boolean" }).default(false),
  category: text("category", { enum: ["v1", "v2", "v3", "curation"] }).notNull(),
  source: text("source", { enum: ["kong", "onchain"] }).notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const vaultSnapshots = sqliteTable("vault_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  tvlUsd: real("tvl_usd"),
  totalAssets: text("total_assets"), // BigInt as string
  totalIdle: text("total_idle"),
  pricePerShare: text("price_per_share"),
  timestamp: text("timestamp").notNull(),
});

export const strategies = sqliteTable("strategies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  chainId: integer("chain_id").notNull(),
  name: text("name"),
});

export const strategyDebts = sqliteTable("strategy_debts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  strategyId: integer("strategy_id")
    .notNull()
    .references(() => strategies.id),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  currentDebt: text("current_debt"),
  currentDebtUsd: real("current_debt_usd"),
  maxDebt: text("max_debt"),
  timestamp: text("timestamp").notNull(),
});

export const feeConfigs = sqliteTable("fee_configs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  managementFee: real("management_fee"),
  performanceFee: real("performance_fee"),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const strategyReports = sqliteTable("strategy_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  strategyAddress: text("strategy_address").notNull(),
  gain: text("gain"), // Raw token gain (BigInt as string) — for USD repricing when Kong fails
  gainUsd: real("gain_usd"),
  lossUsd: real("loss_usd"),
  totalGainUsd: real("total_gain_usd"),
  totalLossUsd: real("total_loss_usd"),
  blockTime: integer("block_time"),
  blockNumber: integer("block_number"),
  transactionHash: text("transaction_hash"),
  pricingSource: text("pricing_source"),
  timestamp: text("timestamp").notNull(),
});

export const defillamaSnapshots = sqliteTable("defillama_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  protocol: text("protocol").notNull(), // yearn-finance, yearn-curating
  chain: text("chain"),
  tvlUsd: real("tvl_usd"),
  timestamp: text("timestamp").notNull(),
});

export const assetPrices = sqliteTable("asset_prices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chainId: integer("chain_id").notNull(),
  address: text("address").notNull(),
  symbol: text("symbol"),
  priceUsd: real("price_usd").notNull(),
  timestamp: integer("timestamp").notNull(), // Unix timestamp (Monday noon UTC)
});

export const tvlHistory = sqliteTable("tvl_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vaultId: integer("vault_id").references(() => vaults.id),
  chainId: integer("chain_id"),
  protocol: text("protocol"),
  tvlUsd: real("tvl_usd").notNull(),
  source: text("source").notNull(), // "defillama" | "snapshot" | "kong"
  timestamp: integer("timestamp").notNull(), // unix timestamp
});

export const depositors = sqliteTable("depositors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  vaultId: integer("vault_id")
    .notNull()
    .references(() => vaults.id),
  chainId: integer("chain_id").notNull(),
  balance: text("balance"),
  balanceUsd: real("balance_usd"),
  firstSeen: text("first_seen"),
  lastSeen: text("last_seen"),
});
