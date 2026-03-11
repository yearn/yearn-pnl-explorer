import { Hono } from "hono";
import {
  getDeadTvlAnalysis,
  getRetiredTvlAnalysis,
  getStickyTvlAnalysis,
  getDepositorBreakdown,
} from "../services/analysis.js";

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

export { analysis };
