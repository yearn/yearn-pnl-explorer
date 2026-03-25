import { createContext, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SkeletonCards, SkeletonChart, timeAgo } from "./hooks";
import "./styles.css";

const TvlOverview = lazy(() => import("./panels/TvlOverview").then((m) => ({ default: m.TvlOverview })));
const ComparisonPanel = lazy(() => import("./panels/ComparisonPanel").then((m) => ({ default: m.ComparisonPanel })));
const FeesPanel = lazy(() => import("./panels/FeesPanel").then((m) => ({ default: m.FeesPanel })));
const AuditPanel = lazy(() => import("./panels/AuditPanel").then((m) => ({ default: m.AuditPanel })));

const TABS = [
  { key: "Overview", icon: "\u25A3", label: "Overview" },
  { key: "Fees", icon: "\u2234", label: "Fees" },
  { key: "Vaults", icon: "\u2263", label: "Vaults & Curation" },
  { key: "Comparison", icon: "\u21C4", label: "Comparison" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";

export const DashboardContext = createContext<{
  chainFilter: string;
  density: Density;
  theme: Theme;
  lastFetchedAt: number | null;
  setLastFetchedAt: (ts: number) => void;
}>({ chainFilter: "all", density: "comfortable", theme: "dark", lastFetchedAt: null, setLastFetchedAt: () => {} });

const CHAINS = [
  { id: "all", label: "All Chains" },
  { id: "1", label: "Ethereum" },
  { id: "10", label: "Optimism" },
  { id: "137", label: "Polygon" },
  { id: "42161", label: "Arbitrum" },
  { id: "8453", label: "Base" },
  { id: "100", label: "Gnosis" },
  { id: "747474", label: "Katana" },
  { id: "999", label: "Hyperliquid" },
  { id: "80094", label: "Berachain" },
  { id: "146", label: "Sonic" },
];

// ── Hash-based routing ──

function parseHash(): { tab: Tab; chain: string; density: Density; theme: Theme } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const tab = (params.get("tab") || "Overview") as Tab;
  const chain = params.get("chain") || "all";
  const density = (params.get("density") || "comfortable") as Density;
  const theme = (params.get("theme") || localStorage.getItem("theme") || "dark") as Theme;
  const validTab = TABS.some((t) => t.key === tab) ? tab : "Overview";
  return { tab: validTab, chain, density, theme };
}

function writeHash(tab: Tab, chain: string, density: Density) {
  const params = new URLSearchParams();
  if (tab !== "Overview") params.set("tab", tab);
  if (chain !== "all") params.set("chain", chain);
  if (density !== "comfortable") params.set("density", density);
  const hash = params.toString();
  window.history.replaceState(null, "", hash ? `#${hash}` : window.location.pathname);
}

function PanelFallback() {
  return (
    <>
      <SkeletonCards count={5} />
      <SkeletonChart />
    </>
  );
}

export const App = () => {
  const initial = parseHash();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [chainFilter, setChainFilter] = useState(initial.chain);
  const [density, setDensity] = useState<Density>(initial.density);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [collapsed, setCollapsed] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  // Sync hash on state changes
  useEffect(() => {
    writeHash(tab, chainFilter, density);
  }, [tab, chainFilter, density]);

  // Listen for hash changes (browser back/forward)
  useEffect(() => {
    const handler = () => {
      const parsed = parseHash();
      setTab(parsed.tab);
      setChainFilter(parsed.chain);
      setDensity(parsed.density);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Apply theme class to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavigate = useCallback((tabName: string) => {
    const match = TABS.find((t) => t.key === tabName);
    if (match) setTab(match.key);
  }, []);

  const handleChainSelect = useCallback((chain: string) => {
    setChainFilter(chain);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return (
    <DashboardContext.Provider value={{ chainFilter, density, theme, lastFetchedAt, setLastFetchedAt }}>
      <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
        {/* ── Sidebar ── */}
        <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
          <div className="sidebar-header">
            <div className="sidebar-logo">Y</div>
            <span className="sidebar-title">Yearn Metrics</span>
          </div>

          <nav className="sidebar-nav" aria-label="Main navigation">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={tab === t.key ? "active" : ""}
                onClick={() => setTab(t.key)}
                title={collapsed ? t.label : undefined}
                aria-current={tab === t.key ? "page" : undefined}
              >
                <span className="nav-icon">{t.icon}</span>
                <span className="nav-label">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? "\u276F" : "\u276E"}
            </button>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <div className="main-area">
          <div className="top-bar">
            <span className="top-bar-title">{TABS.find((t) => t.key === tab)?.label}</span>
            <div className="toolbar-right">
              {lastFetchedAt && (
                <span className="freshness-indicator" title={new Date(lastFetchedAt).toLocaleTimeString()}>
                  <span className={`freshness-dot${Date.now() - lastFetchedAt > 5 * 60_000 ? " stale" : ""}`} />
                  <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                    {timeAgo(lastFetchedAt)}
                  </span>
                </span>
              )}

              <select
                className="filter-select"
                value={chainFilter}
                onChange={(e) => setChainFilter(e.target.value)}
                aria-label="Filter by chain"
              >
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>

              <div className="density-toggle" role="group" aria-label="Table density">
                <button
                  className={density === "comfortable" ? "active" : ""}
                  onClick={() => setDensity("comfortable")}
                  title="Comfortable"
                  aria-pressed={density === "comfortable"}
                >
                  &#9776;
                </button>
                <button
                  className={density === "compact" ? "active" : ""}
                  onClick={() => setDensity("compact")}
                  title="Compact"
                  aria-pressed={density === "compact"}
                >
                  &#9783;
                </button>
              </div>

              <button
                className="theme-toggle"
                onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              >
                {theme === "dark" ? "\u2600" : "\u263D"}
              </button>

              <button className="kbd-hint" onClick={() => setCmdkOpen(true)}>
                Search <kbd>{navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}</kbd>
                <kbd>K</kbd>
              </button>
            </div>
          </div>

          <main>
            <Suspense fallback={<PanelFallback />}>
              <div className="panel-enter" key={tab}>
                <ErrorBoundary key={tab}>
                  {tab === "Overview" && <TvlOverview />}
                  {tab === "Comparison" && <ComparisonPanel />}
                  {tab === "Fees" && <FeesPanel />}
                  {tab === "Vaults" && <AuditPanel />}
                </ErrorBoundary>
              </div>
            </Suspense>
          </main>
        </div>

        <CommandPalette
          isOpen={cmdkOpen}
          onClose={() => setCmdkOpen(false)}
          onNavigate={handleNavigate}
          onChainSelect={handleChainSelect}
          chainFilter={chainFilter}
        />
      </div>
    </DashboardContext.Provider>
  );
};
