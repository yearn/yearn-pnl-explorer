import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface CommandPaletteProps {
  onNavigate: (tab: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  icon: string;
  hint: string;
}

const NAV_ITEMS: PaletteItem[] = [
  { id: "PnL", label: "PnL Explorer", icon: "\u{1F4C8}", hint: "Address-level holdings and PnL" },
];

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
    maxHeight: 320,
    overflowY: "auto",
    padding: "6px 8px",
  },
  sectionLabel: {
    fontSize: "0.65rem",
    fontWeight: 600,
    textTransform: "uppercase",
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
    textAlign: "center",
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

const STYLE_ID = "cmdk-palette-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
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

export function CommandPalette({ onNavigate, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) return NAV_ITEMS;
    return NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(normalizedQuery) ||
        item.hint.toLowerCase().includes(normalizedQuery),
    );
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    ensureKeyframes();
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex((previousIndex) => Math.min(previousIndex, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-cmdk-item]");
    const activeElement = items[activeIndex] as HTMLElement | undefined;
    activeElement?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const selectItem = useCallback(
    (item: PaletteItem) => {
      onNavigate(item.id);
      onClose();
    },
    [onClose, onNavigate],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((previousIndex) => (previousIndex + 1) % Math.max(1, results.length));
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((previousIndex) =>
          previousIndex <= 0 ? Math.max(0, results.length - 1) : previousIndex - 1,
        );
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const item = results[activeIndex];
        if (item) selectItem(item);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [activeIndex, onClose, results, selectItem],
  );

  if (!isOpen) return null;

  return (
    <div
      style={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div style={styles.modal} role="dialog" aria-label="Command palette">
        <div style={styles.inputWrapper}>
          <SearchSvg />
          <input
            ref={inputRef}
            style={styles.input}
            type="text"
            placeholder="Search pages..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            aria-label="Search command palette"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[activeIndex]?.id}
          />
          <kbd style={styles.kbdHint}>ESC</kbd>
        </div>

        <div style={styles.list} ref={listRef} id="cmdk-list" role="listbox">
          {results.length === 0 ? (
            <div style={styles.empty}>No results for "{query}"</div>
          ) : (
            <>
              <div style={styles.sectionLabel}>Navigate</div>
              {results.map((item, index) => (
                <div
                  key={item.id}
                  data-cmdk-item
                  style={{
                    ...styles.item,
                    ...(index === activeIndex ? styles.itemActive : {}),
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectItem(item)}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <div style={styles.itemIcon}>{item.icon}</div>
                  <span style={styles.itemLabel}>{item.label}</span>
                  <span style={styles.itemHint}>{item.hint}</span>
                  <kbd style={styles.itemKbd}>Enter</kbd>
                </div>
              ))}
            </>
          )}
        </div>

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
