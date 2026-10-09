/**
 * Website logins in Connections: detail panel for one browser sign-in, and
 * the "Add a website login" form. A browser sign-in is a session in Papr's
 * Chrome on this Mac, so "who can use it" is fixed: only you, only here.
 */

import { useState } from "react";
import { ServiceLogo } from "./McpServiceRow";
import { AccessCard, AccessRow, Btn, Fine, Fixed, GlobeMark, Note, Pills, Sheet } from "./ConnectionsUi";
import {
  canImportFromChrome,
  PLATFORM_META,
  platformDomain,
  type PlatformConnections,
  type PlatformInfo,
} from "../../hooks/usePlatformConnections";

function when(iso?: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function siteLogoServer(p: PlatformInfo) {
  const domain = platformDomain(p);
  return { name: p.name, url: domain ? `https://${domain}` : "" };
}

export function SiteSheet({ site, sites, onClose }: { site: PlatformInfo; sites: PlatformConnections; onClose: () => void }) {
  const st = site.status.status;
  const waiting = sites.waiting.has(site.id) || st === "connecting";
  const connected = st === "connected" && !waiting;
  const expired = st === "expired" || st === "needs_reauth";
  const busy = sites.busy === site.id;
  const external = sites.externalChrome.has(site.id);
  const noChrome = sites.chrome === false;
  const desc = PLATFORM_META[site.id]?.desc ?? "Website login";
  const domain = platformDomain(site);

  const connectBtn = (label: string) =>
    noChrome ? (
      <Btn kind="cta" onClick={() => sites.setupWithPen(site.id, site.name)}>Set up with Pen</Btn>
    ) : (
      <Btn kind="cta" disabled={busy || sites.chrome === null} onClick={() => void sites.connect(site.id)}>
        {busy ? "Opening…" : label}
      </Btn>
    );

  const footer = connected ? (
    <>
      <Btn kind="danger" disabled={busy} onClick={() => void sites.disconnect(site.id).then(onClose)}>Disconnect</Btn>
      <div className="cx-fbtns">
        {site.isCustom && <Btn disabled={busy} onClick={() => void sites.remove(site.id).then(onClose)}>Remove site</Btn>}
        <Btn disabled={busy} onClick={() => void sites.refresh(site.id)}>{busy ? "Checking…" : "Check sign-in"}</Btn>
      </div>
    </>
  ) : waiting ? (
    <>
      <span className="cx-grow">Waiting for you to sign in</span>
      <Btn onClick={() => sites.cancel(site.id)}>Cancel</Btn>
      <Btn kind="primary" disabled={busy} onClick={() => void sites.confirm(site.id)}>{busy ? "Checking…" : "I've signed in"}</Btn>
    </>
  ) : (
    <>
      {connectBtn(expired ? "Reconnect" : `Connect ${site.name}`)}
      {site.isCustom && <Btn disabled={busy} onClick={() => void sites.remove(site.id).then(onClose)}>Remove</Btn>}
    </>
  );

  return (
    <Sheet
      label={site.name}
      mark={<ServiceLogo server={siteLogoServer(site)} size="lg" />}
      title={site.name}
      subtitle={domain ? `${desc} · ${domain}` : desc}
      onClose={onClose}
      footer={footer}
    >
      <Pills
        items={[
          connected && ["ok", "Connected"],
          waiting && ["wait", "Waiting for sign-in"],
          expired && ["warn", "Sign-in expired"],
          ["plain", "Browser sign-in"],
        ]}
      />
      {expired && <p className="cx-p cx-p--warn">The sign-in expired, so Pen can't use {site.name} until you reconnect.</p>}
      {(sites.error && sites.busy === null) && <p className="cx-p cx-p--warn">{sites.error}</p>}

      {waiting && (
        <>
          <h4>Finish signing in</h4>
          <p className="cx-p">
            {external
              ? `Sign in to ${site.name} in the Chrome window that opened. Passkeys and Google or Apple sign-in work there.`
              : `Sign in to ${site.name} in the tab that opened in Papr.`}{" "}
            Papr notices when you're done; if it doesn't, click I've signed in.
          </p>
        </>
      )}

      <h4>Who can use it</h4>
      <div className="cx-devnote">
        This is your own {site.name} session in Papr's browser on this Mac. It never leaves this device.
      </div>
      <AccessCard>
        <AccessRow label="Shared with" hint="It's your logged-in session, so it can't be shared with your team">
          <Fixed>Only me</Fixed>
        </AccessRow>
        <AccessRow label="Available on" hint="Not your other devices, and not cloud jobs">
          <Fixed>This Mac</Fixed>
        </AccessRow>
        <AccessRow label="Jobs and automations" hint="Only run while this Mac is awake and Papr is open">
          <Fixed>When Papr is open</Fixed>
        </AccessRow>
      </AccessCard>

      {connected ? (
        <>
          <h4>Session</h4>
          <p className="cx-p">
            Last checked {when(site.status.lastRefreshedAt)}.
            {site.status.expiresAt && ` ${site.name} usually asks you to sign in again around ${new Date(site.status.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`}
          </p>
          {site.status.error && <p className="cx-p cx-p--warn">{site.status.error}</p>}
        </>
      ) : (
        !waiting && (
          <>
            <h4>How connecting works</h4>
            <p className="cx-p">
              {site.name} has no sign-in for apps like Pen, so Pen works through its own browser. It's slower and breaks
              more often than a direct connection.
            </p>
            <ol className="cx-how">
              <li>A Papr Chrome window opens {site.name}</li>
              <li>You sign in as you normally would</li>
              <li>Pen uses that session. {site.name} may ask you to sign in again every few weeks</li>
            </ol>
            {canImportFromChrome(site.id) && !noChrome && (
              <Note title="Already signed in to Google Chrome?">
                <p>Copy that session instead of signing in again. macOS asks for your Keychain password once.</p>
                <Btn disabled={busy} onClick={() => void sites.importFromChrome(site.id)}>Use my Chrome sign-in</Btn>
              </Note>
            )}
            {noChrome && (
              <Note title="Google Chrome is needed" tone="warn">
                <p>Sign-in runs in real Chrome so passkeys work. Pen can install it and connect {site.name} for you.</p>
              </Note>
            )}
          </>
        )
      )}

      <Fine>The browser session stays on this Mac. Disconnect any time.</Fine>
    </Sheet>
  );
}

export function AddSiteSheet({ sites, onClose, onAdded }: { sites: PlatformConnections; onClose: () => void; onAdded: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const busy = sites.busy === "__register";

  const add = async () => {
    if (!url.trim() || busy) return;
    const id = await sites.register(url.trim(), name.trim());
    if (!id) return;
    onAdded(id);
    void sites.connect(id);
  };

  return (
    <Sheet
      label="Add a website login"
      mark={<GlobeMark size="lg" />}
      title="Add a website login"
      subtitle="For sites with no direct connection"
      onClose={onClose}
      footer={
        <div className="cx-fbtns">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!url.trim() || busy} onClick={() => void add()}>
            {busy ? "Adding…" : "Open and sign in"}
          </Btn>
        </div>
      }
    >
      <h4>Website</h4>
      <input
        className="cx-in"
        type="url"
        aria-label="Website"
        placeholder="https://app.example.com"
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void add()}
      />
      <h4>Name</h4>
      <input
        className="cx-in"
        type="text"
        aria-label="Name"
        placeholder="Optional, e.g. Acme CRM"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void add()}
      />
      {sites.error && <p className="cx-p cx-p--warn">{sites.error}</p>}
      <h4>How it works</h4>
      <ol className="cx-how">
        <li>A Papr Chrome window opens the site</li>
        <li>You sign in as you normally would</li>
        <li>Pen uses that session. The site may ask you to sign in again every few weeks</li>
      </ol>
      <Note title="Check Services first">
        <p>A direct connection is faster and lets you set Read only or Ask before changes.</p>
      </Note>
      <Fine>The session stays on this Mac. It isn't shared with your team.</Fine>
    </Sheet>
  );
}
