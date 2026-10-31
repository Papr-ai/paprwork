import { randomBytes } from 'node:crypto';
import type { ApprovedEmail, EmailAddress } from './providers';

/** The message cannot be expressed safely as MIME (header injection, reserved header, bad address). */
export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MimeError';
  }
}

/** Header the adapter adds to every message; reconciliation matches on it. */
export const IDEMPOTENCY_HEADER = 'X-Outreach-Key';

/** Headers the adapter owns. Callers pass anything else (List-Unsubscribe, ...) through `headers`. */
const RESERVED = new Set([
  'from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'references',
  'mime-version', 'content-type', 'content-transfer-encoding', IDEMPOTENCY_HEADER.toLowerCase(),
]);
const HEADER_NAME = /^[!-9;-~]+$/;
const ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

function assertNoBreaks(value: string, what: string): void {
  if (/[\r\n\0]/.test(value)) throw new MimeError(`${what} contains a line break`);
}

/** RFC 2047 encoded words of at most 45 UTF-8 bytes each (so every word stays under 75 characters). */
function encodeWords(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const words: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function formatAddress(address: EmailAddress, what: string): string {
  assertNoBreaks(address.address, what);
  if (!ADDRESS.test(address.address)) throw new MimeError(`${what} "${address.address.slice(0, 80)}" is not a plain address`);
  if (!address.name) return address.address;
  assertNoBreaks(address.name, `${what} name`);
  const name = ASCII_PRINTABLE.test(address.name) ? `"${address.name.replace(/["\\]/g, '\\$&')}"` : encodeWords(address.name);
  return `${name} <${address.address}>`;
}

function base64Lines(text: string): string {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

function messageIdToken(value: string, what: string): string {
  assertNoBreaks(value, what);
  if (!/^<[^<>\s]+>$/.test(value)) throw new MimeError(`${what} must look like <id@domain>`);
  return value;
}

/**
 * Builds an RFC 5322 message with CRLF line endings. Bodies are base64 (UTF-8); with HTML the message is
 * multipart/alternative with the text part first.
 */
export function buildMime(email: ApprovedEmail, date: Date, boundary = `=_outreach_${randomBytes(12).toString('hex')}`): string {
  if (email.to.length === 0) throw new MimeError('a message needs at least one recipient');
  const lines: string[] = [
    `From: ${formatAddress(email.from, 'From')}`,
    `To: ${email.to.map((to) => formatAddress(to, 'To')).join(', ')}`,
  ];
  if (email.replyTo) lines.push(`Reply-To: ${formatAddress(email.replyTo, 'Reply-To')}`);
  assertNoBreaks(email.subject, 'Subject');
  lines.push(`Subject: ${encodeWords(email.subject)}`, `Date: ${date.toUTCString()}`, `Message-ID: ${messageIdToken(email.rfcMessageId, 'Message-ID')}`);
  if (email.inReplyTo) lines.push(`In-Reply-To: ${messageIdToken(email.inReplyTo, 'In-Reply-To')}`);
  if (email.references?.length) lines.push(`References: ${email.references.map((id) => messageIdToken(id, 'References')).join(' ')}`);
  for (const [name, value] of Object.entries(email.headers)) {
    if (!HEADER_NAME.test(name)) throw new MimeError(`invalid header name "${name.slice(0, 40)}"`);
    if (RESERVED.has(name.toLowerCase())) throw new MimeError(`header ${name} is set by the adapter`);
    assertNoBreaks(value, `header ${name}`);
    lines.push(`${name}: ${ASCII_PRINTABLE.test(value) ? value : encodeWords(value)}`);
  }
  assertNoBreaks(email.idempotencyKey, IDEMPOTENCY_HEADER);
  lines.push(`${IDEMPOTENCY_HEADER}: ${email.idempotencyKey}`, 'MIME-Version: 1.0');

  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(email.text)];
  if (!email.html) return [...lines, ...textPart, ''].join('\r\n');
  const htmlPart = ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Lines(email.html)];
  return [
    ...lines,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    ...htmlPart,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
