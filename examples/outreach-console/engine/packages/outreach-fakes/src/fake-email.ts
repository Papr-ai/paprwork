import {
  hmacSha256Hex,
  safeEqualHex,
  type AccountHealth,
  type ApprovedEmail,
  type CapabilitySnapshot,
  type ErrorClass,
  type InboundMailEvent,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderPurpose,
  type ProviderReceipt,
  type ReconcileResult,
  type SendResult,
  type UncertainEmail,
} from '@splitin/outreach-contracts';

/** What the next `send` call does. The fake records a delivery only when the effect really "happened". */
export type FakeSendMode =
  | { kind: 'accept' }
  | { kind: 'reject'; errorClass: ErrorClass; retryAfterMs?: number }
  /** Delivered, but the caller never learns it (timeout after the provider accepted). */
  | { kind: 'unknown_after_accept' }
  /** Not delivered, and the caller cannot tell (timeout before the provider saw it). */
  | { kind: 'unknown_before_accept' }
  /** Delivered, then the adapter throws (bug or crash inside the adapter). */
  | { kind: 'throw_after_accept' };

export interface FakeDelivery {
  readonly providerMessageId: string;
  readonly providerThreadId: string;
  readonly rfcMessageId: string;
  readonly idempotencyKey: string;
  readonly actionId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly at: number;
}

export interface FakeEmailOptions {
  readonly name?: string;
  readonly purposes?: readonly ProviderPurpose[];
  /** The secret value the fake expects from `ctx.secrets.get(ctx.secretRef)`. */
  readonly secret?: string;
  readonly externalIdempotency?: boolean;
  /** `authoritative`: reconcile answers found/absent. `still_unknown`: reconcile can never decide. */
  readonly reconcile?: 'authoritative' | 'still_unknown';
  readonly webhookSecret?: string;
}

export const FAKE_EMAIL_SECRET = 'fake-email-secret-value';
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-value';
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** Deterministic in-memory email provider for tests and dry runs. */
export class FakeEmailProvider {
  readonly name: string;
  readonly deliveries: FakeDelivery[] = [];
  readonly inbound: InboundMailEvent[] = [];
  sendCalls = 0;
  reconcileCalls = 0;
  healthStatus: AccountHealth = 'ok';
  reconcileMode: 'authoritative' | 'still_unknown';
  private readonly queue: FakeSendMode[] = [];
  private defaultMode: FakeSendMode = { kind: 'accept' };
  private readonly purposes: readonly ProviderPurpose[];
  private readonly secret: string;
  private readonly webhookSecret: string;
  private readonly externalIdempotency: boolean;
  private counter = 0;
  /** Distinguishes ids across fake instances (e.g. several worker processes in the soak test). */
  private readonly instance = Math.random().toString(36).slice(2, 8);

  constructor(options: FakeEmailOptions = {}) {
    this.name = options.name ?? 'fake-email';
    this.purposes = options.purposes ?? ['manual_correspondence', 'transactional', 'automated_outreach'];
    this.secret = options.secret ?? FAKE_EMAIL_SECRET;
    this.webhookSecret = options.webhookSecret ?? FAKE_WEBHOOK_SECRET;
    this.externalIdempotency = options.externalIdempotency ?? false;
    this.reconcileMode = options.reconcile ?? 'authoritative';
  }

  /** Queue modes for the next `send` calls, in order. */
  script(...modes: FakeSendMode[]): this {
    this.queue.push(...modes);
    return this;
  }

  setDefault(mode: FakeSendMode): this {
    this.defaultMode = mode;
    return this;
  }

  deliveriesFor(rfcMessageId: string): FakeDelivery[] {
    return this.deliveries.filter((delivery) => delivery.rfcMessageId === rfcMessageId);
  }

