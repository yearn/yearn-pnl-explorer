import { useState } from "react";
import { TvlOverview } from "./panels/TvlOverview";
import { ComparisonPanel } from "./panels/ComparisonPanel";
import { FeesPanel } from "./panels/FeesPanel";
import { AnalysisPanel } from "./panels/AnalysisPanel";
import { VaultsPanel } from "./panels/VaultsPanel";
import "./styles.css";

const TABS = ["Overview", "Comparison", "Fees", "Analysis", "Vaults"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="app">
      <header>
        <h1>Yearn TVL Dashboard</h1>
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
      </header>
      <main>
        {tab === "Overview" && <TvlOverview />}
        {tab === "Comparison" && <ComparisonPanel />}
        {tab === "Fees" && <FeesPanel />}
        {tab === "Analysis" && <AnalysisPanel />}
        {tab === "Vaults" && <VaultsPanel />}
      </main>
    </div>
  );
}
