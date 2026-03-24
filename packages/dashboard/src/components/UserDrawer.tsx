import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE, CHAIN_NAMES, fmt, shortAddr } from "../hooks";

interface UserVaultHolding {
  vaultAddress: string;
  vaultName: string | null;
  chainId: number;
  category: string;
  balanceUsd: number;
}

interface UserData {
  address: string;
  totalBalanceUsd: number;
  holdings: UserVaultHolding[];
}

interface UserDrawerProps {
  address: string | null;
  onClose: () => void;
}

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
    zIndex: 1,
  },
  header: {
    padding: "1.5rem 1.5rem 1rem",
    borderBottom: "1px solid var(--border)",
  },
  section: {
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
};

export function UserDrawer({ address, onClose }: UserDrawerProps) {
  const [data, setData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (address) {
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
  }, [address]);

  useEffect(() => {
    if (!address) return;

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setData(null);

    fetch(`${API_BASE}/api/analysis/user/${address}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!controller.signal.aborted) {
          setData(d as UserData);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") setLoading(false);
      });

    return () => controller.abort();
  }, [address]);

  useEffect(() => {
    if (!address) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [address, onClose]);

  useEffect(() => {
    if (address) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [address]);

  if (!address) return null;

  const content = (
    <>
      <div style={{ ...styles.backdrop, opacity: visible ? 1 : 0, pointerEvents: visible ? "auto" : "none" }} onClick={onClose} />
      <div style={{ ...styles.drawer, transform: visible ? "translateX(0)" : "translateX(100%)" }}>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close drawer">
          &#x2715;
        </button>

        <div style={styles.header}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text)", paddingRight: "2.5rem", fontFamily: "monospace" }}>
            {shortAddr(address)}
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: "0.3rem" }}>Ethereum only</div>
        </div>

        <div style={styles.section}>
          {loading && <div className="text-dim">Loading...</div>}
          {data && (
            <>
              <div style={{ marginBottom: "1rem" }}>
                <div style={{ fontSize: "0.7rem", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                  Total Balance
                </div>
                <div style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--accent)" }}>{fmt(data.totalBalanceUsd)}</div>
              </div>

              <div style={styles.sectionTitle}>Vault Holdings ({data.holdings.length})</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Vault</th>
                    <th>Chain</th>
                    <th className="text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.holdings.map((h) => (
                    <tr key={`${h.chainId}:${h.vaultAddress}`}>
                      <td>
                        <span className="vault-name">{h.vaultName?.slice(0, 24) || h.vaultAddress.slice(0, 10)}</span>
                      </td>
                      <td className="text-dim">{CHAIN_NAMES[h.chainId] || h.chainId}</td>
                      <td className="text-right">{fmt(h.balanceUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!loading && data && data.holdings.length === 0 && <div className="text-dim">No vault holdings found</div>}
        </div>
      </div>
    </>
  );

  return createPortal(content, document.body);
}
