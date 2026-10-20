/**
 * Visitor credential setup page for published apps (apps.papr.ai).
 *
 * One card per key, written for someone who has never seen the app's code:
 * the service, what the app does with it (the declared purpose), and where to
 * get it. Env var names stay out of the way. Visitors can always skip: the
 * app opens, and only the features that need a missing key fail (the API
 * gate returns credentials_required with a link back here).
 */

import type { RequiredKeySpec } from "../../../core/types/bundles.js";
import { lookupService } from "../../../core/data/knownServices.js";
import { AUTO_DETECTED_KEY_DESCRIPTION } from "../appKeyDeclarations.js";
import { PLATFORM_REGISTRY } from "../platforms/platformRegistry.js";
import { PLATFORM_ICON_BG, PLATFORM_ICON_PATHS } from "./cloudAppPlatformIcons.js";

/**
 * Sign-in sessions (Reddit, LinkedIn, X, …) are not API keys: Papr Work captures
 * them when you sign in through Connected Platforms (REDDIT_REDDIT_SESSION, …)
 * and syncs them to your cloud vault. The page shows one "Connect Reddit" card
 * for all of a platform's keys instead of asking anyone to paste a cookie.
 */
export interface PlatformSignIn {
  id: string;
  name: string;
  keys: RequiredKeySpec[];
}

export function platformForKey(name: string): { id: string; name: string } | null {
  for (const p of Object.values(PLATFORM_REGISTRY)) {
    const cookies = [...p.requiredCookies, ...(p.optionalCookies ?? [])];
    if (cookies.some((c) => `${p.keyPrefix}_${c.toUpperCase()}` === name)) {
      return { id: p.id, name: p.name };
    }
  }
  return null;
}

