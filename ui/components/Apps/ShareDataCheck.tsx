/**
 * v9 data check — under the Share summary for Link / Community / team.
 *
 * One line when shared tables would show every row to everyone who opens the
 * app ("2 tables visible to all visitors"); expands to the per-table list and
 * an Ask Pen button. Like "Set up with Pen", it opens a new chat with the
 * review prompt already sent; the user and Pen decide table by table there. Silent when every
 * table is already per person, or the app has no database.
 */

import { useEffect, useState } from "react";
import {
  DATA_CHECK_CHAT_TITLE,
  dataCheckAgentPrompt,
  scopeTag,
  tableIsShared,
  type ScopedTable,
} from "../../../src/core/utils/tableScope";
import type { ShareAudience } from "../../utils/shareAudienceModel";
import { openCloudSyncAgentChat } from "../../utils/openCloudSyncAgentChat";
import { fetchTableScopes } from "../../utils/v9CloudApi";

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
  const shared = tables.filter((t) => tableIsShared(t, signIn));
  if (shared.length === 0) return null;

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
          {tables.map((t) => (
            <div key={`${t.db}.${t.name}`} className="ss6-data-row">
              <span className={`ss6-data-dot${tableIsShared(t, signIn) ? "" : " ss6-data-dot--ok"}`} aria-hidden />
              <code>
                {t.db} · {t.name}
              </code>
              <small>{scopeTag(t, signIn)}</small>
            </div>
          ))}
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
