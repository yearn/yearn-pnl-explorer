import { Hono } from "hono";
import { calculateTvl, getVaultTvls, getOverlapDetails } from "../services/tvl.js";
import type { VaultCategory } from "@yearn-tvl/shared";

const tvl = new Hono();

tvl.get("/", async (c) => {
  const summary = await calculateTvl();
  return c.json(summary);
});

tvl.get("/vaults", async (c) => {
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const category = c.req.query("category") as VaultCategory | undefined;
  const vaultType = c.req.query("vaultType") ? Number(c.req.query("vaultType")) : undefined;

  const includeRetired = c.req.query("includeRetired") === "true";
  const vaults = await getVaultTvls({ chainId, category, vaultType, includeRetired });
  return c.json({ count: vaults.length, vaults });
});

tvl.get("/overlap", async (c) => {
  const overlaps = await getOverlapDetails();
  const total = overlaps.reduce((sum, o) => sum + o.overlapUsd, 0);
  return c.json({ totalOverlap: total, count: overlaps.length, overlaps });
});

export { tvl };
