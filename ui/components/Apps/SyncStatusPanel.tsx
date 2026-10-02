/**
 * v7 status panel — what the share-bar chip opens.
 *
 * Rows, not paragraphs: each row says what differs, how much, and the one
 * action that fixes it. The full file list sits behind "Show all". Model:
 * ../../utils/syncPanelModel.ts (pure; tested there).
 */

import React, { useEffect, useMemo, useState } from "react";
import { formatLastUploadedAt } from "../../utils/appCloudSyncStatus";
import {
  countItems,
  type ChangeGroup,
  type PanelAction,
  type PanelRow,
  type SyncPanel,
} from "../../utils/syncPanelModel";
import "./SyncStatusPanel.css";

export type ConflictChoice = "mine" | "theirs" | "agent";

export interface SyncStatusPanelProps {
  panel: SyncPanel;
  onAction: (action: PanelAction) => void;
  /** Apply the held update with a per-file choice for overlapping files. */
  onApplyUpdate: (choices: Record<string, ConflictChoice>) => void;
  /** Hand every overlapping file to the agent; nothing is applied. */
  onAskAgentMergeAll: (files: string[]) => void;
  onCheckStatus?: () => void;
  checking?: boolean;
  lastCheckedAt?: number | null;
  popoverRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  style?: React.CSSProperties;
}

const ICON: Record<PanelRow["kind"], React.ReactNode> = {
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  data: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="1.8" />
      <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
    </>
  ),
  update: <path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />,
  conflict: <path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />,
  issue: <path d="M8 5v3.5M8 11h.01M2.5 13.5h11L8 2.5z" />,
};

function Glyph({ kind }: { kind: PanelRow["kind"] }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICON[kind]}
    </svg>
  );
}

const CHANGE_LABEL = { added: "New", edited: "Edited", removed: "Removed" } as const;

function ChangeList({ groups }: { groups: ChangeGroup[] }) {
  const [open, setOpen] = useState(false);
  const n = countItems(groups);
  if (n === 0) return null;
  return (
    <div className="sync7-more">
      <button type="button" className="sync7-more-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "Hide" : `Show all ${n}`}
      </button>
      {open
        ? groups.map((g) => (
            <div key={g.name} className="sync7-grp">
              <span className="sync7-grp-h">{g.name}</span>
              {g.items.map((item) => (
                <div key={`${g.name}:${item.path}`} className="sync7-file">
                  <code title={item.path}>{item.path}</code>
                  <span className={`sync7-chg sync7-chg--${item.change}`}>
                    {item.note ?? CHANGE_LABEL[item.change]}
                  </span>
                </div>
              ))}
            </div>
          ))
        : null}
    </div>
  );
}

