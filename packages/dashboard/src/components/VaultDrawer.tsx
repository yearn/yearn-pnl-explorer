import { useEffect, useCallback, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { fmt, pctFmt, shortAddr, CHAIN_NAMES, EXPLORER_URLS, CAT_COLORS } from "../hooks";

export interface VaultDetail {
  address: string;
  chainId: number;
  name: string | null;
  category: string;
  vaultType: number | null;
  tvlUsd: number;
  isRetired?: boolean;
  // Optional fields from different panels
  totalFeeRevenue?: number;
  performanceFeeRevenue?: number;
  managementFeeRevenue?: number;
  totalGainUsd?: number;
  feeYield?: number;
  annualizedFeeRevenue?: number;
  trend?: string;
  pricingConfidence?: string;
  quadrant?: string;
  reportCount?: number;
  performanceFee?: number;
  managementFee?: number;
}

interface VaultDrawerProps {
  vault: VaultDetail | null;
  onClose: () => void;
}

/* ---- Styles ---- */

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.55)",
    zIndex: 1000,
    transition: "opacity 0.2s ease",
  },
  drawer: {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 420,
    background: "var(--surface)",
    borderLeft: "1px solid var(--border)",
    zIndex: 1001,
    display: "flex",
    flexDirection: "column",
    transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
    boxShadow: "-8px 0 32px rgba(0, 0, 0, 0.4)",
    overflowY: "auto",
  },
  drawerOpen: {
    transform: "translateX(0)",
  },
  drawerClosed: {
    transform: "translateX(100%)",
  },
  closeBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "transparent",
    color: "var(--text-2)",
    cursor: "pointer",
    fontSize: "1rem",
    transition: "color 0.15s, border-color 0.15s, background 0.15s",
    zIndex: 1,
  },
  header: {
    padding: "1.5rem 1.5rem 1rem",
    borderBottom: "1px solid var(--border)",
  },
  vaultName: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "var(--text)",
    lineHeight: 1.3,
    paddingRight: "2.5rem",
    marginBottom: "0.6rem",
    wordBreak: "break-word" as const,
  },
  tagRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    padding: "0.15rem 0.5rem",
    borderRadius: 4,
    fontSize: "0.68rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "uppercase" as const,
  },
  chainTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "0.72rem",
    color: "var(--text-2)",
    fontWeight: 500,
  },
  explorerLink: {
    color: "var(--text-3)",
    textDecoration: "none",
    fontSize: "0.72rem",
    transition: "color 0.15s",
  },
  section: {
    padding: "1.25rem 1.5rem",
    borderBottom: "1px solid var(--border)",
  },
  sectionLast: {
    padding: "1.25rem 1.5rem",
  },
  sectionTitle: {
    fontSize: "0.7rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "var(--text-3)",
    marginBottom: "0.85rem",
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "0.75rem",
  },
  metricItem: {
    background: "var(--bg-raised, #101318)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "0.75rem 0.85rem",
  },
  metricLabel: {
    fontSize: "0.65rem",
    color: "var(--text-3)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    fontWeight: 500,
    marginBottom: "0.2rem",
  },
  metricValue: {
    fontSize: "1.05rem",
    fontWeight: 700,
    color: "var(--text)",
    letterSpacing: "-0.02em",
    lineHeight: 1.3,
    fontVariantNumeric: "tabular-nums",
  },
  detailRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.5rem 0",
    borderBottom: "1px solid rgba(31, 38, 55, 0.4)",
    fontSize: "0.82rem",
  },
  detailRowLast: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.5rem 0",
    fontSize: "0.82rem",
  },
  detailLabel: {
    color: "var(--text-2)",
  },
  detailValue: {
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    color: "var(--text)",
  },
  addressRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
  },
  copyBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-3)",
    cursor: "pointer",
    fontSize: "0.72rem",
    padding: "0.15rem 0.35rem",
    borderRadius: 4,
    transition: "color 0.15s, background 0.15s",
  },
  retiredBadge: {
    display: "inline-flex",
    alignItems: "center",
    padding: "0.15rem 0.5rem",
    borderRadius: 4,
    fontSize: "0.68rem",
    fontWeight: 600,
    background: "rgba(246, 70, 93, 0.10)",
    color: "var(--red)",
  },
};

