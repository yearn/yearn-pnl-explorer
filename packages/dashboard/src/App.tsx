import { useState, useEffect, useCallback, lazy, Suspense, createContext } from "react";
import { SkeletonCards, SkeletonChart } from "./hooks";
import { CommandPalette } from "./components/CommandPalette";
import "./styles.css";

const TvlOverview = lazy(() => import("./panels/TvlOverview").then((m) => ({ default: m.TvlOverview })));
const ComparisonPanel = lazy(() => import("./panels/ComparisonPanel").then((m) => ({ default: m.ComparisonPanel })));
const FeesPanel = lazy(() => import("./panels/FeesPanel").then((m) => ({ default: m.FeesPanel })));
const ProfitabilityPanel = lazy(() => import("./panels/ProfitabilityPanel").then((m) => ({ default: m.ProfitabilityPanel })));
const AuditPanel = lazy(() => import("./panels/AuditPanel").then((m) => ({ default: m.AuditPanel })));

const TABS = [
  { key: "Overview", icon: "\u25A3", label: "Overview" },
  { key: "Comparison", icon: "\u21C4", label: "Comparison" },
  { key: "Fees", icon: "\u2234", label: "Fees" },
  { key: "Profitability", icon: "\u2237", label: "Profitability" },
  { key: "Vaults", icon: "\u2263", label: "Vaults & Curation" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export type Density = "comfortable" | "compact";

export const DashboardContext = createContext<{
  chainFilter: string;
  density: Density;
}>({ chainFilter: "all", density: "comfortable" });

const CHAINS = [
  { id: "all", label: "All Chains" },
  { id: "1", label: "Ethereum" },
  { id: "10", label: "Optimism" },
  { id: "137", label: "Polygon" },
  { id: "250", label: "Fantom" },
  { id: "42161", label: "Arbitrum" },
  { id: "8453", label: "Base" },
  { id: "100", label: "Gnosis" },
  { id: "747474", label: "Katana" },
  { id: "999", label: "Hyperliquid" },
  { id: "80094", label: "Berachain" },
  { id: "146", label: "Sonic" },
];

function PanelFallback() {
  return (
    <>
      <SkeletonCards count={5} />
      <SkeletonChart />
    </>
  );
}

export const App = () => {
  const [tab, setTab] = useState<Tab>("Overview");
  const [chainFilter, setChainFilter] = useState("all");
  const [density, setDensity] = useState<Density>("comfortable");
  const [collapsed, setCollapsed] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);

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

  return (
    <DashboardContext.Provider value={{ chainFilter, density }}>
      <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
        {/* ── Sidebar ── */}
        <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
          <div className="sidebar-header">
            <div className="sidebar-logo">Y</div>
            <span className="sidebar-title">Yearn Metrics</span>
          </div>

          <div className="sidebar-nav">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={tab === t.key ? "active" : ""}
                onClick={() => setTab(t.key)}
                title={collapsed ? t.label : undefined}
              >
                <span className="nav-icon">{t.icon}</span>
                <span className="nav-label">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-footer">
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
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
              <select
                className="filter-select"
                value={chainFilter}
                onChange={(e) => setChainFilter(e.target.value)}
              >
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>

              <div className="density-toggle">
                <button
                  className={density === "comfortable" ? "active" : ""}
                  onClick={() => setDensity("comfortable")}
                  title="Comfortable"
                >
                  &#9776;
                </button>
                <button
                  className={density === "compact" ? "active" : ""}
                  onClick={() => setDensity("compact")}
                  title="Compact"
                >
                  &#9783;
                </button>
              </div>

              <button className="kbd-hint" onClick={() => setCmdkOpen(true)}>
                Search <kbd>{navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}</kbd><kbd>K</kbd>
              </button>
            </div>
          </div>

          <main>
            <Suspense fallback={<PanelFallback />}>
              <div className="panel-enter" key={tab}>
                {tab === "Overview" && <TvlOverview />}
                {tab === "Comparison" && <ComparisonPanel />}
                {tab === "Fees" && <FeesPanel />}
                {tab === "Profitability" && <ProfitabilityPanel />}
                {tab === "Vaults" && <AuditPanel />}
              </div>
            </Suspense>
          </main>
        </div>

        <CommandPalette
          isOpen={cmdkOpen}
          onClose={() => setCmdkOpen(false)}
          onNavigate={handleNavigate}
        />
      </div>
    </DashboardContext.Provider>
  );
};
