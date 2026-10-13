/**
 * My apps cards, Discover-row style: droplet · name (+ globe = live, bolt =
 * scheduled, star) · one line about it · "Daily 8:00 · Edited 2h ago" (Draft tag). Your apps have no button (the card opens it; ⋯ on hover);
 * team apps you don't have yet get one "Get".
 */
import type { ReactNode } from "react";
import type { Artifact } from "../../stores/artifactsStore";
import type { ShareGlyph } from "../../utils/shareGlyph";
import type { RowLine } from "../../utils/homeStatus";
import { AppGlyph, AppName, DropGlyph, ShareMark, displayTitle } from "./HomeTiles";
import { HomeIcon } from "./HomeIcon";

export interface AppRowProps {
  app: Artifact;
  line: RowLine;
  share?: ShareGlyph;
  renaming: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onRenameDone: () => void;
  menu: ReactNode;
}

export function AppRow(p: AppRowProps) {
  const { bad, draft, live, scheduled, text } = p.line;
  return (
    <div className={`ah-row${bad ? " is-bad" : ""}`}>
      <button type="button" className="ah-row__main" onClick={p.onOpen} title={displayTitle(p.app)}>
        <span className="ah-row__ic">
          <AppGlyph app={p.app} size={48} />
          {bad ? <i className="ah-row__dot" /> : null}
        </span>
        <span className="ah-row__txt">
          <span className="ah-row__t">
            <AppName app={p.app} className="ah-row__name" renaming={p.renaming} onRename={p.onRename} onDone={p.onRenameDone} />
            {live ? <span className="ah-row__mark" title="Live on the web"><HomeIcon name="globe" size={13} /></span> : null}
            {scheduled ? <span className="ah-row__mark" title="Runs on a schedule"><HomeIcon name="bolt" size={13} /></span> : null}
            {p.app.favorite ? <HomeIcon name="star" size={13} className="ah-row__pin" /> : null}
          </span>
          {p.app.description ? <span className="ah-row__d">{p.app.description}</span> : null}
          <span className={`ah-row__s${bad ? " ah-row__s--bad" : ""}`}>
            {draft && !bad ? <span className="ah-row__tag">Draft</span> : null}
            {text}
          </span>
        </span>
      </button>
      <span className="ah-row__act">
        <ShareMark share={p.share} />
        {p.menu}
      </span>
    </div>
  );
}

export function GetRow(p: {
  name: string;
  icon?: string;
  description?: string;
  by?: string;
  busy: boolean;
  /** "Get" (blue) for apps you can install; "Open" / "Preview" (quiet) for ones you have or that only run on the web. */
  action?: "Get" | "Open" | "Preview";
  note?: string;
  onDetails: () => void;
  onGet: () => void;
}) {
  const action = p.action ?? "Get";
  return (
    <div className="ah-row ah-row--get">
      <button type="button" className="ah-row__main" onClick={p.onDetails}>
        <span className="ah-row__ic">
          <DropGlyph icon={p.icon} title={p.name} size={48} />
        </span>
        <span className="ah-row__txt">
          <span className="ah-row__t">
            <span className="ah-row__name">{p.name}</span>
          </span>
          {p.description ? <span className="ah-row__d">{p.description}</span> : null}
          {p.by || p.note ? (
            <span className="ah-row__s">{[p.by ? `by ${p.by}` : "", p.note ?? ""].filter(Boolean).join(" · ")}</span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={`ah-row__get${action !== "Get" ? " ah-row__get--quiet" : ""}`}
        disabled={p.busy}
        onClick={p.onGet}
      >
        {p.busy ? "Getting…" : action}
      </button>
    </div>
  );
}
