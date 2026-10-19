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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Purpose to show a visitor. The old auto-sync placeholder is not one. */
function visitorPurpose(spec: RequiredKeySpec): string {
  const description = spec.description?.trim() ?? "";
  if (description && description !== AUTO_DETECTED_KEY_DESCRIPTION) {
    return description;
  }
  return lookupService(spec.name)?.description ?? "";
}

function serviceLabel(spec: RequiredKeySpec): string {
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
  const items = missing
    .map((spec) => {
      const purpose = visitorPurpose(spec);
      return `${serviceLabel(spec)} (${spec.name})${purpose ? `: ${purpose}` : ""}`;
    })
    .join("; ");
  return `The "${appTitle}" app asks me for: ${items}. Help me get these and add them to my Papr vault.`;
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
  const steps = instructions
    ? `<p class="steps">${escapeHtml(instructions)}</p>`
    : "";
  const free = freeTier ? `<span class="tag">${escapeHtml(freeTier)}</span>` : "";

  return `<section class="cardrow">
  <div class="head">
    <span class="svc">${escapeHtml(label)}</span>
    ${optional ? '<span class="tag">Optional</span>' : ""}${free}
  </div>
  ${purpose ? `<p class="purpose">${escapeHtml(purpose)}</p>` : ""}
  ${getKey}
  ${steps}
  <input type="password" name="${escapeHtml(spec.name)}" autocomplete="off" spellcheck="false"
    aria-label="${escapeHtml(label)} key" placeholder="Paste your ${escapeHtml(label)} key" />
  <details class="tech"><summary>Technical name</summary><code>${escapeHtml(spec.name)}</code></details>
</section>`;
}

export function renderCredentialSetupPage(params: {
  action: string;
  returnTo: string;
  appTitle: string;
  missing: RequiredKeySpec[];
  error?: string;
}): string {
  const cards = params.missing.map(renderCard).join("\n");
  const helpMessageJson = JSON.stringify(
    buildCredentialHelpMessage(params.appTitle, params.missing),
  ).replaceAll("<", "\\u003c");
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
    :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --text:#111827; --muted:#667085;
      --line:#e4e7ec; --accent:#2563eb; --soft:#f2f4f7; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --text:#f2f4f7;
      --muted:#98a2b3; --line:#2a2f37; --accent:#5b8def; --soft:#20242b; } }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
    .card { width:100%; max-width:480px; padding:28px 24px; border-radius:16px; background:var(--card);
      border:1px solid var(--line); }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:-0.01em; }
    .lead { margin:0 0 20px; color:var(--muted); font-size:15px; line-height:1.5; }
    .cardrow { padding:16px 0; border-top:1px solid var(--line); }
    .head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .svc { font-weight:600; font-size:15px; }
    .tag { font-size:12px; color:var(--muted); background:var(--soft); padding:2px 8px; border-radius:999px; }
    .purpose { margin:6px 0 0; font-size:14px; line-height:1.45; }
    .get { display:inline-block; margin-top:8px; font-size:14px; color:var(--accent); text-decoration:none; font-weight:500; }
    .steps { margin:4px 0 0; font-size:13px; color:var(--muted); line-height:1.4; }
    input { width:100%; margin-top:10px; padding:11px 12px; border:1px solid var(--line); border-radius:10px;
      font-size:14px; background:var(--card); color:var(--text); }
    input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
    .tech { margin-top:6px; font-size:12px; color:var(--muted); }
    .tech summary { cursor:pointer; }
    .btn { width:100%; margin-top:16px; padding:13px; border:none; border-radius:10px; background:var(--accent);
      color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
    .row { display:flex; justify-content:space-between; gap:12px; margin-top:12px; font-size:14px; }
    .link { padding:0; border:none; background:none; color:var(--accent); font:inherit; cursor:pointer; }
    .skip { color:var(--muted); }
    .error { margin:0 0 12px; color:#d92d20; font-size:14px; }
    .trust { margin:16px 0 0; font-size:12px; color:var(--muted); line-height:1.4; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect your accounts</h1>
    <p class="lead"><strong>${title}</strong> uses ${count === 1 ? "an account" : `${count} accounts`} of yours to work. Add ${count === 1 ? "it" : "them"} now, or skip and add ${count === 1 ? "it" : "them"} later.</p>
    ${errorBlock}
    <form method="POST" action="${escapeHtml(params.action)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(params.returnTo)}" />
      ${cards}
      <button class="btn" type="submit">Save and open app</button>
      <div class="row">
        <button type="button" class="link" id="ask-pen">Not sure? Ask Pen to help</button>
        <button type="submit" class="link skip" name="skip" value="1" formnovalidate>Skip for now</button>
      </div>
    </form>
    <p class="trust">Saved to your private Papr vault. The app's owner never sees your keys.</p>
  </main>
  <script>
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
