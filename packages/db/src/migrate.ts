import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./client.js";

migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
console.log("Migrations applied successfully.");
