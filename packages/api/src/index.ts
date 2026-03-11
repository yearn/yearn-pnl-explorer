import { Hono } from "hono";
import { tvl } from "./routes/tvl.js";
import { comparison } from "./routes/comparison.js";
import { fees } from "./routes/fees.js";
import { analysis } from "./routes/analysis.js";

const PORT = Number(process.env.PORT) || 3456;
const app = new Hono();

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/api/tvl", tvl);
app.route("/api/comparison", comparison);
app.route("/api/fees", fees);
app.route("/api/analysis", analysis);

export default {
  port: PORT,
  fetch: app.fetch,
};
