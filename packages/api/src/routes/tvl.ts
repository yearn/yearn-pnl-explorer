import type { VaultCategory } from "@yearn-tvl/shared";
import { Hono } from "hono";
import { calculateTvl, getOverlapDetails, getVaultTvls } from "../services/tvl.js";

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
  const limit = c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 500) : undefined;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;

  const allVaults = await getVaultTvls({ chainId, category, vaultType, includeRetired });
  const paged = limit ? allVaults.slice(offset, offset + limit) : allVaults;
  return c.json({ count: allVaults.length, offset, vaults: paged });
});

tvl.get("/overlap", async (c) => {
  const overlaps = await getOverlapDetails();
  const total = overlaps.reduce((sum, o) => sum + o.overlapUsd, 0);
  const autoOverlap = overlaps.filter((o) => o.detectionMethod === "auto").reduce((sum, o) => sum + o.overlapUsd, 0);
  const registryOverlap = overlaps.filter((o) => o.detectionMethod === "registry").reduce((sum, o) => sum + o.overlapUsd, 0);
  return c.json({ totalOverlap: total, autoOverlap, registryOverlap, count: overlaps.length, overlaps });
});

export { tvl };
