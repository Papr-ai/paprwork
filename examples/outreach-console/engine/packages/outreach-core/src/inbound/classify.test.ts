import { describe, expect, it } from 'vitest';
import type { InboundMailEvent } from '@splitin/outreach-contracts';
import { classifyInbound } from './classify';

const base: InboundMailEvent = {
  eventId: 'e',
  kind: 'message',
  providerMessageId: 'm',
  references: [],
  from: 'lead@example.org',
  to: ['sender@example.com'],
  receivedAt: 0,
  headers: {},
};

describe('classifyInbound', () => {
  it.each([
    [{ subject: 'Re: Quick question', snippet: 'Sounds good, Tuesday works.' }, 'human_reply'],
    [{ headers: { 'Auto-Submitted': 'auto-replied' } }, 'auto_reply'],
    [{ headers: { 'auto-submitted': 'no' }, snippet: 'Real answer' }, 'human_reply'],
    [{ headers: { 'X-Autoreply': 'yes' } }, 'auto_reply'],
    [{ headers: { Precedence: 'bulk' } }, 'auto_reply'],
    [{ subject: 'Out of Office: back Monday' }, 'auto_reply'],
    [{ subject: 'Automatic reply: Quick question' }, 'auto_reply'],
    [{ snippet: 'Please unsubscribe me from this list' }, 'opt_out'],
    [{ snippet: 'remove me' }, 'opt_out'],
    [{ snippet: "Don't contact me again" }, 'opt_out'],
    [{ snippet: 'STOP' }, 'opt_out'],
    [{ snippet: 'Stop by our booth next week!' }, 'human_reply'],
    [{ kind: 'bounce', dsn: { status: '5.1.1' } }, 'hard_bounce'],
    [{ kind: 'bounce', dsn: { status: '4.2.2' } }, 'soft_bounce'],
    [{ kind: 'bounce' }, 'unknown'],
    [{ contentType: 'multipart/report; report-type="delivery-status"', dsn: { status: '5.7.1' } }, 'hard_bounce'],
    [{ kind: 'complaint' }, 'complaint'],
    [{ kind: 'delivery' }, 'delivery'],
  ] as const)('%j -> %s', (patch, expected) => {
    expect(classifyInbound({ ...base, ...(patch as Partial<InboundMailEvent>) })).toBe(expected);
  });
});
