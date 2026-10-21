import type { AccountHealth, Notification, ProviderAdapter, SendResult } from '@splitin/outreach-contracts';
import type { FakeSendMode } from './fake-email';

export interface FakePublished extends Notification {
  readonly idempotencyKey: string;
  readonly at: number;
}

/** In-memory notification channel (stands in for Slack in tests). */
export class FakeNotifier {
  readonly name: string;
  readonly published: FakePublished[] = [];
  healthStatus: AccountHealth = 'ok';
  private readonly queue: FakeSendMode[] = [];

  constructor(name = 'fake-notify') {
    this.name = name;
  }

  script(...modes: FakeSendMode[]): this {
    this.queue.push(...modes);
    return this;
  }

  adapter(): ProviderAdapter {
    return {
      name: this.name,
      purposes: ['transactional'],
      account: {
        discover: async (ctx) => ({
          provider: this.name,
          send: true,
          replyInThread: false,
          customHeaders: false,
          externalIdempotency: false,
          inboundWebhook: false,
          mailboxPolling: false,
          reconcileBySentSearch: false,
          maxRecipientsPerMessage: 1,
          discoveredAt: ctx.now(),
        }),
        health: async () => ({ status: this.healthStatus }),
      },
      notify: {
        publish: async (ctx, notification): Promise<SendResult> => {
          const mode = this.queue.shift() ?? { kind: 'accept' };
          const record = (): FakePublished => {
            const published = { ...notification, at: ctx.now() };
            this.published.push(published);
            return published;
          };
          switch (mode.kind) {
            case 'accept':
              record();
              return {
                kind: 'accepted',
                receipt: { providerMessageId: `fake-note-${this.published.length}`, acceptedAt: ctx.now() },
              };
            case 'reject':
              return { kind: 'rejected', errorClass: mode.errorClass, detail: 'fake notify rejection' };
            case 'unknown_after_accept':
            case 'throw_after_accept':
              record();
              return { kind: 'unknown', detail: 'fake notify timeout' };
            case 'unknown_before_accept':
              return { kind: 'unknown', detail: 'fake notify timeout' };
          }
        },
      },
    };
  }
}
