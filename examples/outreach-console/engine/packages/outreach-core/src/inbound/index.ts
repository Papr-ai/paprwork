export { classifyInbound, type InboundClass } from './classify';
export { correlateInbound, type Correlation } from './correlate';
export { storeInboundEvents, ingestWebhook, pollMailbox, pollDueMailboxes, type WebhookResult } from './ingest';
export { processInboundEvents, type ProcessReport } from './process';
export { handleUnsubscribe, type UnsubscribeResult } from './unsubscribe';