export function splitPlatformKeys(missing: RequiredKeySpec[]): {
  platforms: PlatformSignIn[];
  apiKeys: RequiredKeySpec[];
} {
  const byId = new Map<string, PlatformSignIn>();
  const apiKeys: RequiredKeySpec[] = [];
  for (const spec of missing) {
    const p = platformForKey(spec.name);
    if (!p) {
      apiKeys.push(spec);
      continue;
    }
    const entry = byId.get(p.id) ?? { ...p, keys: [] };
    entry.keys.push(spec);
    byId.set(p.id, entry);
  }
  return { platforms: [...byId.values()], apiKeys };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Old auto-sync placeholders ("Server-side key for … (synced from …)"): never a purpose. */
function isPlaceholderDescription(description: string): boolean {
  return description === AUTO_DETECTED_KEY_DESCRIPTION || /^server-side key for .*\(synced from /i.test(description);
}

/** Purpose to show a visitor. The old auto-sync placeholders are not one. */
function visitorPurpose(spec: RequiredKeySpec): string {
  const description = spec.description?.trim() ?? "";
  if (description && !isPlaceholderDescription(description)) {
    return description;
  }
  return lookupService(spec.name)?.description ?? "";
}

function serviceLabel(spec: RequiredKeySpec): string {
  const platform = platformForKey(spec.name);
  if (platform) return platform.name;
  const known = lookupService(spec.name);
  const service = spec.service?.trim();
  if (service && service !== spec.name) return service;
  return known?.service ?? spec.name;
}

export function buildCredentialHelpMessage(
  appTitle: string,
  missing: RequiredKeySpec[],
): string {
  if (missing.length === 0) {
    return `Help me set up my accounts for the "${appTitle}" app.`;
  }
  const { platforms, apiKeys } = splitPlatformKeys(missing);
  const signIns = platforms.map(
    (p) => `${p.name} sign-in (connect ${p.name} in Papr Work's Connected Platforms)`,
  );
  const items = [...signIns, ...apiKeys
    .map((spec) => {
      const purpose = visitorPurpose(spec);
      return `${serviceLabel(spec)} (${spec.name})${purpose ? `: ${purpose}` : ""}`;
    })]
    .join("; ");
  return `The "${appTitle}" app asks me for: ${items}. Help me get these and add them to my Papr vault.`;
}

function platformMark(id: string, name: string): string {
  const path = PLATFORM_ICON_PATHS[id];
  const bg = PLATFORM_ICON_BG[id] ?? "#0060e0";
  const inner = path
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`
    : escapeHtml(name.charAt(0));
  return `<span class="mark" style="background:${bg}">${inner}</span>`;
}

function letterMark(label: string): string {
  return `<span class="mark mark--key">${escapeHtml(label.charAt(0).toUpperCase())}</span>`;
}

function renderCard(spec: RequiredKeySpec): string {
  const known = lookupService(spec.name);
  const label = serviceLabel(spec);
  const purpose = visitorPurpose(spec);
  const signupUrl = spec.signupUrl ?? known?.signupUrl;
  const instructions = spec.instructions ?? known?.instructions;
  const freeTier = spec.freeTierNote ?? known?.freeTierNote;
  const optional = spec.required === false;

  const getKey = signupUrl
    ? `<a class="get" href="${escapeHtml(signupUrl)}" target="_blank" rel="noopener noreferrer">Get a ${escapeHtml(label)} key &rarr;</a>`
    : "";
  return `<section class="acct acct--key">
  <div class="acct__row">
    ${letterMark(label)}
    <span class="acct__text">
      <b>${escapeHtml(label)}${optional ? ' <span class="tag">Optional</span>' : ""}${freeTier ? ` <span class="tag">${escapeHtml(freeTier)}</span>` : ""}</b>
      ${purpose ? `<small class="purpose">${escapeHtml(purpose)}</small>` : ""}
    </span>
  </div>
  <div class="acct__body">
    <input type="password" name="${escapeHtml(spec.name)}" autocomplete="off" spellcheck="false"
      aria-label="${escapeHtml(label)} key" placeholder="Paste your ${escapeHtml(label)} key" />
    <div class="acct__meta">${getKey}${instructions ? `<span class="steps">${escapeHtml(instructions)}</span>` : ""}</div>
    <details class="tech"><summary>Technical name</summary><code>${escapeHtml(spec.name)}</code></details>
  </div>
</section>`;
}

function renderPlatformCard(p: PlatformSignIn): string {
  const name = escapeHtml(p.name);
  const optional = p.keys.every((k) => k.required === false);
  const purpose = p.keys.map(visitorPurpose).find((d) => d && !/session cookie/i.test(d)) ?? "";
  return `<section class="acct plat" data-platform="${escapeHtml(p.id)}" data-keys="${escapeHtml(p.keys.map((k) => k.name).join(","))}">
  <div class="acct__row">
    ${platformMark(p.id, p.name)}
    <span class="acct__text">
      <b>${name}${optional ? ' <span class="tag">Optional</span>' : ""}</b>
      <small class="purpose">${purpose ? escapeHtml(purpose) : `Sign in to ${name} so this app can work as you.`}</small>
    </span>
    <button type="button" class="pill connect" data-connect="${escapeHtml(p.id)}" aria-label="Connect ${name}">Connect</button>
    <span class="pill pill--wait" hidden><span class="spin"></span>Waiting</span>
    <span class="pill pill--ok" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Connected</span>
  </div>
  <p class="note wait" hidden>Finish signing in to ${name} in Papr Work. This page continues by itself.</p>
  <p class="note slow" hidden>Still waiting for your ${name} sign-in to reach your vault. Check that Cloud Sync is on in Papr Work, or skip for now.</p>
  <p class="note nodesk" hidden>Connecting ${name} needs Papr Work on this computer. <a href="https://papr.ai/download" target="_blank" rel="noopener">Get Papr Work</a>, or skip for now.</p>
  <details class="tech"><summary>Paste a session instead</summary>
    ${p.keys.map((k) => `<input type="password" name="${escapeHtml(k.name)}" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(k.name)}" placeholder="${escapeHtml(k.name)}" />`).join("\n    ")}
    <button class="btn btn--sm" type="submit">Save and open app</button>
  </details>
</section>`;
}

export function renderCredentialSetupPage(params: {
  action: string;
  returnTo: string;
  appTitle: string;
  missing: RequiredKeySpec[];
  error?: string;
  /** GET → { ready, missing[] }; lets the page continue once Papr Work syncs a sign-in. */
  statusUrl?: string;
}): string {
  const { platforms, apiKeys } = splitPlatformKeys(params.missing);
  const cards = [...platforms.map(renderPlatformCard), ...apiKeys.map(renderCard)].join("\n");
  const onlySignIns = apiKeys.length === 0;
  const statusUrlJson = JSON.stringify(params.statusUrl ?? "").replace(/</g, "\\u003c");
  const returnToJson = JSON.stringify(params.returnTo).replace(/</g, "\\u003c");
  const helpMessageJson = JSON.stringify(
    buildCredentialHelpMessage(params.appTitle, params.missing),
  ).replace(/</g, "\\u003c");
  const count = params.missing.length;
  const title = escapeHtml(params.appTitle);
  const errorBlock = params.error
    ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connect your accounts · ${title}</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f7f9; --card:rgba(255,255,255,.92); --line:rgba(10,16,32,.06);
      --ink:#1d1d1f; --soft:#6e6e73; --faint:#8e8e93; --blue:#0060e0; --hover:rgba(0,96,224,.07);
      --field:#fff; --field-line:rgba(10,16,32,.12); --chip:rgba(10,16,32,.05); }
    @media (prefers-color-scheme: dark) { :root { --bg:#0e1015; --card:rgba(28,30,36,.92); --line:rgba(255,255,255,.08);
      --ink:#f5f5f7; --soft:#aeaeb2; --faint:#8e8e93; --blue:#4c95ff; --hover:rgba(76,149,255,.12);
      --field:rgba(255,255,255,.04); --field-line:rgba(255,255,255,.12); --chip:rgba(255,255,255,.08); } }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
      font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif; color:var(--ink);
      background:radial-gradient(1200px 600px at 50% -10%,rgba(0,172,250,.10),transparent 60%),var(--bg); }
    .card { width:100%; max-width:420px; padding:8px; border-radius:18px; background:var(--card);
      backdrop-filter:blur(22px) saturate(1.6); -webkit-backdrop-filter:blur(22px) saturate(1.6);
      box-shadow:0 18px 50px rgba(10,16,32,.16),0 0 0 1px var(--line); animation:rise .22s ease-out; }
    @keyframes rise { from { opacity:0; transform:translateY(8px) scale(.985); } }
    header { padding:14px 12px 10px; }
    h1 { margin:0; font-size:17px; font-weight:600; letter-spacing:-.01em; }
    .lead { margin:4px 0 0; color:var(--soft); font-size:13px; }
    h6 { margin:6px 12px 4px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--faint); }
    .accts { display:flex; flex-direction:column; gap:1px; }
    .acct { border-radius:12px; padding:2px 0; transition:background .12s; }
    .acct:hover { background:var(--hover); }
    .acct__row { display:flex; align-items:center; gap:12px; padding:8px 10px; }
    .mark { flex:0 0 auto; width:34px; height:34px; border-radius:28%; display:grid; place-items:center; color:#fff;
      font-weight:700; font-size:15px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.06); }
    .mark svg { width:19px; height:19px; }
    .mark--key { background:linear-gradient(135deg,#00acfa,#0060e0); }
    .acct__text { flex:1; min-width:0; display:flex; flex-direction:column; }
    .acct__text b { font-weight:600; font-size:14px; }
    .acct__text small { color:var(--soft); font-size:12.5px; line-height:1.4; }
    .tag { display:inline-block; margin-left:4px; padding:1px 7px; border-radius:999px; background:var(--chip);
      color:var(--soft); font-size:11px; font-weight:500; vertical-align:1px; }
    .pill { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 14px; border-radius:999px;
      border:none; font:600 13px/1 inherit; font-family:inherit; white-space:nowrap; }
    .connect { background:var(--blue); color:#fff; cursor:pointer; transition:transform .1s,filter .12s; }
    .connect:hover { filter:brightness(1.08); } .connect:active { transform:scale(.97); }
    .pill--wait { background:var(--chip); color:var(--soft); }
    .pill--ok { background:rgba(18,183,106,.14); color:#067647; padding-left:10px; }
    .pill--ok svg { width:14px; height:14px; }
    @media (prefers-color-scheme: dark) { .pill--ok { color:#4ade80; } }
    .pill[hidden], .note[hidden] { display:none; }
    .note { margin:0 10px 8px 56px; color:var(--soft); font-size:12.5px; }
    .note a, .get { color:var(--blue); text-decoration:none; font-weight:500; }
    .acct__body { padding:0 10px 10px 56px; }
    input { width:100%; padding:9px 11px; border:1px solid var(--field-line); border-radius:10px; background:var(--field);
      color:var(--ink); font:inherit; font-size:13px; }
    input:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px var(--hover); }
    .acct__meta { display:flex; flex-wrap:wrap; gap:4px 10px; margin-top:6px; font-size:12.5px; }
    .steps { color:var(--soft); }
    .tech { margin:0 10px 8px 56px; font-size:12px; color:var(--faint); }
    .acct--key .tech { margin:6px 0 0; }
    .tech summary { cursor:pointer; width:max-content; }
    .tech input { margin-top:6px; }
    .plat.done .tech, .plat.done .note { display:none; }
    .spin { width:11px; height:11px; border-radius:50%; border:1.6px solid currentColor; border-right-color:transparent;
      animation:spin .7s linear infinite; }
    @keyframes spin { to { transform:rotate(1turn); } }
    footer { margin-top:6px; padding:10px 12px 8px; border-top:1px solid var(--line); }
    .btn { width:100%; height:40px; border:none; border-radius:12px; background:var(--blue); color:#fff;
      font:600 14px/1 inherit; font-family:inherit; cursor:pointer; margin-bottom:8px; }
    .btn--sm { height:32px; margin:8px 0 0; font-size:13px; border-radius:10px; }
    .row { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .link { padding:6px 0; border:none; background:none; font:inherit; font-size:13px; cursor:pointer; color:var(--blue); font-weight:500; }
    .skip { color:var(--soft); }
    .error { margin:0 12px 8px; padding:8px 10px; border-radius:10px; background:rgba(217,45,32,.08); color:#d92d20; font-size:13px; }
    .trust { margin:2px 0 0; font-size:11.5px; color:var(--faint); text-align:center; }
  </style>
</head>
<body>
  <main class="card">
    <header>
      <h1>Connect your accounts</h1>
      <p class="lead"><strong>${title}</strong> uses ${count === 1 ? "an account" : `${count} accounts`} of yours. Add ${count === 1 ? "it" : "them"} now, or skip and add ${count === 1 ? "it" : "them"} later.</p>
    </header>
    ${errorBlock}
    <form method="POST" action="${escapeHtml(params.action)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(params.returnTo)}" />
      <div class="accts">
      ${cards}
      </div>
      <footer>
        ${onlySignIns ? "" : '<button class="btn" type="submit">Save and open app</button>'}
        <div class="row">
          <button type="button" class="link" id="ask-pen">Not sure? Ask Pen to help</button>
          <button type="submit" class="link skip" name="skip" value="1" formnovalidate>Skip for now</button>
        </div>
        <p class="trust">Saved to your private Papr vault. The app's owner never sees your keys.</p>
      </footer>
    </form>
  </main>
  <script>
    (function () {
      var statusUrl = ${statusUrlJson};
      var returnTo = ${returnToJson};
      var inFrame = window.parent !== window;
      var polling = null;
      function show(card, state) {
        var q = function (s) { return card.querySelector(s); };
        q(".connect").hidden = state !== "idle" && state !== "nodesk";
        q(".pill--wait").hidden = state !== "wait" && state !== "slow";
        q(".pill--ok").hidden = state !== "done";
        q(".wait").hidden = state !== "wait";
        q(".slow").hidden = state !== "slow";
        q(".nodesk").hidden = state !== "nodesk";
        card.classList.toggle("done", state === "done");
      }
      function poll() {
        if (!statusUrl || polling) return;
        polling = window.setInterval(function () {
          fetch(statusUrl, { credentials: "same-origin", cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
              if (!s) return;
              var missing = s.missing || [];
              document.querySelectorAll(".plat").forEach(function (card) {
                var keys = (card.getAttribute("data-keys") || "").split(",");
                if (keys.every(function (k) { return missing.indexOf(k) < 0; })) show(card, "done");
              });
              if (s.ready) { window.clearInterval(polling); window.setTimeout(function () { window.location.href = returnTo; }, 500); }
            })
            .catch(function () {});
        }, 2000);
      }
      document.querySelectorAll("[data-connect]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-connect");
          var card = btn.closest(".plat");
          show(card, "wait");
          poll();
          window.setTimeout(function () { if (!card.classList.contains("done") && !card.querySelector(".wait").hidden) show(card, "slow"); }, 20000);
          if (inFrame) {
            window.parent.postMessage({ type: "papr-connect-platform", platform: id }, "*");
            return;
          }
          var opened = false;
          function mark() { opened = true; }
          window.addEventListener("blur", mark, { once: true });
          document.addEventListener("visibilitychange", function () { if (document.hidden) mark(); }, { once: true });
          window.setTimeout(function () { if (!opened) show(card, "nodesk"); }, 2000);
          window.location.href = "papr://connections/connect?platform=" + encodeURIComponent(id);
        });
      });
    })();
    (function () {
      var helpMessage = ${helpMessageJson};
      var btn = document.getElementById("ask-pen");
      if (!btn) return;
      btn.addEventListener("click", function () {
        // Inside Paprwork (desktop preview iframe): open chat there.
        if (window.parent !== window) {
          window.parent.postMessage({ type: "papr-open-chat", message: helpMessage }, "*");
          return;
        }
        var fallback = window.setTimeout(function () { window.location.href = "https://papr.ai"; }, 1800);
        function cancel() { window.clearTimeout(fallback); }
        window.addEventListener("blur", cancel, { once: true });
        document.addEventListener("visibilitychange", function () { if (document.hidden) cancel(); }, { once: true });
        window.location.href = "papr://chat/open?message=" + encodeURIComponent(helpMessage);
      });
    })();
  </script>
</body>
</html>`;
}
