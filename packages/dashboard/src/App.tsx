import { createContext, lazy, Suspense, useCallback, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { SkeletonCards, SkeletonChart, timeAgo } from "./hooks";
import "./styles.css";

const PnlPanel = lazy(() => import("./panels/PnlPanel").then((m) => ({ default: m.PnlPanel })));

const TABS = [{ key: "PnL", icon: "\u25C8", label: "PnL Explorer" }] as const;
type Tab = (typeof TABS)[number]["key"];

export type Theme = "dark" | "light";
export type Density = "comfortable" | "compact";

export const DashboardContext = createContext<{
  chainFilter: string;
  density: Density;
  theme: Theme;
  lastFetchedAt: number | null;
  setLastFetchedAt: (ts: number) => void;
}>({
  chainFilter: "all",
  density: "comfortable",
  theme: "dark",
  lastFetchedAt: null,
  setLastFetchedAt: () => {},
});

function PanelFallback() {
  return (
    <>
      <SkeletonCards count={5} />
      <SkeletonChart />
    </>
  );
}

export const App = () => {
  const [tab, setTab] = useState<Tab>("PnL");
  const [collapsed, setCollapsed] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const savedTheme = localStorage.getItem("theme");
    return savedTheme === "light" ? "light" : "dark";
  });
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setCmdkOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavigate = useCallback((tabName: string) => {
    const match = TABS.find((item) => item.key === tabName);
    if (match) setTab(match.key);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }, []);

  return (
    <DashboardContext.Provider
      value={{
        chainFilter: "all",
        density: "comfortable",
        theme,
        lastFetchedAt,
        setLastFetchedAt,
      }}
    >
      <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
        <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
          <div className="sidebar-header">
            <div className="sidebar-logo">Y</div>
            <span className="sidebar-title">Yearn PnL</span>
          </div>

          <nav className="sidebar-nav" aria-label="Main navigation">
            {TABS.map((item) => (
              <button
                key={item.key}
                className={tab === item.key ? "active" : ""}
                onClick={() => setTab(item.key)}
                title={collapsed ? item.label : undefined}
                aria-current={tab === item.key ? "page" : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-footer">
            <button
              className="sidebar-toggle"
              onClick={() => setCollapsed((value) => !value)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? "\u276F" : "\u276E"}
            </button>
          </div>
        </aside>

        <div className="main-area">
          <div className="top-bar">
            <div>
              <span className="top-bar-title">{TABS.find((item) => item.key === tab)?.label}</span>
              <div className="top-bar-subtitle">
                Frontend shell only. TVL views are disabled while PnL replaces them.
              </div>
            </div>

            <div className="toolbar-right">
              {lastFetchedAt && (
                <span className="freshness-indicator" title={new Date(lastFetchedAt).toLocaleTimeString()}>
                  <span className={`freshness-dot${Date.now() - lastFetchedAt > 5 * 60_000 ? " stale" : ""}`} />
                  <span className="text-dim" style={{ fontSize: "0.7rem" }}>
                    {timeAgo(lastFetchedAt)}
                  </span>
                </span>
              )}

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
                {tab === "PnL" && <PnlPanel />}
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
