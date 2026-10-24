import { ulid, type SqlDatabase } from '@splitin/outreach-contracts';
import { audit, requireRole, type AuthContext } from './auth';

/** Tokens a template may use. `attr.<key>` reads contact attributes from the import. */
export const KNOWN_TOKENS = [
  'first_name',
  'full_name',
  'title',
  'org_name',
  'org_domain',
  'sender_name',
  'sender_email',
  'sender_org',
  'sender_address',
  'unsubscribe_url',
] as const;

const TOKEN_RE = /\{\{\s*([a-z_]+(?:\.[a-z0-9_]+)?)\s*\}\}/gi;

export interface TemplateRow {
  id: string;
  workspace_id: string;
  name: string;
  version: number;
  channel: string;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  required_tokens: string;
}

export function extractTokens(...sources: (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const source of sources) {
    for (const match of (source ?? '').matchAll(TOKEN_RE)) tokens.add((match[1] ?? '').toLowerCase());
  }
  return [...tokens].sort();
}

export function unknownTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !(KNOWN_TOKENS as readonly string[]).includes(token) && !/^attr\.[a-z0-9_]+$/.test(token));
}

export class TemplateRenderError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Missing template values: ${missing.join(', ')}`);
    this.name = 'TemplateRenderError';
  }
}

function stripControl(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Renders `{{token}}` placeholders. Fails closed on any missing or empty value. Values are escaped in HTML. */
export function render(source: string, values: Readonly<Record<string, string | undefined>>, mode: 'text' | 'html'): string {
  const missing = new Set<string>();
  const out = source.replace(TOKEN_RE, (_, raw: string) => {
    const value = values[raw.toLowerCase()];
    if (value === undefined || value.trim() === '') {
      missing.add(raw.toLowerCase());
      return '';
    }
    // Contact data is untrusted: strip control characters and keep it on one line.
    const clean = stripControl(value);
    return mode === 'html' ? escapeHtml(clean) : clean;
  });
  if (missing.size) throw new TemplateRenderError([...missing].sort());
  return out;
}

export interface TemplateInput {
  readonly name: string;
  readonly channel: string;
  readonly subject?: string;
  readonly text: string;
  readonly html?: string;
}

/** Creates the next immutable version of a template. Existing versions are never edited. */
export function createTemplate(db: SqlDatabase, ctx: AuthContext, input: TemplateInput, now: number): TemplateRow {
  requireRole(ctx, 'operator');
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(input.name)) throw new Error('template name must be lowercase [a-z0-9_.-]');
  const tokens = extractTokens(input.subject, input.text, input.html);
  const unknown = unknownTokens(tokens);
  if (unknown.length) throw new Error(`Unknown template tokens: ${unknown.join(', ')}`);
  return db.transaction(() => {
    const latest = db
      .prepare('SELECT MAX(version) AS v FROM templates WHERE workspace_id = ? AND name = ?')
      .get<{ v: number | null }>(ctx.workspaceId, input.name);
    const version = (latest?.v ?? 0) + 1;
    const id = ulid(now);
    db.prepare(
      `INSERT INTO templates (id, workspace_id, name, version, channel, subject, body_text, body_html, required_tokens, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, ctx.workspaceId, input.name, version, input.channel, input.subject ?? null, input.text, input.html ?? null, JSON.stringify(tokens), now);
    audit(db, ctx, now, 'template', id, 'created', { name: input.name, version });
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get<TemplateRow>(id);
    if (!row) throw new Error('template vanished');
    return row;
  });
}

export function findTemplate(db: SqlDatabase, workspaceId: string, ref: string): TemplateRow | undefined {
  const [name, version] = ref.split('@');
  return db
    .prepare('SELECT * FROM templates WHERE workspace_id = ? AND name = ? AND version = ?')
    .get<TemplateRow>(workspaceId, name ?? '', Number(version));
}