  adapter(): ProviderAdapter {
    return {
      name: this.name,
      purposes: this.purposes,
      account: {
        discover: async (ctx) => this.capabilities(ctx.now()),
        health: async () => ({ status: this.healthStatus }),
      },
      email: {
        send: (ctx, email) => this.send(ctx, email),
        reconcile: (ctx, email) => this.reconcile(ctx, email),
      },
      mailbox: {
        readChanges: async (_ctx, cursor) => {
          const start = cursor ? Number.parseInt(cursor, 10) : 0;
          return { events: this.inbound.slice(start), nextCursor: String(this.inbound.length) };
        },
      },
      webhook: {
        verify: async (rawBody, headers, secret, now) => this.verifyWebhook(rawBody, headers, secret, now),
      },
    };
  }

  capabilities(now: number): CapabilitySnapshot {
    return {
      provider: this.name,
      send: true,
      replyInThread: true,
      customHeaders: true,
      externalIdempotency: this.externalIdempotency,
      inboundWebhook: true,
      mailboxPolling: true,
      reconcileBySentSearch: this.reconcileMode === 'authoritative',
      maxRecipientsPerMessage: 1,
      discoveredAt: now,
    };
  }

  private async send(ctx: ProviderContext, email: ApprovedEmail): Promise<SendResult> {
    this.sendCalls += 1;
    if (ctx.signal.aborted) return { kind: 'unknown', detail: 'aborted before send' };
    if ((await ctx.secrets.get(ctx.secretRef)) !== this.secret) {
      return { kind: 'rejected', errorClass: 'auth_revoked', detail: 'credential rejected' };
    }
    const mode = this.queue.shift() ?? this.defaultMode;
    if (this.externalIdempotency) {
      const existing = this.deliveries.find((delivery) => delivery.idempotencyKey === email.idempotencyKey);
      if (existing && mode.kind === 'accept') return { kind: 'accepted', receipt: toReceipt(existing) };
    }
    switch (mode.kind) {
      case 'accept':
        return { kind: 'accepted', receipt: toReceipt(this.deliver(ctx, email)) };
      case 'reject':
        return {
          kind: 'rejected',
          errorClass: mode.errorClass,
          detail: `fake rejection: ${mode.errorClass}`,
          ...(mode.retryAfterMs === undefined ? {} : { retryAfterMs: mode.retryAfterMs }),
        };
      case 'unknown_after_accept':
        this.deliver(ctx, email);
        return { kind: 'unknown', detail: 'fake timeout after accept' };
      case 'unknown_before_accept':
        return { kind: 'unknown', detail: 'fake timeout before accept' };
      case 'throw_after_accept':
        this.deliver(ctx, email);
        throw new Error('fake adapter crashed after accept');
    }
  }

  private async reconcile(_ctx: ProviderContext, email: UncertainEmail): Promise<ReconcileResult> {
    this.reconcileCalls += 1;
    if (this.reconcileMode === 'still_unknown') return { kind: 'still_unknown', detail: 'fake cannot search' };
    const match = this.deliveries.find(
      (delivery) => delivery.rfcMessageId === email.rfcMessageId || delivery.idempotencyKey === email.idempotencyKey,
    );
    return match ? { kind: 'found', receipt: toReceipt(match) } : { kind: 'absent' };
  }

  private deliver(ctx: ProviderContext, email: ApprovedEmail): FakeDelivery {
    this.counter += 1;
    const parent = email.inReplyTo ? this.deliveries.find((d) => d.rfcMessageId === email.inReplyTo) : undefined;
    const delivery: FakeDelivery = {
      providerMessageId: `fake-msg-${this.instance}-${this.counter}`,
      providerThreadId: email.providerThreadId ?? parent?.providerThreadId ?? `fake-thread-${this.instance}-${this.counter}`,
      rfcMessageId: email.rfcMessageId,
      idempotencyKey: email.idempotencyKey,
      actionId: email.actionId,
      from: email.from.address,
      to: email.to.map((to) => to.address),
      subject: email.subject,
      headers: email.headers,
      at: ctx.now(),
    };
    this.deliveries.push(delivery);
    return delivery;
  }

