import { useCallback, useEffect, useRef, useState } from "react";

export const API_BASE = import.meta.env.VITE_API_URL || "";

// Simple in-memory cache for fetch responses
const fetchCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(() => {
    const cached = fetchCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data as T;
    return null;
  });
  const [loading, setLoading] = useState(() => {
    const cached = fetchCache.get(url);
    return !(cached && Date.now() - cached.timestamp < CACHE_TTL);
  });
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(() => {
    const cached = fetchCache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.timestamp;
    return null;
  });
  const abortRef = useRef<AbortController | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const doFetch = useCallback(
    (bypassCache = false) => {
      // Abort any in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (!bypassCache) {
        const cached = fetchCache.get(url);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          setData(cached.data as T);
          setFetchedAt(cached.timestamp);
          setLoading(false);
          setError(null);
          return;
        }
      }

      setLoading(true);
      fetch(`${API_BASE}${url}`, { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.json();
        })
        .then((d) => {
          if (controller.signal.aborted) return;
          const now = Date.now();
          fetchCache.set(url, { data: d, timestamp: now });
          setData(d);
          setFetchedAt(now);
          setError(null);
        })
        .catch((e) => {
          if (e.name === "AbortError") return;
          setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [url],
  );

  useEffect(() => {
    doFetch();
    return () => abortRef.current?.abort();
  }, [doFetch, retryCount]);

  const retry = useCallback(() => {
    fetchCache.delete(url);
    setError(null);
    setRetryCount((c) => c + 1);
  }, [url]);

  const refresh = useCallback(() => {
    doFetch(true);
  }, [doFetch]);

  return { data, loading, error, fetchedAt, retry, refresh };
}

/** Format USD amount: $1.2B / $340.5M / $12.3K / $999 */
export function fmt(n: number, decimals = 1): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(decimals)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(decimals)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(decimals)}K`;
  return `$${Math.abs(n) < 0.5 ? "0" : n.toFixed(0)}`;
}

/** Format raw number without dollar sign: 1.2B / 340.5M / 12.3K */
export function fmtNum(n: number, decimals = 1): string {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(decimals)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(decimals)}K`;
  return n.toFixed(0);
}

/** Format as signed percentage: +5.2% / -3.1% */
export function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Format basis points as percentage: 1000 → 10% */
export function bpsPct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

/** Truncate ethereum address */
export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Format a decimal as percentage: 0.05 → 5.00% */
export function pctFmt(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Format relative time: "2m ago" / "1h ago" */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  250: "Sonic",
  42161: "Arbitrum",
  8453: "Base",
  100: "Gnosis",
  747474: "Katana",
  999: "Hyperliquid",
  80094: "Berachain",
  146: "Sonic",
};

export const CHAIN_SHORT: Record<number, string> = {
  1: "ETH",
  10: "OP",
  137: "POLY",
  250: "FTM",
  42161: "ARB",
  8453: "BASE",
  100: "GNO",
  747474: "KAT",
  999: "HL",
  80094: "BERA",
  146: "SONIC",
};

export const CHAIN_COLORS: Record<number, string> = {
  1: "#627eea", // Ethereum blue
  10: "#ff0420", // Optimism red
  137: "#8247e5", // Polygon purple
  250: "#1969ff", // Sonic (legacy Fantom)
  42161: "#28a0f0", // Arbitrum blue
  8453: "#0052ff", // Base blue
  100: "#04795b", // Gnosis green
  747474: "#f5a623", // Katana gold
  999: "#50e3c2", // Hyperliquid teal
  80094: "#d4a574", // Berachain brown
  146: "#5b21b6", // Sonic purple
};

export const EXPLORER_URLS: Record<number, string> = {
  1: "https://etherscan.io/address",
  10: "https://optimistic.etherscan.io/address",
  137: "https://polygonscan.com/address",
  250: "https://ftmscan.com/address",
  8453: "https://basescan.org/address",
  42161: "https://arbiscan.io/address",
  100: "https://gnosisscan.io/address",
  747474: "https://katanascan.com/address",
  999: "https://hyperevmscan.io/address",
  80094: "https://berascan.com/address",
  146: "https://sonicscan.org/address",
};

/** Chart colors by category */
export const CAT_COLORS: Record<string, string> = {
  v1: "#848e9c",
  v2: "#3b82f6",
  v3: "#0ecb81",
  curation: "#f0b90b",
};

/** Nansen-style chart color palette */
export const CHART_COLORS = ["#2ee6b6", "#3b82f6", "#f0b90b", "#f6465d", "#a78bfa", "#fb923c", "#848e9c", "#06b6d4", "#ec4899", "#84cc16"];

export function useSort(defaultKey: string, defaultDir: "asc" | "desc" = "desc") {
  const [sortKey, setSortKey] = useState(defaultKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultDir);

  const handleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "desc" ? "asc" : "desc"));
        return prev;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  const sorted = useCallback(
    <T,>(items: T[], accessors: Record<string, (item: T) => number | string>): T[] => {
      const accessor = accessors[sortKey];
      if (!accessor) return items;
      const dir = sortDir === "desc" ? -1 : 1;
      return [...items].sort((a, b) => {
        const aVal = accessor(a);
        const bVal = accessor(b);
        if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal) * dir;
        return ((aVal as number) - (bVal as number)) * dir;
      });
    },
    [sortKey, sortDir],
  );

  const th = useCallback(
    (key: string, label: string, className?: string) => ({
      className: `sortable ${className || ""}`.trim(),
      onClick: () => handleSort(key),
      role: "columnheader" as const,
      "aria-sort": (sortKey === key ? (sortDir === "desc" ? "descending" : "ascending") : "none") as "ascending" | "descending" | "none",
      tabIndex: 0,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSort(key);
        }
      },
      children: `${label}${sortKey === key ? (sortDir === "desc" ? " \u25BC" : " \u25B2") : ""}`,
    }),
    [handleSort, sortKey, sortDir],
  );

  return { sortKey, sortDir, handleSort, sorted, th };
}

/** Debounce a value */
export function useDebouncedValue<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Export table data as CSV download */
export function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const csvEscape = (v: string | number) => {
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Loading skeleton component helper */
export function SkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-card">
          <div className="skeleton skeleton-line" style={{ width: "40%" }} />
          <div className="skeleton skeleton-line-lg" />
          <div className="skeleton skeleton-line-sm" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="card">
      <div className="skeleton skeleton-line" style={{ width: "30%", marginBottom: "1rem" }} />
      <div className="skeleton skeleton-chart" />
    </div>
  );
}

/** Reusable pagination hook */
export function usePagination(totalItems: number, pageSize = 30) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(totalItems / pageSize);
  const start = page * pageSize;
  const end = start + pageSize;

  // Reset to first page when total changes significantly
  useEffect(() => {
    if (page >= totalPages && totalPages > 0) setPage(totalPages - 1);
  }, [totalPages, page]);

  const Pagination =
    totalPages <= 1
      ? null
      : () => (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.75rem", marginTop: "0.75rem" }}>
            <button className="page-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Prev
            </button>
            <span className="text-dim" style={{ fontSize: "0.78rem" }}>
              {start + 1}&ndash;{Math.min(end, totalItems)} of {totalItems}
            </span>
            <button className="page-btn" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        );

  return { page, start, end, totalPages, setPage, Pagination };
}
