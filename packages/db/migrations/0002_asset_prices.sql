-- Weekly historical asset prices from DefiLlama for accurate report repricing and TVL calculations
CREATE TABLE IF NOT EXISTS `asset_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chain_id` integer NOT NULL,
	`address` text NOT NULL,
	`symbol` text,
	`price_usd` real NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `asset_prices_lookup` ON `asset_prices` (`chain_id`, `address`, `timestamp`);
