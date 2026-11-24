/**
 * Rows for the Connections → Services list (matches the Connections redesign):
 * one grouped list per section, logo + name + one status line + one action.
 */

import { useState, type ReactNode } from "react";

export type McpState = "disconnected" | "connecting" | "awaiting_user" | "connected" | "needs_reauth" | "error";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  category?: string;
  verified: boolean;
  custom: boolean;
  requiresClientId: boolean;
  state: McpState;
  toolCount: number;
  error?: string;
  authUrl?: string;
}

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

/**
 * Google's own connectors point at API hosts (gmail.googleapis.com,
 * www.googleapis.com/drive). Their favicons, and even mail.google.com /
 * drive.google.com, come back as the generic Google "G", so use the official
 * product logos instead.
 */
const GSTATIC = "https://ssl.gstatic.com/images/branding/product/2x";
const API_HOST_LOGOS: Array<[RegExp, string]> = [
  [/^gmail\.googleapis\.com\//, `${GSTATIC}/gmail_2020q4_48dp.png`],
  [/^www\.googleapis\.com\/drive\b/, `${GSTATIC}/drive_2020q4_48dp.png`],
  [/^www\.googleapis\.com\/calendar\b/, `${GSTATIC}/calendar_2020q4_48dp.png`],
];

/** Service's own site, from its MCP URL (mcp.linear.app → linear.app). */
export function siteDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^(mcp|api|www)\./, "");
  } catch {
    return null;
  }
}

/** Logo image URL: a known product logo, else the site's favicon. */
export function logoUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const hostPath = u.hostname + u.pathname;
    for (const [re, logo] of API_HOST_LOGOS) if (re.test(hostPath)) return logo;
  } catch {
    return null;
  }
  const domain = siteDomain(url);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null;
}

export function ServiceLogo({ server, size = "md" }: { server: Pick<McpServer, "name" | "url">; size?: "sm" | "md" | "lg" }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  const src = logoUrl(server.url);
  return (
    <span
      className={`svc-logo svc-logo--${size}${state === "ok" ? " svc-logo--img" : ""}`}
      aria-hidden
      data-ini={initials(server.name)}
    >
      {src && state !== "failed" && (
        <img src={src} alt="" onLoad={() => setState("ok")} onError={() => setState("failed")} />
      )}
    </span>
  );
}

export type RowTone = "ok" | "wait" | "warn" | "plain";

export function ServiceRow({
  server,
  status,
  tone = "plain",
  tag,
  action,
  onOpen,
  dim,
  footer,
}: {
  server: Pick<McpServer, "name" | "url">;
  status: ReactNode;
  tone?: RowTone;
  tag?: string;
  action?: ReactNode;
  onOpen?: () => void;
  dim?: boolean;
  footer?: ReactNode;
}) {
  return (
    <div
      className={`svc-row svc-row--${tone}${dim ? " svc-row--dim" : ""}${onOpen ? " svc-row--clickable" : ""}`}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && onOpen() : undefined}
    >
      <ServiceLogo server={server} />
      <div className="svc-row__text">
        <b className="svc-row__name">{server.name}</b>
        <span className={`svc-st svc-st--${tone}`}>
          {tone === "wait" ? <i className="svc-st__spin" /> : tone !== "plain" ? <i /> : null}
          {status}
        </span>
        {footer}
      </div>
      {tag && <span className="svc-tag">{tag}</span>}
      {action ?? (onOpen ? <Chevron /> : null)}
    </div>
  );
}

export function Chevron() {
  return (
    <svg className="svc-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** Stops the row's open handler when a button inside it is clicked. */
export function RowButton({
  children,
  onClick,
  primary,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`svc-btn${primary ? " svc-btn--primary" : ""}`}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
