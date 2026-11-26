/** Right-hand side of AppSettingsPage: one body per section. */
import { useEffect, useState, type ReactNode } from "react";
import { AppJobsPanel } from "./AppJobsPanel";
import { MiniAppFilesView } from "./MiniAppFilesView";
import { openKeySettings } from "../../hooks/useMissingAppKeys";
import { fetchAppRequirements } from "../../utils/cloudAppRequirementsApi";
import type { RequiredKeySpec } from "../../../src/core/types/bundles";
import { sendSettingsAction, type AppSettingsContext, type SettingsAction, type SettingsSection } from "./AppSettingsPage";

type Row = { t: string; h: string; a?: string; act?: SettingsAction; danger?: boolean; tag?: string; onClick?: () => void; disabled?: boolean };

function Rows({ appId, title, desc, rows, children }: { appId: string; title: string; desc: string; rows: Row[]; children?: ReactNode }) {
  return (
    <div className="aset__sec">
      <h3>{title}</h3>
      <p className="aset__desc">{desc}</p>
      {children}
      {rows.map((r) => (
        <div key={r.t} className={`aset__row${r.danger ? " aset__row--danger" : ""}`}>
          <div className="aset__main">
            <div className="aset__t">{r.t}{r.tag ? <span className="aset__tag">{r.tag}</span> : null}</div>
            <div className="aset__h">{r.h}</div>
          </div>
          {r.a ? (
            <button type="button" disabled={r.disabled} className={`aset__btn${r.danger ? " aset__btn--danger" : ""}`}
              onClick={r.onClick ?? (() => r.act && sendSettingsAction(appId, r.act))}>{r.a}</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function KeysSection({ appId }: { appId: string }) {
  const [keys, setKeys] = useState<RequiredKeySpec[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetchAppRequirements(appId).then((d) => alive && setKeys(d.requirements)).catch(() => alive && setKeys([]));
    return () => { alive = false; };
  }, [appId]);
  const rows: Row[] = (keys ?? []).map((k) => ({
    t: k.service ?? k.name,
    h: [k.description, k.credentialScope === "owner" ? "Set by the app's owner" : "Each person connects their own"].filter(Boolean).join(" · "),
    a: "Change", onClick: openKeySettings,
  }));
  const desc = keys === null ? "Loading…" : rows.length ? "Accounts the app connects to." : "This app doesn't use any keys.";
  return <Rows appId={appId} title="Keys" desc={desc} rows={rows} />;
}

interface Props {
  appId: string;
  section: SettingsSection;
  ctx: AppSettingsContext;
  focusJobId?: string | null;
  openTable?: { db: string; table: string } | null;
  onTableOpened?: () => void;
}

export function SectionBody({ appId, section, ctx, focusJobId, openTable, onTableOpened }: Props) {
  switch (section) {
    case "jobs":
      return <AppJobsPanel appId={appId} compact={false} focusJobId={focusJobId} />;
    case "code":
    case "data":
    case "files":
      return <MiniAppFilesView appId={appId} panel={section === "data" ? "db" : section}
        openTable={section === "data" ? openTable : null} onTableOpened={onTableOpened} />;
    case "general":
      return <Rows appId={appId} title="General" desc="Name, description and cover: how the app appears to people."
        rows={[{ t: "Name, description and cover", h: "Shown on the link and in Community", a: "Edit", act: "app-info" }]} />;
    case "versions":
      return <Rows appId={appId} title="Versions" desc="Proposals waiting for you, and changes published before."
        rows={[{ t: "Proposals", h: "Changes teammates sent for review", a: "Review", act: "contributions" }]} />;
    case "access":
      return <Rows appId={appId} title="People & access" desc="Who can use the app and who can change it."
        rows={[{ t: "Who has access", h: "People, roles and link access", a: "Manage", act: "access" },
          { t: "Invite people", h: "Share with your team or anyone", a: "Share", act: "share" }]} />;
    case "web":
      return <Rows appId={appId} title="Web link" desc={ctx.live ? "The app's address on the web." : "Not on the web yet. Publish to get a link."}
        rows={ctx.live ? [
          { t: "Copy link", h: "Anyone with access can open it", a: "Copy", act: "copy-link" },
          { t: "Open in browser", h: "Exactly what visitors get", a: "Open", act: "open-link" },
          { t: "Unpublish", h: "Removes the link and the Community listing", a: "Unpublish", act: "unpublish", danger: true },
        ] : []} />;
    case "runs":
      return (
        <Rows appId={appId} title="Where Live runs" desc="Where the Live view runs on this Mac. This Mac is the default." rows={[
          { t: "This Mac", h: "Fast, works offline, syncs with the cloud.", tag: ctx.liveRunsOn === "local" ? "On" : undefined,
            a: ctx.liveRunsOn === "local" ? undefined : "Use this Mac", onClick: () => ctx.onLiveRunsOnChange("local") },
          { t: "Web", h: ctx.live ? "The published app, exactly what visitors get. Needs a connection." : "Publish to the web first.",
            tag: ctx.liveRunsOn === "published" ? "On" : undefined, disabled: !ctx.live,
            a: ctx.liveRunsOn === "published" ? undefined : "Use Web", onClick: () => ctx.onLiveRunsOnChange("published") },
        ]} />
      );
    case "keys":
      return <KeysSection appId={appId} />;
    case "advanced": {
      const rows: Row[] = [
        { t: "Reload the app", h: "Restart it with the latest files", a: "Reload", act: "reload" },
        ...(ctx.collaborator ? [{ t: "Duplicate as my own app", h: "Your own copy with your own data", a: "Duplicate", act: "duplicate" as const }] : []),
        ...(ctx.loggedIn ? [{ t: "Copy to workspace…", h: "Independent copy in another workspace", a: "Copy", act: "copy-to-workspace" as const }] : []),
        { t: "Show app files in Finder", h: "Open the folder on this Mac", a: "Show", act: "show-in-finder" },
        ...(ctx.collaborator ? [{ t: "Discard my edits", h: "Clear Preview and go back to the team version", a: "Discard", act: "discard-edits" as const, danger: true }] : []),
        ...(ctx.collaborator && !ctx.onTeamData ? [{ t: "Stop following the original", h: "Keep this copy as your own, for good", a: "Detach", act: "detach" as const, danger: true }] : []),
      ];
      return <Rows appId={appId} title="Copy & tools" desc="Copies, files and the rarer actions." rows={rows} />;
    }
  }
}
