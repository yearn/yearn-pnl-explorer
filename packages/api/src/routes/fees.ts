import { Hono } from "hono";
import { rateLimit } from "../middleware/rate-limit.js";
import { getFeeStackAnalysis } from "../services/fee-stack.js";
import { getFeeHistory, getFeeSummary, getVaultFees } from "../services/fees.js";

const fees = new Hono();

fees.get("/", async (c) => {
  const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const summary = await getFeeSummary(since, chainId);
  return c.json(summary);
});

fees.get("/vaults", async (c) => {
  const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const limit = c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 500) : undefined;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;
  const vaultFees = await getVaultFees(since, chainId);
  const paged = limit ? vaultFees.slice(offset, offset + limit) : vaultFees;
  return c.json({ count: vaultFees.length, offset, vaults: paged });
});

fees.get("/history", async (c) => {
  const interval = c.req.query("interval") === "weekly" ? "weekly" : "monthly";
  const history = await getFeeHistory(interval);
  return c.json({ interval, buckets: history });
});

fees.get("/stack", rateLimit({ windowMs: 60_000, max: 10 }), async (c) => {
  const stack = await getFeeStackAnalysis();
  c.header("Cache-Control", "max-age=300");
  return c.json(stack);
});

export { fees };
