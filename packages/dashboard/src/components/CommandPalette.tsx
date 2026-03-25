import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, CHAIN_NAMES, fmt } from "../hooks";

interface CommandPaletteProps {
  onNavigate: (tab: string) => void;
  onChainSelect: (chain: string) => void;
  chainFilter: string;
  isOpen: boolean;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  type: "navigation" | "action" | "chain" | "vault";
  icon: string;
  hint: string;
  meta?: { address?: string; chainId?: number; tvlUsd?: number };
}

const NAV_ITEMS: PaletteItem[] = [
  { id: "Overview", label: "Overview", type: "navigation", icon: "\u{1F4CA}", hint: "TVL summary" },
  { id: "Comparison", label: "Comparison", type: "navigation", icon: "\u{1F504}", hint: "vs DefiLlama" },
  { id: "Fees", label: "Fees", type: "navigation", icon: "\u{1F4B0}", hint: "Fee revenue" },
  { id: "Vaults", label: "Vaults", type: "navigation", icon: "\u{1F3E6}", hint: "Vault tree & overlaps" },
];

const CHAIN_ITEMS: PaletteItem[] = [
  { id: "chain:all", label: "All Chains", type: "chain", icon: "\u{1F30D}", hint: "Remove chain filter" },
  ...Object.entries(CHAIN_NAMES).map(([id, name]) => ({
    id: `chain:${id}`,
    label: name,
    type: "chain" as const,
    icon: "\u{26D3}",
    hint: `Filter to ${name}`,
  })),
];

const ACTION_ITEMS: PaletteItem[] = [
  { id: "export", label: "Export current view", type: "action", icon: "\u{1F4E4}", hint: "Download CSV" },
];

/* ---- Styles ---- */

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    paddingTop: "min(20vh, 160px)",
    background: "rgba(0, 0, 0, 0.6)",
    backdropFilter: "blur(4px)",
    animation: "cmdkFadeIn 0.15s ease-out",
  },
  modal: {
    width: "100%",
    maxWidth: 560,
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    boxShadow: "0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.04)",
    overflow: "hidden",
    animation: "cmdkScaleIn 0.15s ease-out",
  },
  inputWrapper: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "14px 16px",
    borderBottom: "1px solid var(--border)",
  },
  searchIcon: {
    flexShrink: 0,
    width: 18,
    height: 18,
    color: "var(--text-3)",
  },
  input: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text)",
    fontSize: "0.95rem",
    fontFamily: "inherit",
    caretColor: "var(--accent)",
  },
  kbdHint: {
    flexShrink: 0,
    fontSize: "0.68rem",
    color: "var(--text-3)",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 5,
    padding: "2px 6px",
    fontFamily: "inherit",
  },
  list: {
    maxHeight: 400,
    overflowY: "auto" as const,
    padding: "6px 8px",
  },
  sectionLabel: {
    fontSize: "0.65rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "var(--text-3)",
    padding: "8px 10px 4px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    cursor: "pointer",
    transition: "background 0.08s",
    fontSize: "0.85rem",
    color: "var(--text)",
  },
  itemActive: {
    background: "var(--surface)",
  },
  itemIcon: {
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    background: "var(--surface)",
    border: "1px solid var(--border)",
    fontSize: "0.82rem",
    flexShrink: 0,
  },
  itemLabel: {
    flex: 1,
    fontWeight: 500,
  },
  itemHint: {
    fontSize: "0.72rem",
    color: "var(--text-3)",
    marginLeft: "auto",
  },
  itemKbd: {
    fontSize: "0.62rem",
    color: "var(--text-3)",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "1px 5px",
    fontFamily: "inherit",
    marginLeft: 6,
  },
  empty: {
    textAlign: "center" as const,
    padding: "24px 16px",
    color: "var(--text-3)",
    fontSize: "0.82rem",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 16px",
    borderTop: "1px solid var(--border)",
    fontSize: "0.68rem",
    color: "var(--text-3)",
  },
  footerKey: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  },
  footerKbd: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "1px 5px",
    fontSize: "0.62rem",
    fontFamily: "inherit",
    color: "var(--text-3)",
  },
};

/* ---- Keyframe injection ---- */

const STYLE_ID = "cmdk-palette-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const sheet = document.createElement("style");
  sheet.id = STYLE_ID;
  sheet.textContent = `
    @keyframes cmdkFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes cmdkScaleIn {
      from { opacity: 0; transform: scale(0.96) translateY(-8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
  `;
  document.head.appendChild(sheet);
}

/* ---- SVG Icons ---- */

