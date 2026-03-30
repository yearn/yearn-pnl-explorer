import { Hono } from "hono";
import { cors } from "hono/cors";
import { rateLimit } from "./middleware/rate-limit.js";
import { analysis } from "./routes/analysis.js";
import { audit } from "./routes/audit.js";
import { comparison } from "./routes/comparison.js";
import { fees } from "./routes/fees.js";
import { profitability } from "./routes/profitability.js";
import { tvl } from "./routes/tvl.js";

const PORT = Number(process.env.PORT) || 3456;
const app = new Hono();

app.use("/*", cors());
app.use("/api/*", rateLimit({ windowMs: 60_000, max: 60 }));

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/api/tvl", tvl);
app.route("/api/comparison", comparison);
app.route("/api/fees", fees);
app.route("/api/analysis", analysis);
app.route("/api/profitability", profitability);
app.route("/api/audit", audit);

export default {
  port: PORT,
  fetch: app.fetch,
};
