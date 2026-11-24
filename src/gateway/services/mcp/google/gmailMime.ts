/** Gmail message encode/decode (RFC 2822 + base64url). Pure functions, unit-tested. */

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === n)?.value;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Best readable body: first text/plain, else text/html stripped. */
export function messageText(payload: GmailPart | undefined): string {
  let plain: string | undefined;
  let html: string | undefined;
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.body?.data && !p.filename) {
      if (p.mimeType === "text/plain" && plain === undefined) plain = b64urlDecode(p.body.data);
      else if (p.mimeType === "text/html" && html === undefined) html = b64urlDecode(p.body.data);
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  return (plain ?? (html ? htmlToText(html) : "")).trim();
}

export function attachments(payload: GmailPart | undefined): Array<{ filename: string; mimeType?: string; size?: number }> {
  const out: Array<{ filename: string; mimeType?: string; size?: number }> = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename) out.push({ filename: p.filename, mimeType: p.mimeType, size: p.body?.size });
    p.parts?.forEach(walk);
  };
  walk(payload);
  return out;
}

/** RFC 2047 encode a header value only when it has non-ASCII. */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

export interface OutgoingEmail {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Send as HTML instead of plain text. */
  html?: boolean;
  inReplyTo?: string;
  references?: string;
}

export function buildRawEmail(m: OutgoingEmail): string {
  const lines = [
    `To: ${m.to.map(clean).join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.map(clean).join(", ")}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.map(clean).join(", ")}`] : []),
    `Subject: ${encodeHeader(clean(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${clean(m.inReplyTo)}`, `References: ${clean(m.references || m.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: ${m.html ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return b64urlEncode(lines.join("\r\n"));
}

export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
