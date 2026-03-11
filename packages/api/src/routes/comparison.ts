import { Hono } from "hono";
import { getComparison } from "../services/comparison.js";

const comparison = new Hono();

comparison.get("/", async (c) => {
  const data = await getComparison();
  return c.json(data);
});

export { comparison };
