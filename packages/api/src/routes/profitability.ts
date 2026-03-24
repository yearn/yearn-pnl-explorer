import { Hono } from "hono";
import { getProfitability } from "../services/profitability.js";

const profitability = new Hono();

profitability.get("/", async (c) => {
  const chainId = c.req.query("chainId") ? Number(c.req.query("chainId")) : undefined;
  const limit = c.req.query("limit") ? Math.min(Number(c.req.query("limit")), 500) : undefined;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : 0;
  const data = await getProfitability(chainId);
  if (limit) {
    data.vaults = data.vaults.slice(offset, offset + limit);
  }
  return c.json(data);
});

export { profitability };
