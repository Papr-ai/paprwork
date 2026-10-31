import type { InboundMailEvent } from '@splitin/outreach-contracts';

export type InboundClass =
  | 'human_reply'
  | 'auto_reply'
  | 'opt_out'
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complaint'
  | 'delivery'
  | 'unknown';

const AUTO_SUBJECT = /^\s*(out of (the )?office|automatic reply|auto(matic)?[- ]?(reply|response)|abwesenheitsnotiz|réponse automatique|respuesta automática|on vacation|away from (the )?office)/i;
const OPT_OUT = /\b(unsubscribe|opt[\s-]?out|remove me|take me off|stop (emailing|contacting|messaging)|do not (email|contact)|don'?t (email|contact) me)\b/i;

function header(event: InboundMailEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(event.headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : event.headers[key];
}

function isDsn(event: InboundMailEvent): boolean {
  return event.kind === 'bounce' || /report-type=("?)delivery-status\1/i.test(event.contentType ?? '');
}

/**
 * Deterministic classification (BUILD_PLAN.md §8.2). Rules only; an LLM may suggest a class for
 * `unknown` or weakly-correlated items in the review queue but never applies one.
 */
export function classifyInbound(event: InboundMailEvent): InboundClass {
  if (event.kind === 'complaint') return 'complaint';
  if (event.kind === 'delivery') return 'delivery';
  if (isDsn(event)) {
    const status = event.dsn?.status ?? '';
    if (/^5\.\d+\.\d+$/.test(status)) return 'hard_bounce';
    if (/^4\.\d+\.\d+$/.test(status)) return 'soft_bounce';
    return 'unknown';
  }
  const autoSubmitted = header(event, 'auto-submitted');
  const precedence = header(event, 'precedence')?.toLowerCase();
  if (
    (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
    header(event, 'x-autoreply') !== undefined ||
    header(event, 'x-autorespond') !== undefined ||
    precedence === 'auto_reply' ||
    precedence === 'bulk' ||
    precedence === 'junk' ||
    AUTO_SUBJECT.test(event.subject ?? '')
  ) {
    return 'auto_reply';
  }
  const text = `${event.subject ?? ''}\n${event.snippet ?? ''}`;
  if (OPT_OUT.test(text) || /^\s*stop\s*[.!]?\s*$/i.test(event.snippet ?? '')) return 'opt_out';
  return 'human_reply';
}
