/**
 * Generate a PDF report from the Yearn TVL API.
 * Fetches data from all API endpoints and produces a dated PDF.
 *
 * Usage: bun run report
 * Requires: API server running on :3456 (bun run dev:api)
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_NAMES } from "@yearn-tvl/shared";
import PDFDocument from "pdfkit";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(ROOT, "reports");

const API = "http://localhost:3456";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

// --- Types matching API responses ---

interface TvlSummary {
  totalTvl: number;
  v1Tvl: number;
  v2Tvl: number;
  v3Tvl: number;
  curationTvl: number;
  overlapAmount: number;
  tvlByChain: Record<string, number>;
  vaultCount: { total: number; v1: number; v2: number; v3: number; curation: number; active: number; retired: number };
}

interface Comparison {
  ourTotal: number;
  defillamaTotal: number;
  difference: number;
  differencePercent: number;
  retiredTvl: number;
  overlapDeducted: number;
  notes: string[];
  byChain: Array<{ chain: string; ours: number; defillama: number; difference: number }>;
  byCategory: Array<{ category: string; defillamaProtocol: string; ours: number; defillama: number; difference: number }>;
}

interface FeeSummary {
  totalFeeRevenue: number;
  performanceFeeRevenue: number;
  managementFeeRevenue: number;
  totalGains: number;
  totalLosses: number;
  vaultCount: number;
  reportCount: number;
  byChain: Record<string, { feeRevenue: number; gains: number; vaultCount: number }>;
  byCategory: Record<string, { feeRevenue: number; gains: number; vaultCount: number }>;
}

interface FeeHistory {
  interval: string;
  buckets: Array<{ period: string; gains: number; losses: number; performanceFeeRevenue: number; reportCount: number }>;
}

interface VaultList {
  count: number;
  vaults: Array<{ address: string; chainId: number; name: string | null; category: string; tvlUsd: number; isRetired: boolean }>;
}

interface DeadTvl {
  summary: {
    totalDeadTvl: number;
    totalLowYieldTvl: number;
    healthyTvl: number;
    deadVaultCount: number;
    lowYieldCount: number;
    healthyCount: number;
  };
  vaults: Array<{
    address: string;
    chainId: number;
    name: string | null;
    category: string;
    tvlUsd: number;
    classification: string;
    gains365d: number;
    reportCount365d: number;
  }>;
}

// --- Formatting helpers ---

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

// --- PDF helpers ---

const MARGIN = 50;
const PAGE_WIDTH = 612;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function addHeader(doc: PDFKit.PDFDocument, title: string) {
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#ffffff").text(title, MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.3);
  // Underline
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#444444")
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.5);
}

function addMetric(doc: PDFKit.PDFDocument, label: string, value: string, x: number, width: number) {
  doc.fontSize(8).font("Helvetica").fillColor("#888888").text(label, x, doc.y, { width });
  doc.fontSize(12).font("Helvetica-Bold").fillColor("#ffffff").text(value, x, doc.y, { width });
  doc.moveDown(0.2);
}

function addTableRow(
  doc: PDFKit.PDFDocument,
  cols: Array<{ text: string; width: number; align?: "left" | "right" }>,
  opts?: { bold?: boolean; color?: string },
) {
  const y = doc.y;
  const font = opts?.bold ? "Helvetica-Bold" : "Helvetica";
  const color = opts?.color || "#cccccc";
  doc.fontSize(8).font(font).fillColor(color);
  cols.reduce((x, col) => {
    doc.text(col.text, x, y, { width: col.width, align: col.align || "left" });
    return x + col.width;
  }, MARGIN);
  doc.y = y + 13;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > 742) {
    doc.addPage();
  }
}

// --- Main ---

async function generateReport() {
  console.log("Fetching data from API...");

  const [tvl, comparison, fees, feeHistory, vaultList, deadTvl] = await Promise.all([
    get<TvlSummary>("/api/tvl"),
    get<Comparison>("/api/comparison"),
    get<FeeSummary>("/api/fees"),
    get<FeeHistory>("/api/fees/history?interval=weekly"),
    get<VaultList>("/api/tvl/vaults?includeRetired=false"),
    get<DeadTvl>("/api/analysis/dead"),
  ]);

  const dateStr = new Date().toISOString().slice(0, 10);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = join(REPORTS_DIR, `yearn-tvl-report-${dateStr}.pdf`);

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 50, left: MARGIN, right: MARGIN },
  });

  doc.pipe(createWriteStream(filename));

  // Dark background for new pages
  doc.on("pageAdded", () => {
    doc.rect(0, 0, 612, 792).fill("#1a1a2e");
    doc.fillColor("#ffffff");
    doc.y = 50;
  });

  // First page background
  doc.rect(0, 0, 612, 792).fill("#1a1a2e");

  // Title
  doc.fontSize(22).font("Helvetica-Bold").fillColor("#ffffff").text("Yearn Finance", MARGIN, 50);
  doc
    .fontSize(12)
    .font("Helvetica")
    .fillColor("#888888")
    .text(`TVL & Fee Report — ${dateStr}`, MARGIN, doc.y + 2);
  doc.moveDown(2);

  // ============================================================
  // 1. TVL Overview
  // ============================================================
  addHeader(doc, "TVL Overview");

  const metricY = doc.y;
  const mw = CONTENT_WIDTH / 3;
  addMetric(doc, "Total TVL (Active)", fmtUsd(tvl.totalTvl), MARGIN, mw);
  doc.y = metricY;
  addMetric(doc, "Active Vaults", String(tvl.vaultCount.active), MARGIN + mw, mw);
  doc.y = metricY;
  addMetric(doc, "Overlap Deducted", fmtUsd(tvl.overlapAmount), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);
  const metricY2 = doc.y;
  addMetric(doc, "V1 TVL", fmtUsd(tvl.v1Tvl), MARGIN, mw);
  doc.y = metricY2;
  addMetric(doc, "V2 TVL", fmtUsd(tvl.v2Tvl), MARGIN + mw, mw);
  doc.y = metricY2;
  addMetric(doc, "V3 TVL", fmtUsd(tvl.v3Tvl), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);
  const metricY3 = doc.y;
  addMetric(doc, "Curation TVL", fmtUsd(tvl.curationTvl), MARGIN, mw);
  doc.y = metricY3;
  addMetric(doc, "Retired Vaults", String(tvl.vaultCount.retired), MARGIN + mw, mw);
  doc.moveDown(1);

  // TVL by Chain table
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text("TVL by Chain", MARGIN);
  doc.moveDown(0.3);

  const chainCols = [
    { text: "Chain", width: 120, align: "left" as const },
    { text: "TVL", width: 120, align: "right" as const },
    { text: "% of Total", width: 100, align: "right" as const },
  ];
  addTableRow(doc, chainCols, { bold: true, color: "#888888" });

  Object.entries(tvl.tvlByChain)
    .sort((a, b) => b[1] - a[1])
    .forEach(([chain, chainTvl]) => {
      addTableRow(doc, [
        { text: chain, width: 120 },
        { text: fmtUsd(chainTvl), width: 120, align: "right" },
        { text: `${((chainTvl / tvl.totalTvl) * 100).toFixed(1)}%`, width: 100, align: "right" },
      ]);
    });

  doc.moveDown(1.5);

  // ============================================================
  // 2. DefiLlama Comparison
  // ============================================================
  ensureSpace(doc, 200);
  addHeader(doc, "DefiLlama Comparison");

  const cmpY = doc.y;
  addMetric(doc, "Our Total", fmtUsd(comparison.ourTotal), MARGIN, mw);
  doc.y = cmpY;
  addMetric(doc, "DefiLlama Total", fmtUsd(comparison.defillamaTotal), MARGIN + mw, mw);
  doc.y = cmpY;
  addMetric(doc, "Difference", `${fmtUsd(comparison.difference)} (${pct(comparison.differencePercent)})`, MARGIN + mw * 2, mw);
  doc.moveDown(0.5);

  // By category
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text("By Category", MARGIN);
  doc.moveDown(0.3);
  addTableRow(
    doc,
    [
      { text: "Category", width: 130 },
      { text: "Ours", width: 100, align: "right" },
      { text: "DefiLlama", width: 100, align: "right" },
      { text: "Diff", width: 100, align: "right" },
    ],
    { bold: true, color: "#888888" },
  );

  comparison.byCategory.forEach((cat) => {
    addTableRow(doc, [
      { text: cat.category, width: 130 },
      { text: fmtUsd(cat.ours), width: 100, align: "right" },
      { text: fmtUsd(cat.defillama), width: 100, align: "right" },
      { text: fmtUsd(cat.difference), width: 100, align: "right" },
    ]);
  });

  doc.moveDown(0.5);

  // By chain
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text("By Chain", MARGIN);
  doc.moveDown(0.3);
  addTableRow(
    doc,
    [
      { text: "Chain", width: 100 },
      { text: "Ours", width: 110, align: "right" },
      { text: "DefiLlama", width: 110, align: "right" },
      { text: "Diff", width: 110, align: "right" },
    ],
    { bold: true, color: "#888888" },
  );

  comparison.byChain.slice(0, 10).forEach((c) => {
    addTableRow(doc, [
      { text: c.chain, width: 100 },
      { text: fmtUsd(c.ours), width: 110, align: "right" },
      { text: fmtUsd(c.defillama), width: 110, align: "right" },
      { text: fmtUsd(c.difference), width: 110, align: "right" },
    ]);
  });

  if (comparison.notes.length > 0) {
    doc.moveDown(0.5);
    doc.fontSize(8).font("Helvetica").fillColor("#888888");
    comparison.notes.forEach((note) => {
      doc.text(`• ${note}`, MARGIN, doc.y, { width: CONTENT_WIDTH });
    });
  }

  doc.moveDown(1.5);

  // ============================================================
  // 3. Fee Revenue
  // ============================================================
  ensureSpace(doc, 250);
  addHeader(doc, "Fee Revenue (All Time)");

  const feeY = doc.y;
  addMetric(doc, "Total Fee Revenue", fmtUsd(fees.totalFeeRevenue), MARGIN, mw);
  doc.y = feeY;
  addMetric(doc, "Performance Fees", fmtUsd(fees.performanceFeeRevenue), MARGIN + mw, mw);
  doc.y = feeY;
  addMetric(doc, "Management Fees", fmtUsd(fees.managementFeeRevenue), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);
  const feeY2 = doc.y;
  addMetric(doc, "Total Gains", fmtUsd(fees.totalGains), MARGIN, mw);
  doc.y = feeY2;
  addMetric(doc, "Total Losses", fmtUsd(fees.totalLosses), MARGIN + mw, mw);
  doc.y = feeY2;
  addMetric(doc, "Harvest Reports", String(fees.reportCount), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);

  // Fee by chain
  doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text("Fees by Chain", MARGIN);
  doc.moveDown(0.3);
  addTableRow(
    doc,
    [
      { text: "Chain", width: 120 },
      { text: "Fee Revenue", width: 120, align: "right" },
      { text: "Gains", width: 120, align: "right" },
      { text: "Vaults", width: 80, align: "right" },
    ],
    { bold: true, color: "#888888" },
  );

  Object.entries(fees.byChain)
    .sort((a, b) => b[1].feeRevenue - a[1].feeRevenue)
    .forEach(([chain, data]) => {
      ensureSpace(doc, 15);
      addTableRow(doc, [
        { text: chain, width: 120 },
        { text: fmtUsd(data.feeRevenue), width: 120, align: "right" },
        { text: fmtUsd(data.gains), width: 120, align: "right" },
        { text: String(data.vaultCount), width: 80, align: "right" },
      ]);
    });

  doc.moveDown(1.5);

  // ============================================================
  // 4. Weekly Fee History (last 12 weeks)
  // ============================================================
  ensureSpace(doc, 250);
  addHeader(doc, "Weekly Fee History (Last 12 Weeks)");

  const recentWeeks = feeHistory.buckets.slice(-12);
  addTableRow(
    doc,
    [
      { text: "Week", width: 100 },
      { text: "Gains", width: 110, align: "right" },
      { text: "Perf. Fees", width: 110, align: "right" },
      { text: "Reports", width: 80, align: "right" },
    ],
    { bold: true, color: "#888888" },
  );

  recentWeeks.forEach((week) => {
    ensureSpace(doc, 15);
    addTableRow(doc, [
      { text: week.period, width: 100 },
      { text: fmtUsd(week.gains), width: 110, align: "right" },
      { text: fmtUsd(week.performanceFeeRevenue), width: 110, align: "right" },
      { text: String(week.reportCount), width: 80, align: "right" },
    ]);
  });

  doc.moveDown(1.5);

  // ============================================================
  // 5. Top Vaults by TVL
  // ============================================================
  ensureSpace(doc, 250);
  addHeader(doc, "Top 20 Vaults by TVL");

  addTableRow(
    doc,
    [
      { text: "Vault", width: 180 },
      { text: "Chain", width: 80 },
      { text: "Cat", width: 50 },
      { text: "TVL", width: 100, align: "right" },
    ],
    { bold: true, color: "#888888" },
  );

  vaultList.vaults.slice(0, 20).forEach((v) => {
    ensureSpace(doc, 15);
    const chain = CHAIN_NAMES[v.chainId] || `${v.chainId}`;
    addTableRow(doc, [
      { text: (v.name || shortAddr(v.address)).slice(0, 35), width: 180 },
      { text: chain, width: 80 },
      { text: v.category, width: 50 },
      { text: fmtUsd(v.tvlUsd), width: 100, align: "right" },
    ]);
  });

  doc.moveDown(1.5);

  // ============================================================
  // 6. Vault Health
  // ============================================================
  ensureSpace(doc, 200);
  addHeader(doc, "Vault Health Analysis");

  const ds = deadTvl.summary;
  const totalAnalyzed = ds.totalDeadTvl + ds.totalLowYieldTvl + ds.healthyTvl;
  const healthY = doc.y;
  addMetric(doc, "Healthy TVL", fmtUsd(ds.healthyTvl), MARGIN, mw);
  doc.y = healthY;
  addMetric(doc, "Low-Yield TVL", fmtUsd(ds.totalLowYieldTvl), MARGIN + mw, mw);
  doc.y = healthY;
  addMetric(doc, "Dead TVL", fmtUsd(ds.totalDeadTvl), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);
  const healthY2 = doc.y;
  addMetric(doc, "Healthy %", totalAnalyzed > 0 ? `${((ds.healthyTvl / totalAnalyzed) * 100).toFixed(1)}%` : "N/A", MARGIN, mw);
  doc.y = healthY2;
  addMetric(doc, "Low-Yield Vaults", String(ds.lowYieldCount), MARGIN + mw, mw);
  doc.y = healthY2;
  addMetric(doc, "Dead Vaults", String(ds.deadVaultCount), MARGIN + mw * 2, mw);

  doc.moveDown(0.5);

  // Top dead vaults
  const deadVaults = deadTvl.vaults.filter((v) => v.classification === "dead").slice(0, 10);
  if (deadVaults.length > 0) {
    doc.fontSize(10).font("Helvetica-Bold").fillColor("#ffffff").text("Top Dead Vaults (no reports in 365d)", MARGIN);
    doc.moveDown(0.3);
    addTableRow(
      doc,
      [
        { text: "Vault", width: 200 },
        { text: "Chain", width: 80 },
        { text: "TVL", width: 100, align: "right" },
      ],
      { bold: true, color: "#888888" },
    );

    deadVaults.forEach((v) => {
      ensureSpace(doc, 15);
      const chain = CHAIN_NAMES[v.chainId] || `${v.chainId}`;
      addTableRow(doc, [
        { text: (v.name || shortAddr(v.address)).slice(0, 40), width: 200 },
        { text: chain, width: 80 },
        { text: fmtUsd(v.tvlUsd), width: 100, align: "right" },
      ]);
    });
  }

  doc.end();

  console.log(`Report saved: ${filename}`);
}

generateReport().catch((err) => {
  console.error("Report generation failed:", err.message);
  console.error("Make sure the API is running (bun run dev:api)");
  process.exit(1);
});
