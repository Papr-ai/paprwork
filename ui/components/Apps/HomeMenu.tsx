/**
 * The ⋯ menu on My apps cards: Open, Rename, Move to collection, Favorites,
 * Make a copy, Archive, Delete. Rendered in a portal so cards can clip.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HomeIcon } from "./HomeIcon";

export interface HomeMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export interface HomeMenuProps {
  items: HomeMenuItem[];
  /** "Move to collection…" targets; empty hides the entry. */
  moveTargets: Array<{ id: string; name: string }>;
  onMove: (folderId: string) => void;
  label?: string;
}

export function HomeMenu({ items, moveTargets, onMove, label = "More actions" }: HomeMenuProps) {
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (pop.current?.contains(t) || btn.current?.contains(t))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) return setOpen(false);
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 220, window.innerWidth - 228)) });
    setMoving(false);
    setOpen(true);
  };
  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    <span className={`ah-menu${open ? " ah-menu--open" : ""}`}>
      <button
        ref={btn}
        type="button"
        className="ah-menu__btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        draggable={false}
      >
        <HomeIcon name="more" size={15} />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={pop}
              className="ah-menu__pop"
              role="menu"
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
            >
              {moving ? (
                <>
                  <div className="ah-menu__label">Move to</div>
                  {moveTargets.map((t) => (
                    <button key={t.id} type="button" role="menuitem" onClick={run(() => onMove(t.id))}>
                      <HomeIcon name="layers" size={14} />
                      {t.name}
                    </button>
                  ))}
                </>
              ) : (
                items.map((it, i) =>
                  it.label === "—" ? (
                    <div key={`sep-${i}`} className="ah-menu__sep" />
                  ) : it.label === "Move to collection…" ? (
                    moveTargets.length ? (
                      <button
                        key={it.label}
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving(true);
                        }}
                      >
                        {it.label}
                      </button>
                    ) : null
                  ) : (
                    <button
                      key={it.label}
                      type="button"
                      role="menuitem"
                      className={it.danger ? "is-danger" : undefined}
                      onClick={run(it.onSelect)}
                    >
                      {it.label}
                    </button>
                  ),
                )
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
