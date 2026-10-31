import type { InboundMailEvent } from '@splitin/outreach-contracts';

export type DsnDetails = NonNullable<InboundMailEvent['dsn']>;

/** Fields of one `message/delivery-status` body (RFC 3464). Status stays empty when absent. */
export function parseDeliveryStatus(text: string): { status: string; recipient?: string } {
  const status = /^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im.exec(text)?.[1] ?? '';
  const recipient = /^Final-Recipient:\s*rfc822;\s*(\S+)/im.exec(text)?.[1]?.toLowerCase();
  return { status, ...(recipient ? { recipient } : {}) };
}

function decodePart(headers: string, body: string): string {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return body;
}

/**
 * Status, recipient and original Message-ID from a raw multipart/report MIME message. Anything it cannot find
 * stays empty, so the classifier routes the message to review rather than suppressing on a guess.
 */
export function parseRawDsn(mime: string): DsnDetails {
  let status = '';
  let recipient: string | undefined;
  let originalMessageId: string | undefined;
  const boundaries = [...mime.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((match) => match[1] as string);
  for (const boundary of boundaries) {
    for (const part of mime.split(`--${boundary}`)) {
      const split = part.search(/\r?\n\r?\n/);
      if (split < 0) continue;
      const headers = part.slice(0, split);
      const body = decodePart(headers, part.slice(split).trim());
      if (/content-type:\s*message\/delivery-status/i.test(headers)) {
        const parsed = parseDeliveryStatus(body);
        status ||= parsed.status;
        recipient ??= parsed.recipient;
      } else if (/content-type:\s*(text\/rfc822-headers|message\/rfc822)/i.test(headers)) {
        originalMessageId ??= /^Message-ID:\s*(<[^>\s]+>)/im.exec(body)?.[1];
      }
    }
  }
  return { status, ...(recipient ? { recipient } : {}), ...(originalMessageId ? { originalMessageId } : {}) };
}

/** Whether headers look like a delivery report (a bounce), before fetching the body. */
export function looksLikeBounce(from: string, contentType: string, subject = ''): boolean {
  return (
    /mailer-daemon@|postmaster@|microsoftexchange[0-9a-f]*@/i.test(from) ||
    /report-type="?delivery-status/i.test(contentType) ||
    /^(undeliverable|delivery status notification \(failure\)|mail delivery failed)/i.test(subject)
  );
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
