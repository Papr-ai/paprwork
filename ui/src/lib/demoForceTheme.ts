/**
 * demoForceTheme — lets the landing page force the embedded demo into dark
 * mode. Paprwork themes purely via `@media (prefers-color-scheme: dark)`, which
 * a parent page/iframe cannot trigger. So we duplicate every dark-media rule as
 * an UNCONDITIONAL rule scoped under `html.demo-force-dark`, then toggle that
 * class. No-op unless VITE_DEMO_MODE === "1".
 *
 * Driven by (a) URL `?theme=dark|light` on first paint and (b) postMessage
 * `{ type: "papr-demo-theme", dark: boolean }` from the parent thereafter.
 */
const SCOPE = "html.demo-force-dark";

function scopeSelector(sel: string): string {
  return sel
    .split(",")
    .map((s) => {
      const t = s.trim();
      if (t === ":root" || t === "html" || t === ":root:root") return SCOPE;
      return `${SCOPE} ${t}`;
    })
    .join(",");
}

function buildOverrideStyle(): void {
  if (document.getElementById("demo-force-dark-style")) return;
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — skip
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSMediaRule &&
        /prefers-color-scheme\s*:\s*dark/i.test(rule.media.mediaText)
      ) {
        for (const inner of Array.from(rule.cssRules)) {
          if (inner instanceof CSSStyleRule) {
            chunks.push(
              `${scopeSelector(inner.selectorText)}{${inner.style.cssText}}`,
            );
          }
        }
      }
    }
  }
  if (!chunks.length) return;
  const style = document.createElement("style");
  style.id = "demo-force-dark-style";
  style.textContent = chunks.join("\n");
  document.head.appendChild(style);
}

function applyTheme(dark: boolean): void {
  buildOverrideStyle();
  const root = document.documentElement;
  root.classList.toggle("demo-force-dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function initDemoForceTheme(): void {
  if (import.meta.env.VITE_DEMO_MODE !== "1") return;

  const fromUrl = new URLSearchParams(location.search).get("theme");
  const run = () => applyTheme(fromUrl === "dark");
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (d && d.type === "papr-demo-theme") applyTheme(!!d.dark);
  });
}