const CATEGORY_BADGE_STYLES: Record<string, CSSProperties> = {
  v1: { background: "rgba(94, 102, 115, 0.15)", color: "var(--text-2)" },
  v2: { background: "rgba(59, 130, 246, 0.10)", color: "var(--blue)" },
  v3: { background: "rgba(14, 203, 129, 0.10)", color: "var(--green)" },
  curation: { background: "rgba(240, 185, 11, 0.10)", color: "var(--yellow)" },
};

function vaultTypeLabel(vt: number | null): string {
  if (vt === 1) return "Allocator";
  if (vt === 2) return "Strategy";
  return "N/A";
}

function bpsPctLabel(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

export function VaultDrawer({ vault, onClose }: VaultDrawerProps) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);

  // Animate in after mount
  useEffect(() => {
    if (vault) {
      // Small delay to trigger CSS transition from closed -> open
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
  }, [vault]);

  // Escape key handler
  useEffect(() => {
    if (!vault) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [vault, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (vault) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [vault]);

  const handleCopy = useCallback(() => {
    if (!vault) return;
    navigator.clipboard.writeText(vault.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [vault]);

  if (!vault) return null;

  const explorerBase = EXPLORER_URLS[vault.chainId];
  const explorerUrl = explorerBase ? `${explorerBase}/${vault.address}` : null;
  const chainName = CHAIN_NAMES[vault.chainId] ?? `Chain ${vault.chainId}`;
  const catBadgeStyle = CATEGORY_BADGE_STYLES[vault.category] ?? CATEGORY_BADGE_STYLES.v2;

  // Build metric items - only show fields that have values
  const metrics: { label: string; value: string; accent?: boolean }[] = [
    { label: "TVL", value: fmt(vault.tvlUsd), accent: true },
  ];

  if (vault.totalFeeRevenue != null && vault.totalFeeRevenue > 0) {
    metrics.push({ label: "Total Fee Revenue", value: fmt(vault.totalFeeRevenue) });
  }
  if (vault.performanceFeeRevenue != null && vault.performanceFeeRevenue > 0) {
    metrics.push({ label: "Perf Fee Revenue", value: fmt(vault.performanceFeeRevenue) });
  }
  if (vault.managementFeeRevenue != null && vault.managementFeeRevenue > 0) {
    metrics.push({ label: "Mgmt Fee Revenue", value: fmt(vault.managementFeeRevenue) });
  }
  if (vault.totalGainUsd != null && vault.totalGainUsd > 0) {
    metrics.push({ label: "Total Gain", value: fmt(vault.totalGainUsd) });
  }
  if (vault.feeYield != null) {
    metrics.push({ label: "Fee Yield", value: pctFmt(vault.feeYield) });
  }
  if (vault.annualizedFeeRevenue != null && vault.annualizedFeeRevenue > 0) {
    metrics.push({ label: "Annualized Fees", value: fmt(vault.annualizedFeeRevenue) });
  }
  if (vault.reportCount != null && vault.reportCount > 0) {
    metrics.push({ label: "Harvests", value: vault.reportCount.toLocaleString() });
  }

  const drawerStyle: CSSProperties = {
    ...styles.drawer,
    ...(visible ? styles.drawerOpen : styles.drawerClosed),
  };

  const content = (
    <>
      {/* Backdrop */}
      <div
        style={{
          ...styles.backdrop,
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
        }}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div style={drawerStyle}>
        {/* Close button */}
        <button
          style={styles.closeBtn}
          onClick={onClose}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.borderColor = "var(--text-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-2)";
            e.currentTarget.style.borderColor = "var(--border)";
          }}
          aria-label="Close drawer"
        >
          &#x2715;
        </button>

        {/* Header */}
        <div style={styles.header}>
          <div style={styles.vaultName}>
            {vault.name || shortAddr(vault.address)}
          </div>
          <div style={styles.tagRow}>
            <span style={{ ...styles.badge, ...catBadgeStyle }}>
              {vault.category}
            </span>
            <span style={styles.chainTag}>{chainName}</span>
            {vault.isRetired && (
              <span style={styles.retiredBadge}>Retired</span>
            )}
            {explorerUrl && (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.explorerLink}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-3)"; }}
              >
                View on Explorer &#8599;
              </a>
            )}
          </div>
        </div>

        {/* Key Metrics */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Key Metrics</div>
          <div style={styles.metricsGrid}>
            {metrics.map((m) => (
              <div key={m.label} style={styles.metricItem}>
                <div style={styles.metricLabel}>{m.label}</div>
                <div
                  style={{
                    ...styles.metricValue,
                    ...(m.accent ? { color: "var(--accent)" } : {}),
                  }}
                >
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Details */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Details</div>

          {/* Address */}
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Address</span>
            <div style={styles.addressRow}>
              <span style={{ ...styles.detailValue, fontFamily: "monospace", fontSize: "0.78rem" }}>
                {shortAddr(vault.address)}
              </span>
              <button
                style={styles.copyBtn}
                onClick={handleCopy}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.background = "var(--accent-dim)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--text-3)";
                  e.currentTarget.style.background = "transparent";
                }}
                title="Copy full address"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {/* Chain */}
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Chain</span>
            <span style={styles.detailValue}>{chainName}</span>
          </div>

          {/* Category */}
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Category</span>
            <span style={{ ...styles.detailValue, color: CAT_COLORS[vault.category] ?? "var(--text)" }}>
              {vault.category.toUpperCase()}
            </span>
          </div>

          {/* Vault Type */}
          {vault.vaultType != null && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Vault Type</span>
              <span style={styles.detailValue}>{vaultTypeLabel(vault.vaultType)}</span>
            </div>
          )}

          {/* Retirement Status */}
          <div style={styles.detailRow}>
            <span style={styles.detailLabel}>Status</span>
            <span style={{
              ...styles.detailValue,
              color: vault.isRetired ? "var(--red)" : "var(--green)",
            }}>
              {vault.isRetired ? "Retired" : "Active"}
            </span>
          </div>

          {/* Trend */}
          {vault.trend && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Trend</span>
              <span style={styles.detailValue}>{vault.trend}</span>
            </div>
          )}

          {/* Pricing Confidence */}
          {vault.pricingConfidence && (
            <div style={styles.detailRow}>
              <span style={styles.detailLabel}>Pricing Confidence</span>
              <span style={{
                ...styles.detailValue,
                color: vault.pricingConfidence === "high"
                  ? "var(--green)"
                  : vault.pricingConfidence === "medium"
                    ? "var(--yellow)"
                    : "var(--red)",
              }}>
                {vault.pricingConfidence.charAt(0).toUpperCase() + vault.pricingConfidence.slice(1)}
              </span>
            </div>
          )}

          {/* Quadrant */}
          {vault.quadrant && (
            <div style={styles.detailRowLast}>
              <span style={styles.detailLabel}>Quadrant</span>
              <span style={styles.detailValue}>{vault.quadrant}</span>
            </div>
          )}
        </div>

        {/* Fee Config */}
        {(vault.performanceFee != null || vault.managementFee != null) && (
          <div style={styles.sectionLast}>
            <div style={styles.sectionTitle}>Fee Configuration</div>

            {vault.performanceFee != null && (
              <div style={vault.managementFee != null ? styles.detailRow : styles.detailRowLast}>
                <span style={styles.detailLabel}>Performance Fee</span>
                <span style={styles.detailValue}>{bpsPctLabel(vault.performanceFee)}</span>
              </div>
            )}

            {vault.managementFee != null && (
              <div style={styles.detailRowLast}>
                <span style={styles.detailLabel}>Management Fee</span>
                <span style={styles.detailValue}>{bpsPctLabel(vault.managementFee)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  return createPortal(content, document.body);
}
