import { useState, useEffect, useCallback, lazy, Suspense, createContext } from "react";
import { SkeletonCards, SkeletonChart, CHAIN_NAMES } from "./hooks";
import { CommandPalette } from "./components/CommandPalette";
import "./styles.css";

const TvlOverview = lazy(() => import("./panels/TvlOverview").then((m) => ({ default: m.TvlOverview })));
const ComparisonPanel = lazy(() => import("./panels/ComparisonPanel").then((m) => ({ default: m.ComparisonPanel })));
const FeesPanel = lazy(() => import("./panels/FeesPanel").then((m) => ({ default: m.FeesPanel })));
const ProfitabilityPanel = lazy(() => import("./panels/ProfitabilityPanel").then((m) => ({ default: m.ProfitabilityPanel })));
const AnalysisPanel = lazy(() => import("./panels/AnalysisPanel").then((m) => ({ default: m.AnalysisPanel })));
const VaultsPanel = lazy(() => import("./panels/VaultsPanel").then((m) => ({ default: m.VaultsPanel })));

const TABS = ["Overview", "Comparison", "Fees", "Profitability", "Analysis", "Vaults"] as const;
type Tab = (typeof TABS)[number];

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
  const [cmdkOpen, setCmdkOpen] = useState(false);

  // Cmd+K / Ctrl+K shortcut
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
    const match = TABS.find((t) => t === tabName);
    if (match) setTab(match);
  }, []);

  return (
    <DashboardContext.Provider value={{ chainFilter, density }}>
      <div className="app">
        <header>
          <h1>Yearn Metrics <span>Analytics</span></h1>
          <div className="header-right">
            Protocol TVL Dashboard
          </div>
        </header>

        <nav>
          {TABS.map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>

        {/* Toolbar: global chain filter, density toggle, Cmd+K */}
        <div className="toolbar">
          <select
            className="filter-select"
            value={chainFilter}
            onChange={(e) => setChainFilter(e.target.value)}
          >
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>

          <div className="toolbar-right">
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
              {tab === "Analysis" && <AnalysisPanel />}
              {tab === "Vaults" && <VaultsPanel />}
            </div>
          </Suspense>
        </main>

        <CommandPalette
          isOpen={cmdkOpen}
          onClose={() => setCmdkOpen(false)}
          onNavigate={handleNavigate}
        />
      </div>
    </DashboardContext.Provider>
  );
};
