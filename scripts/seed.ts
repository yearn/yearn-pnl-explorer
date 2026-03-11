/**
 * Orchestrator: runs all fetch scripts in sequence to populate the DB.
 */
import { fetchAndStoreKongData } from "./fetch-kong.js";
import { fetchAndStoreDefillamaData } from "./fetch-defillama.js";
import { fetchAndStoreCurationData } from "./fetch-curation.js";
import { fetchV1Vaults } from "./fetch-v1-vaults.js";

async function seed() {
  console.log("=== Yearn TVL Seed ===\n");
  const start = Date.now();

  console.log("[1/4] Fetching Kong vaults...");
  const kong = await fetchAndStoreKongData();

  console.log("\n[2/4] Fetching DefiLlama data...");
  const defillama = await fetchAndStoreDefillamaData();

  console.log("\n[3/4] Discovering curation vaults on-chain...");
  const curation = await fetchAndStoreCurationData();

  console.log("\n[4/4] Fetching V1 legacy vaults...");
  const v1 = await fetchV1Vaults();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Seed complete in ${elapsed}s ===`);
  console.log(`  Kong: ${kong.stored} vaults`);
  console.log(`  DefiLlama: ${defillama.stored} snapshots`);
  console.log(`  Curation: ${curation.totalVaults} vaults`);
  console.log(`  V1: ${v1.stored} vaults`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