function ConflictPicker({
  row,
  onApply,
  onAskAll,
}: {
  row: PanelRow;
  onApply: (choices: Record<string, ConflictChoice>) => void;
  onAskAll: (files: string[]) => void;
}) {
  const files = row.conflicts ?? [];
  const key = files.map((f) => f.path).join("|");
  const initial = useMemo(
    () => Object.fromEntries(files.map((f) => [f.path, "mine" as ConflictChoice])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>(initial);
  useEffect(() => setChoices(initial), [initial]);
  const options: Array<[ConflictChoice, string, string]> = [
    ["mine", "Mine", "Keep your version of this file"],
    ["theirs", "Theirs", "Use the incoming version of this file"],
    ["agent", "Ask agent", "The agent combines both versions after the update"],
  ];
  return (
    <>
      <div className="sync7-conf" role="group" aria-label="Pick a version for each file">
        {files.map((f) => (
          <div key={f.path} className="sync7-file sync7-cfile">
            <span className="sync7-cname">
              <code title={f.path}>{f.path.split("/").pop()}</code>
              {f.schema ? <small>Database structure</small> : null}
            </span>
            <span className="sync7-pick" role="radiogroup" aria-label={f.path}>
              {options.map(([value, label, title]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={choices[f.path] === value}
                  className={choices[f.path] === value ? "is-on" : undefined}
                  title={title}
                  onClick={() => setChoices((c) => ({ ...c, [f.path]: value }))}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="sync7-acts">
        <button
          type="button"
          className="sync7-apply"
          disabled={row.action?.disabled}
          onClick={() => onApply(choices)}
        >
          {row.action?.label ?? "Apply update"}
        </button>
        <button type="button" className="sync7-ask" onClick={() => onAskAll(files.map((f) => f.path))}>
          Ask agent to merge all
        </button>
      </div>
    </>
  );
}

function Row({ row, props }: { row: PanelRow; props: SyncStatusPanelProps }) {
  const primary = row.tone === "bad" || row.kind === "update";
  return (
    <div className={`sync7-row sync7-row--${row.tone}`} data-kind={row.kind}>
      <span className="sync7-ico">
        <Glyph kind={row.kind} />
      </span>
      <span className="sync7-txt">
        <span className="sync7-top">
          <span className="sync7-tt">
            <b>{row.title}</b>
            <small>{row.value}</small>
          </span>
          {row.action && row.kind !== "conflict" ? (
            <button
              type="button"
              className={`sync7-act${primary ? " sync7-act--primary" : ""}`}
              disabled={row.action.disabled}
              onClick={() => props.onAction(row.action!.id)}
            >
              {row.action.label}
            </button>
          ) : null}
        </span>
        {row.progress != null ? (
          <span className="sync7-prog">
            <i style={{ width: `${row.progress}%` }} />
          </span>
        ) : null}
        {row.kind === "conflict" ? (
          <ConflictPicker row={row} onApply={props.onApplyUpdate} onAskAll={props.onAskAgentMergeAll} />
        ) : null}
        {row.foot ? <small className="sync7-rowfoot">{row.foot}</small> : null}
        {row.groups ? <ChangeList groups={row.groups} /> : null}
      </span>
    </div>
  );
}

export function SyncStatusPanel(props: SyncStatusPanelProps) {
  const { panel, lastCheckedAt, checking } = props;
  const when = checking
    ? "Checking…"
    : lastCheckedAt
      ? `Checked ${formatLastUploadedAt(new Date(lastCheckedAt).toISOString()) ?? "recently"}`
      : "Not checked yet";
  return (
    <div
      ref={props.popoverRef}
      className={`sync7${props.className ? ` ${props.className}` : ""}`}
      style={props.style}
      role="dialog"
      aria-label="Sync status"
    >
      <div className="sync7-head">
        <span className="sync7-state">
          <span className={`sync7-dot sync7-dot--${panel.header.tone}`} aria-hidden />
          {panel.header.label}
        </span>
        <span className="sync7-when">{when}</span>
      </div>
      <div className="sync7-body">
        {panel.rows.length > 0 ? (
          panel.rows.map((row) => <Row key={`${row.kind}:${row.title}`} row={row} props={props} />)
        ) : (
          <div className="sync7-calm">
            <span className="sync7-check" aria-hidden>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m4 8.5 2.5 2.5L12 5.5" />
              </svg>
            </span>
            <span>
              <b>Nothing to send</b>
              <small>Code, jobs and data match the web.</small>
            </span>
          </div>
        )}
        {panel.note ? <p className="sync7-note">{panel.note}</p> : null}
      </div>
      <div className="sync7-foot">
        {panel.offerAgent ? (
          <button type="button" className="sync7-link" onClick={() => props.onAction("ask_agent")}>
            Ask agent
          </button>
        ) : (
          <span />
        )}
        {props.onCheckStatus ? (
          <button type="button" className="sync7-link" disabled={checking} onClick={() => props.onCheckStatus?.()}>
            Check again
          </button>
        ) : null}
      </div>
    </div>
  );
}
