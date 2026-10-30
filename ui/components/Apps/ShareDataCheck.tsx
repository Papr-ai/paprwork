/**
 * v9 data check — under the Share summary for Link / Community / team.
 *
 * One line when shared tables would show every row to everyone who opens the
 * app ("2 tables visible to all visitors"). Expanded, two rows of table pills:
 *   Everyone     — tables that show every row to anyone with access
 *   Some people  — tables where rows go to their owner or who they're shared with
 * Hover (or focus) a pill for its columns; click opens it in the app's DB
 * panel. Ask Pen opens a new chat with the review prompt already sent, like
 * "Set up with Pen". Silent when every table is already per person, or the app
 * has no database. Columns come with the table-scope response (read from the
 * schema the check already loads), so this adds no queries.
 */

import { useEffect, useState } from "react";
import {
  DATA_CHECK_CHAT_TITLE,
  dataCheckAgentPrompt,
  humanTable,
  rowsLine,
  tableIsShared,
  type ScopedTable,
} from "../../../src/core/utils/tableScope";
import type { ShareAudience } from "../../utils/shareAudienceModel";
import { openCloudSyncAgentChat } from "../../utils/openCloudSyncAgentChat";
import { openAppTable } from "../../utils/openAppTable";
import { fetchTableScopes } from "../../utils/v9CloudApi";

const PILL_CAP = 6;
const PERSONAL = /email|phone|address|full_?name|first_?name|last_?name|birth|ssn|salary/i;
const personal = (t: ScopedTable) => (t.columns ?? []).some((c) => PERSONAL.test(c));
const byPersonal = (a: ScopedTable, b: ScopedTable) => Number(personal(b)) - Number(personal(a));

/** The sheet scrolls, so the hover card is fixed to the window: below the pill, or above when there's no room. */
function placeTip(pill: HTMLElement) {
  const tip = pill.querySelector<HTMLElement>(".ss6-pill-tip");
  if (!tip) return;
  const r = pill.getBoundingClientRect();
  const h = tip.offsetHeight || 170;
  const below = window.innerHeight - r.bottom > h + 12;
  tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 232))}px`;
  tip.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`;
}

function TablePill(props: { appId: string; t: ScopedTable; signIn: boolean }) {
  const { t } = props;
  const cols = (t.columns ?? []).map(humanTable).join(", ");
  const more = t.moreColumns ? ` +${t.moreColumns} more` : "";
  return (
    <button
      type="button"
      className="ss6-pill"
      onMouseEnter={(e) => placeTip(e.currentTarget)}
      onFocus={(e) => placeTip(e.currentTarget)}
      onClick={() => openAppTable({ appId: props.appId, db: t.db, table: t.name })}
    >
      <svg viewBox="0 0 24 24" aria-hidden className="ss6-pill-ico">
        <ellipse cx="12" cy="6" rx="7" ry="2.6" />
        <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
      </svg>
      <span>{humanTable(t.name)}</span>
      <span className="ss6-pill-tip" role="tooltip">
        <b>{humanTable(t.name)}</b>
        <em>{rowsLine(t, props.signIn)}</em>
        {cols ? <small>{cols + more}</small> : null}
        <i>Click to open</i>
      </span>
    </button>
  );
}

function PillRow(props: { label: string; tables: ScopedTable[]; appId: string; signIn: boolean }) {
  const [all, setAll] = useState(false);
  if (props.tables.length === 0) return null;
  const fits = all || props.tables.length <= PILL_CAP + 1;
  const shown = fits ? props.tables : props.tables.slice(0, PILL_CAP);
  return (
    <div className="ss6-data-r">
      <span className="ss6-data-l">{props.label}</span>
      <div className="ss6-pills">
        {shown.map((t) => (
          <TablePill key={`${t.db}.${t.name}`} appId={props.appId} t={t} signIn={props.signIn} />
        ))}
        {fits ? null : (
          <button type="button" className="ss6-pill ss6-pill--more" onClick={() => setAll(true)}>
            +{props.tables.length - PILL_CAP}
          </button>
        )}
      </div>
    </div>
  );
}

export function ShareDataCheck(props: {
  appId: string;
  audience: ShareAudience;
  requireSignIn: boolean;
  readOnly?: boolean;
}) {
  const [tables, setTables] = useState<ScopedTable[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchTableScopes(props.appId).then((t) => !cancelled && setTables(t));
    return () => {
      cancelled = true;
    };
  }, [props.appId]);

  if (props.audience === "private" || !tables || tables.length === 0) return null;
  const team = props.audience === "team" || props.audience === "people";
  // Workspace and specific people always sign in.
  const signIn = team || props.requireSignIn;
  const shared = tables.filter((t) => tableIsShared(t, signIn)).sort(byPersonal);
  if (shared.length === 0) return null;
  const some = tables.filter((t) => !tableIsShared(t, signIn)).sort(byPersonal);

  const n = shared.length;
  const who = team ? "shared with everyone who has access" : "visible to all visitors";
  return (
    <div className={`ss6-data${team ? " ss6-data--team" : ""}`}>
      <button
        type="button"
        className="ss6-data-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ss6-data-dot" aria-hidden />
        <span className="ss6-data-t">
          {n} table{n === 1 ? "" : "s"} {who}
        </span>
        <span className="ss6-data-chev">{open ? "Hide" : "See"}</span>
      </button>
      {open ? (
        <div className="ss6-data-list">
          <PillRow label="Everyone" tables={shared} appId={props.appId} signIn={signIn} />
          <PillRow label="Some people" tables={some} appId={props.appId} signIn={signIn} />
          {props.readOnly ? null : (
            <button
              type="button"
              className="ss6-data-fix"
              title="Opens a new chat with Pen"
              onClick={() =>
                openCloudSyncAgentChat(dataCheckAgentPrompt(props.appId, shared), {
                  send: true,
                  title: DATA_CHECK_CHAT_TITLE,
                })
              }
            >
              Ask Pen
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
