import { Hono } from "hono";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  getDeadTvlAnalysis,
  getRetiredTvlAnalysis,
  getStickyTvlAnalysis,
  getUserVaults,
  getVaultDepositors,
  VALID_DEPOSITOR_SORTS,
} from "../services/analysis.js";
import { getProtocolTvlHistory, getSingleVaultStickiness, getVaultStickiness } from "../services/stickiness.js";

const analysis = new Hono();

analysis.get("/dead", async (c) => {
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const result = await getDeadTvlAnalysis(chainId);
  return c.json(result);
});

analysis.get("/retired", async (c) => {
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const retired = await getRetiredTvlAnalysis(chainId);
  return c.json({ count: retired.length, vaults: retired });
});

analysis.get("/sticky", async (c) => {
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const sticky = await getStickyTvlAnalysis(chainId);
  return c.json({ count: sticky.length, vaults: sticky });
});

analysis.get("/vault/:chainId/:address/depositors", async (c) => {
  const address = c.req.param("address");
  const chainId = Number(c.req.param("chainId"));
  const sort = c.req.query("sort") || "balanceUsd";
  const order = c.req.query("order") || "desc";
  const limit = Number(c.req.query("limit") || "50");

  // Whitelist sort parameter
  if (!VALID_DEPOSITOR_SORTS.includes(sort)) {
    return c.json({ error: `Invalid sort column. Valid: ${VALID_DEPOSITOR_SORTS.join(", ")}` }, 400);
  }

  // Whitelist order parameter
  if (order !== "asc" && order !== "desc") {
    return c.json({ error: "Invalid order. Valid: asc, desc" }, 400);
  }

  const result = await getVaultDepositors(address, chainId, { sort, order, limit });
  return c.json({ address, chainId, ...result });
});

analysis.get("/user/:address", rateLimit({ windowMs: 60_000, max: 10 }), async (c) => {
  const address = c.req.param("address") ?? "";

  // Validate address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return c.json({ error: "Invalid Ethereum address format" }, 400);
  }

  const result = await getUserVaults(address);
  return c.json(result);
});

analysis.get("/stickiness", async (c) => {
  const minTvl = Number(c.req.query("minTvl") || "10000");
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const result = await getVaultStickiness(minTvl, chainId);
  return c.json({ count: result.length, vaults: result });
});

analysis.get("/stickiness/:address", async (c) => {
  const address = c.req.param("address");
  const chainId = Number(c.req.query("chainId") || "1");
  const result = await getSingleVaultStickiness(address, chainId);
  if (!result) return c.json({ error: "Vault not found" }, 404);
  return c.json(result);
});

analysis.get("/tvl-history", async (c) => {
  const protocol = c.req.query("protocol");
  const result = await getProtocolTvlHistory(protocol || undefined);
  return c.json({ count: result.length, data: result });
});

export { analysis };
