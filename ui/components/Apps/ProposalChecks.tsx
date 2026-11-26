/**
 * Review sheet v2 (plan step 9): plain-language Checks for a proposal, and the
 * tick box Accept waits for when the change deletes the team's data.
 */
import { useEffect, useState } from "react";
import { getGatewayHttpBase } from "../../utils/gatewayHttpBase";
import type { CloudChangeRequest } from "../../utils/cloudChangeRequestsApi";
import { changeRequestNeedsUpdate } from "../../utils/changeRequestDisplay";

export interface ProposalChecksData {
  checks: Array<{ tone: "ok" | "warn" | "bad"; text: string }>;
  confirm: string | null;
  dataChange: boolean;
}
export type ChecksState = { loading: true; data?: undefined } | { loading: false; data?: ProposalChecksData; error?: string };

export function useProposalChecks(appId: string | undefined, requests: CloudChangeRequest[]): Map<string, ChecksState> {
  const [map, setMap] = useState<Map<string, ChecksState>>(new Map());
  const key = requests.filter((r) => r.status === "pending").map((r) => `${r.id}@${r.headSha ?? ""}`).join(",");
  useEffect(() => {
    if (!appId) return;
    let cancelled = false;
    const open = requests.filter((r) => r.status === "pending");
    setMap(new Map(open.map((r) => [r.id, { loading: true } as ChecksState])));
    for (const r of open) {
      const nu = changeRequestNeedsUpdate(r) ? "?needsUpdate=1" : "";
      void fetch(`${getGatewayHttpBase()}/api/apps/${appId}/proposal-checks/${r.id}${nu}`)
        .then(async (res) => (res.ok ? ((await res.json()) as ProposalChecksData) : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data) => !cancelled && setMap((m) => new Map(m).set(r.id, { loading: false, data })))
        .catch((e: Error) => !cancelled && setMap((m) => new Map(m).set(r.id, { loading: false, error: e.message })));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, key]);
  return map;
}

export function ProposalChecksBlock({ state, ticked, onTick }: {
  state: ChecksState | undefined;
  ticked: boolean;
  onTick: (on: boolean) => void;
}) {
  if (!state) return null;
  return (
    <div className="share-sheet__checks">
      <p className="share-sheet__changes-summary-label">Checks</p>
      {state.loading ? (
        <p className="share-sheet__footnote">Checking against the team's data…</p>
      ) : state.data ? (
        <ul className="share-sheet__checks-list">
          {state.data.checks.map((c) => (
            <li key={c.text} className={`share-sheet__check share-sheet__check--${c.tone}`}>
              <i aria-hidden />
              {c.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="share-sheet__footnote">Couldn't run checks ({state.error}). Ask Pen to look.</p>
      )}
      {state.data?.confirm ? (
        <label className="share-sheet__check-confirm">
          <input type="checkbox" checked={ticked} onChange={(e) => onTick(e.target.checked)} />
          {state.data.confirm}
        </label>
      ) : null}
    </div>
  );
}
