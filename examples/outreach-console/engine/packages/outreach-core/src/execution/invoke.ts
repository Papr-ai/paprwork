import type {
  ApprovedEmail,
  EmailContent,
  Notification,
  ProviderAdapter,
  ProviderContext,
  SenderIdentity,
  SendResult,
} from '@splitin/outreach-contracts';
import type { AccountRow, ActionRow, ExecutionDeps } from './types';
import { resolveConfig } from './types';

export type EmailPayload = EmailContent;
export type NotifyPayload = Notification;
export interface ManualPayload {
  readonly channel: string;
  readonly targetUrl?: string;
  readonly draft: string;
}

export function providerContext(
  deps: ExecutionDeps,
  account: AccountRow,
  traceId: string,
  signal: AbortSignal,
): ProviderContext {
  return {
    workspaceId: account.workspace_id,
    account: {
      id: account.id,
      provider: account.provider,
      externalAccountId: account.external_account_id,
      sender: JSON.parse(account.sender_identity) as SenderIdentity,
    },
    secretRef: account.secret_ref,
    secrets: deps.secrets,
    traceId,
    signal,
    now: deps.now,
  };
}

export function toApprovedEmail(action: ActionRow): ApprovedEmail {
  const payload = JSON.parse(action.payload) as EmailPayload;
  return {
    ...payload,
    actionId: action.id,
    idempotencyKey: action.idempotency_key,
    rfcMessageId: action.rfc_message_id ?? `<${action.id}@outreach.invalid>`,
    contentHash: action.content_hash,
  };
}

/**
 * Performs the external effect for an `executing` action. Anything thrown by an adapter is treated as
 * `unknown`: we cannot prove the request never left the process, so it must be reconciled, not retried.
 */
export async function invokeProvider(
  deps: ExecutionDeps,
  action: ActionRow,
  account: AccountRow | null,
  adapter: ProviderAdapter | null,
  traceId: string,
): Promise<SendResult> {
  if (action.kind === 'manual.task') {
    return { kind: 'accepted', receipt: { providerMessageId: `manual:${action.id}`, acceptedAt: deps.now() } };
  }
  if (!account || !adapter) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no adapter' };
  const signal = AbortSignal.timeout(resolveConfig(deps).providerTimeoutMs);
  const ctx = providerContext(deps, account, traceId, signal);
  try {
    if (action.kind === 'notify.publish') {
      if (!adapter.notify) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no notify port' };
      const payload = JSON.parse(action.payload) as NotifyPayload;
      return await adapter.notify.publish(ctx, { ...payload, idempotencyKey: action.idempotency_key });
    }
    if (!adapter.email) return { kind: 'rejected', errorClass: 'unsupported', detail: 'no email port' };
    return await adapter.email.send(ctx, toApprovedEmail(action));
  } catch (error) {
    return { kind: 'unknown', detail: `adapter threw: ${(error as Error).message}`.slice(0, 300) };
  }
}