function SearchSvg() {
  return (
    <svg
      style={styles.searchIcon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6.5" cy="6.5" r="5" />
      <line x1="10" y1="10" x2="14.5" y2="14.5" />
    </svg>
  );
}

/* ---- Vault search cache ---- */
interface VaultSearchResult {
  address: string;
  chainId: number;
  name: string | null;
  tvlUsd: number;
}

const vaultCacheState = { vaults: null as VaultSearchResult[] | null, ts: 0 };
const VAULT_CACHE_TTL = 5 * 60 * 1000;

async function fetchVaults(): Promise<VaultSearchResult[]> {
  if (vaultCacheState.vaults && Date.now() - vaultCacheState.ts < VAULT_CACHE_TTL) return vaultCacheState.vaults;
  try {
    const res = await fetch(`${API_BASE}/api/tvl/vaults`);
    if (!res.ok) return vaultCacheState.vaults || [];
    const data = await res.json();
    vaultCacheState.vaults = (data.vaults || data || []).map((v: any) => ({
      address: v.address,
      chainId: v.chainId,
      name: v.name,
      tvlUsd: v.tvlUsd,
    }));
    vaultCacheState.ts = Date.now();
    return vaultCacheState.vaults!;
  } catch {
    return vaultCacheState.vaults || [];
  }
}

/* ---- Component ---- */

export function CommandPalette({ onNavigate, onChainSelect, chainFilter, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [vaultResults, setVaultResults] = useState<PaletteItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load vaults on open
  useEffect(() => {
    if (isOpen) {
      fetchVaults(); // preload
    }
  }, [isOpen]);

  // Search vaults when query changes
  useEffect(() => {
    if (!query.trim() || query.length < 2) {
      setVaultResults([]);
      return;
    }

    const q = query.toLowerCase();
    fetchVaults().then((vaults) => {
      const matches = vaults
        .filter((v) => (v.name || "").toLowerCase().includes(q) || v.address.toLowerCase().includes(q))
        .sort((a, b) => b.tvlUsd - a.tvlUsd)
        .slice(0, 8)
        .map(
          (v): PaletteItem => ({
            id: `vault:${v.chainId}:${v.address}`,
            label: v.name || `${v.address.slice(0, 10)}...`,
            type: "vault",
            icon: "\u{1F512}",
            hint: fmt(v.tvlUsd),
            meta: { address: v.address, chainId: v.chainId, tvlUsd: v.tvlUsd },
          }),
        );
      setVaultResults(matches);
    });
  }, [query]);

  // Build static items
  const staticItems = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return [...NAV_ITEMS, ...CHAIN_ITEMS.slice(0, 4), ...ACTION_ITEMS]; // Show top chains when no query

    const matchesQuery = (item: PaletteItem) => item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q);

    return [...NAV_ITEMS.filter(matchesQuery), ...CHAIN_ITEMS.filter(matchesQuery), ...ACTION_ITEMS.filter(matchesQuery)];
  }, [query]);

  // Combine all results
  const allResults = useMemo(() => {
    return [...staticItems, ...vaultResults];
  }, [staticItems, vaultResults]);

  // Split into sections for display
  const navResults = allResults.filter((i) => i.type === "navigation");
  const chainResults = allResults.filter((i) => i.type === "chain");
  const actionResults = allResults.filter((i) => i.type === "action");
  const vaultItems = allResults.filter((i) => i.type === "vault");
  const flatResults = [...navResults, ...chainResults, ...vaultItems, ...actionResults];

  // Reset state when opening/closing
  useEffect(() => {
    if (isOpen) {
      ensureKeyframes();
      setQuery("");
      setActiveIndex(0);
      setVaultResults([]);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Clamp active index when results change
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, flatResults.length - 1)));
  }, [flatResults.length]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-cmdk-item]");
    const activeEl = items[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectItem = useCallback(
    (item: PaletteItem) => {
      if (item.type === "navigation") {
        onNavigate(item.id);
      } else if (item.type === "chain") {
        const chainId = item.id.replace("chain:", "");
        onChainSelect(chainId);
      } else if (item.type === "vault" && item.meta) {
        // Navigate to Vaults tab — the user can find it there
        onNavigate("Vaults");
      }
      onClose();
    },
    [onNavigate, onChainSelect, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % Math.max(1, flatResults.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev <= 0 ? Math.max(0, flatResults.length - 1) : prev - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatResults[activeIndex];
        if (item) selectItem(item);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [flatResults, activeIndex, selectItem, onClose],
  );

  if (!isOpen) return null;

  const renderSection = (label: string, items: PaletteItem[]) => {
    if (items.length === 0) return null;
    return (
      <>
        <div style={styles.sectionLabel}>{label}</div>
        {items.map((item) => {
          const idx = flatResults.indexOf(item);
          const isChainActive = item.type === "chain" && item.id === `chain:${chainFilter}`;
          return (
            <div
              key={item.id}
              data-cmdk-item
              style={{
                ...styles.item,
                ...(idx === activeIndex ? styles.itemActive : {}),
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => selectItem(item)}
              role="option"
              aria-selected={idx === activeIndex}
            >
              <div style={styles.itemIcon}>{item.icon}</div>
              <span style={styles.itemLabel}>
                {item.label}
                {isChainActive && <span style={{ color: "var(--accent)", marginLeft: 6, fontSize: "0.7rem" }}>(active)</span>}
              </span>
              <span style={styles.itemHint}>{item.hint}</span>
              <kbd style={styles.itemKbd}>Enter</kbd>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <div
      style={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div style={styles.modal} role="dialog" aria-label="Command palette">
        {/* Search input */}
        <div style={styles.inputWrapper}>
          <SearchSvg />
          <input
            ref={inputRef}
            style={styles.input}
            type="text"
            placeholder="Search tabs, chains, vaults..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            aria-label="Search command palette"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={flatResults[activeIndex]?.id}
          />
          <kbd style={styles.kbdHint}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={styles.list} ref={listRef} id="cmdk-list" role="listbox">
          {flatResults.length === 0 ? (
            <div style={styles.empty}>No results for "{query}"</div>
          ) : (
            <>
              {renderSection("Navigate", navResults)}
              {renderSection("Chains", chainResults)}
              {renderSection("Vaults", vaultItems)}
              {renderSection("Actions", actionResults)}
            </>
          )}
        </div>

        {/* Footer hints */}
        <div style={styles.footer}>
          <span style={styles.footerKey}>
            <kbd style={styles.footerKbd}>&uarr;</kbd>
            <kbd style={styles.footerKbd}>&darr;</kbd>
            navigate
          </span>
          <span style={styles.footerKey}>
            <kbd style={styles.footerKbd}>Enter</kbd>
            select
          </span>
          <span style={styles.footerKey}>
            <kbd style={styles.footerKbd}>Esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
