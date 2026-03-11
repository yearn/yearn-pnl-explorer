CREATE TABLE `defillama_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`protocol` text NOT NULL,
	`chain` text,
	`tvl_usd` real,
	`timestamp` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `depositors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`vault_id` integer NOT NULL,
	`chain_id` integer NOT NULL,
	`balance` text,
	`balance_usd` real,
	`first_seen` text,
	`last_seen` text,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fee_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vault_id` integer NOT NULL,
	`management_fee` real,
	`performance_fee` real,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`vault_id` integer NOT NULL,
	`chain_id` integer NOT NULL,
	`name` text,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategy_debts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`vault_id` integer NOT NULL,
	`current_debt` text,
	`current_debt_usd` real,
	`max_debt` text,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategy_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`gain` text,
	`loss` text,
	`total_gain` text,
	`total_loss` text,
	`total_fees` text,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tvl_overlap` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_vault_id` integer NOT NULL,
	`target_vault_id` integer NOT NULL,
	`strategy_address` text NOT NULL,
	`overlap_usd` real,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`source_vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vault_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vault_id` integer NOT NULL,
	`tvl_usd` real,
	`total_assets` text,
	`total_idle` text,
	`price_per_share` text,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vaults`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `vaults` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`chain_id` integer NOT NULL,
	`name` text,
	`api_version` text,
	`v3` integer DEFAULT false,
	`vault_type` integer,
	`yearn` integer DEFAULT false,
	`asset_address` text,
	`asset_symbol` text,
	`asset_decimals` integer,
	`is_retired` integer DEFAULT false,
	`category` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
