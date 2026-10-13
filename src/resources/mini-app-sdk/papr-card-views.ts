/**
 * Default card views, so an app gets good Claude cards with zero UI code.
 * The publish-time card builder generates one entry per view in metadata.json:
 *
 *   status   → runs a read action, shows its result (number, key/values or a table)
 *   action   → a form built from the action's `input` schema + one primary button
 *   approval → shows what's proposed (tool data) and asks before it runs
 */

import { card, type CardContext, type CardEffect } from "./papr-card.ts";

export interface InputField {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  default?: string | number | boolean;
  format?: string;
  maxLength?: number;
}

export interface InputSchema {
  type?: "object";
  properties?: Record<string, InputField>;
  required?: string[];
}

export interface ViewActionSpec {
  action: string;
  label?: string;
  effect?: CardEffect;
  runsOn?: "cloud" | "mac";
  input?: InputSchema;
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const label = (key: string): string => key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const cell = (v: unknown): string => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));

/** Renders any action result: scalar, object (key/values), array of rows (table). */
export function renderValue(value: unknown, maxRows = 20): string {
  if (value === null || value === undefined || value === "") return `<p class="pc-mu">Nothing yet</p>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<p class="pc-mu">Nothing yet</p>`;
    if (value.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      const cols = [...new Set(value.slice(0, maxRows).flatMap((r) => Object.keys(r as object)))].slice(0, 6);
      const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join("");
      const rows = value
        .slice(0, maxRows)
        .map((r) => `<tr>${cols.map((c) => `<td>${esc(cell((r as Record<string, unknown>)[c]))}</td>`).join("")}</tr>`)
        .join("");
      const more = value.length > maxRows ? `<p class="pc-mu">+${value.length - maxRows} more in Papr</p>` : "";
      return `<table class="pc-tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${more}`;
    }
    return `<p>${value.slice(0, maxRows).map((v) => esc(cell(v))).join(", ")}</p>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
    return `<dl class="pc-kv">${entries.map(([k, v]) => `<dt>${esc(label(k))}</dt><dd>${esc(cell(v))}</dd>`).join("")}</dl>`;
  }
  return `<p>${esc(value)}</p>`;
}

export function renderForm(schema: InputSchema | undefined): string {
  const props = Object.entries(schema?.properties ?? {});
  if (props.length === 0) return "";
  const req = new Set(schema?.required ?? []);
  const fields = props.map(([key, f]) => {
    const name = esc(key);
    const title = esc(f.title ?? label(key)) + (req.has(key) ? "" : ` <span class="pc-mu">(optional)</span>`);
    if (f.type === "boolean") {
      return `<label class="pc-check"><input type="checkbox" name="${name}"${f.default ? " checked" : ""}> ${title}</label>`;
    }
    if (f.enum) {
      const opts = f.enum.map((o) => `<option${o === f.default ? " selected" : ""}>${esc(o)}</option>`).join("");
      return `<label>${title}<select name="${name}">${opts}</select></label>`;
    }
    const type = f.type === "number" || f.type === "integer" ? "number" : f.format === "email" ? "email" : "text";
    const long = f.type === "string" && (f.maxLength ?? 0) > 200;
    const attrs = `name="${name}"${req.has(key) ? " required" : ""} placeholder="${esc(f.description ?? "")}"`;
    return long
      ? `<label>${title}<textarea ${attrs} rows="3">${esc(f.default ?? "")}</textarea></label>`
      : `<label>${title}<input type="${type}" ${attrs} value="${esc(f.default ?? "")}"></label>`;
  });
  return `<form class="pc-form" id="pc-form">${fields.join("")}</form>`;
}

/** Reads the form into action params; null when a required field is empty. */
export function readForm(form: HTMLFormElement | null, schema: InputSchema | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, f] of Object.entries(schema?.properties ?? {})) {
    const el = form?.elements.namedItem(key) as HTMLInputElement | null;
    const value = f.type === "boolean" ? String(Boolean(el?.checked)) : (el?.value ?? "").trim();
    if (!value && (schema?.required ?? []).includes(key)) return null;
    if (value) out[key] = value;
  }
  return out;
}

export function statusView(opts: { from: string; primary?: ViewActionSpec }): Promise<CardContext> {
  return card({
    primary: opts.primary && { label: opts.primary.label ?? label(opts.primary.action), ...opts.primary },
    async render(ctx) {
      ctx.body.innerHTML = `<p class="pc-mu">Loading…</p>`;
      ctx.body.innerHTML = renderValue(await ctx.run(opts.from));
    },
  });
}

export function actionView(spec: ViewActionSpec): Promise<CardContext> {
  return card({
    primary: {
      label: spec.label ?? label(spec.action),
      action: spec.action,
      effect: spec.effect,
      runsOn: spec.runsOn,
      params: (ctx) => readForm(ctx.body.querySelector("form"), spec.input),
    },
    render(ctx) {
      const prefill = ctx.data as Record<string, unknown>;
      ctx.body.innerHTML = renderForm(spec.input) || `<p class="pc-mu">Ready when you are.</p>`;
      const form = ctx.body.querySelector("form");
      for (const [k, v] of Object.entries(prefill)) {
        const el = form?.elements.namedItem(k) as HTMLInputElement | null;
        if (el && v !== undefined && v !== null) el.type === "checkbox" ? (el.checked = Boolean(v)) : (el.value = String(v));
      }
    },
  });
}

export function approvalView(spec: ViewActionSpec): Promise<CardContext> {
  return card({
    primary: {
      label: spec.label ?? label(spec.action),
      action: spec.action,
      effect: "external",
      runsOn: spec.runsOn,
      params: (ctx) => (ctx.data.params as Record<string, string> | undefined) ?? {},
    },
    render(ctx) {
      const proposal = ctx.data.proposal ?? ctx.data;
      ctx.body.innerHTML = `<p class="pc-mu" style="margin-bottom:8px">Review before it goes out</p>${renderValue(proposal)}`;
    },
  });
}