  /** Simulate the recipient replying in thread. */
  reply(
    to: FakeDelivery,
    options: { from?: string; snippet?: string; subject?: string; headers?: Record<string, string>; at?: number } = {},
  ): InboundMailEvent {
    return this.pushInbound({
      kind: 'message',
      providerThreadId: to.providerThreadId,
      inReplyTo: to.rfcMessageId,
      references: [to.rfcMessageId],
      from: options.from ?? to.to[0] ?? 'unknown@example.com',
      to: [to.from],
      subject: options.subject ?? `Re: ${to.subject}`,
      headers: options.headers ?? {},
      snippet: options.snippet ?? 'Thanks, happy to talk next week.',
      at: options.at,
    });
  }

  /** Simulate a delivery status notification for a previous delivery. */
  bounce(to: FakeDelivery, status: string, at?: number): InboundMailEvent {
    return this.pushInbound({
      kind: 'bounce',
      references: [to.rfcMessageId],
      from: 'mailer-daemon@example.net',
      to: [to.from],
      subject: 'Delivery Status Notification (Failure)',
      headers: {},
      contentType: 'multipart/report; report-type=delivery-status',
      dsn: { status, recipient: to.to[0], originalMessageId: to.rfcMessageId },
      at,
    });
  }

  complaint(to: FakeDelivery, at?: number): InboundMailEvent {
    return this.pushInbound({
      kind: 'complaint',
      references: [to.rfcMessageId],
      from: to.to[0] ?? 'unknown@example.com',
      to: [to.from],
      headers: {},
      at,
    });
  }

  /** Any inbound message, e.g. an unrelated email or an out-of-office. */
  pushInbound(input: Omit<InboundMailEvent, 'eventId' | 'providerMessageId' | 'receivedAt'> & { at?: number | undefined }): InboundMailEvent {
    this.counter += 1;
    const { at, ...rest } = input;
    const event: InboundMailEvent = {
      ...rest,
      eventId: `fake-evt-${this.instance}-${this.counter}`,
      providerMessageId: `fake-in-${this.instance}-${this.counter}`,
      rfcMessageId: rest.rfcMessageId ?? `<fake-in-${this.instance}-${this.counter}@example.net>`,
      receivedAt: at ?? Date.now(),
    };
    this.inbound.push(event);
    return event;
  }

  /** Build a signed webhook request carrying the given events. */
  signWebhook(events: readonly InboundMailEvent[], timestamp: number): { rawBody: Uint8Array; headers: Record<string, string> } {
    const body = JSON.stringify({ events });
    return {
      rawBody: new TextEncoder().encode(body),
      headers: {
        'x-fake-timestamp': String(timestamp),
        'x-fake-signature': hmacSha256Hex(this.webhookSecret, `${timestamp}.${body}`),
      },
    };
  }

  private async verifyWebhook(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string>>,
    secret: string,
    now: number,
  ): Promise<readonly InboundMailEvent[] | 'reject'> {
    if (rawBody.byteLength > 1_000_000) return 'reject';
    const timestamp = Number(headers['x-fake-timestamp']);
    const signature = headers['x-fake-signature'] ?? '';
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_MS) return 'reject';
    const body = new TextDecoder().decode(rawBody);
    if (!safeEqualHex(hmacSha256Hex(secret, `${timestamp}.${body}`), signature)) return 'reject';
    const parsed = JSON.parse(body) as { events?: InboundMailEvent[] };
    return parsed.events ?? [];
  }
}

function toReceipt(delivery: FakeDelivery): ProviderReceipt {
  return {
    providerMessageId: delivery.providerMessageId,
    providerThreadId: delivery.providerThreadId,
    rfcMessageId: delivery.rfcMessageId,
    acceptedAt: delivery.at,
  };
}
