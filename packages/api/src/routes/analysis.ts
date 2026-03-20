import { Hono } from "hono";
import {
  getDeadTvlAnalysis,
  getRetiredTvlAnalysis,
  getStickyTvlAnalysis,
  getDepositorBreakdown,
  getVaultDepositors,
  getUserVaults,
} from "../services/analysis.js";
import { rateLimit } from "../middleware/rate-limit.js";

const analysis = new Hono();

analysis.get("/dead", async (c) => {
  const result = await getDeadTvlAnalysis();
  return c.json(result);
});

analysis.get("/retired", async (c) => {
  const retired = await getRetiredTvlAnalysis();
  return c.json({ count: retired.length, vaults: retired });
});

analysis.get("/sticky", async (c) => {
  const sticky = await getStickyTvlAnalysis();
  return c.json({ count: sticky.length, vaults: sticky });
});

analysis.get("/depositors/:address", async (c) => {
  const address = c.req.param("address");
  const chainId = Number(c.req.query("chainId") || "1");
  const depositors = await getDepositorBreakdown(address, chainId);
  return c.json({ address, chainId, count: depositors.length, depositors });
});

analysis.get("/vault/:chainId/:address/depositors", async (c) => {
  const address = c.req.param("address");
  const chainId = Number(c.req.param("chainId"));
  const sort = c.req.query("sort") || "balanceUsd";
  const order = c.req.query("order") || "desc";
  const limit = Number(c.req.query("limit") || "50");

  // Whitelist sort parameter
  const validSorts = ["balance", "balanceUsd", "firstSeen", "lastSeen"];
  if (!validSorts.includes(sort)) {
    return c.json({ error: `Invalid sort column. Valid: ${validSorts.join(", ")}` }, 400);
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

export { analysis };
