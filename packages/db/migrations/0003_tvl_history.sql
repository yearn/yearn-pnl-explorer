-- Historical TVL data for stickiness analysis and protocol-level charting
CREATE TABLE IF NOT EXISTS `tvl_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vault_id` integer REFERENCES `vaults`(`id`),
	`chain_id` integer,
	`protocol` text,
	`tvl_usd` real NOT NULL,
	`source` text NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tvl_history_vault` ON `tvl_history` (`vault_id`, `timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tvl_history_chain` ON `tvl_history` (`chain_id`, `protocol`, `timestamp`);
