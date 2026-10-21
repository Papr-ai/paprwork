import type { SqlDatabase } from '@splitin/outreach-contracts';
import {
  FAKE_EMAIL_SECRET,
  FakeEmailProvider,
  FakeNotifier,
  staticSecrets,
} from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { workerActor } from './actions-repo';
import { enqueueAction, type EnqueueInput } from './enqueue';
import type { ActionRow, ExecutionDeps } from './types';

export const T0 = 1_700_000_000_000;
export const WS = 'ws';
export const EMAIL_ACCOUNT = 'acct-email';
export const NOTIFY_ACCOUNT = 'acct-notify';

export function seedWorkspace(db: SqlDatabase, purposes: string[] = ['automated_outreach']): void {
  db.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Test', 0)`).run(WS);
  const insertAccount = db.prepare(
    `INSERT INTO provider_accounts (id, workspace_id, provider, external_account_id, sender_identity, purposes, secret_ref,
       webhook_secret_ref) VALUES (?,?,?,?,?,?,?,?)`,
  );
  insertAccount.run(
    EMAIL_ACCOUNT,
    WS,
    'fake-email',
    'ext-email',
    JSON.stringify({ name: 'Sam Sender', address: 'sender@example.com', organization: 'Example Co', postalAddress: '1 Example St' }),
    JSON.stringify(purposes),
    'env:FAKE_EMAIL',
    'env:FAKE_WEBHOOK',
  );
  insertAccount.run(NOTIFY_ACCOUNT, WS, 'fake-notify', 'ext-notify', JSON.stringify({ name: 'Ops', address: 'ops@example.com' }), '["transactional"]', 'env:FAKE_EMAIL', null);
}

export interface TestEnv {
  readonly db: SqlDatabase;
  readonly fake: FakeEmailProvider;
  readonly notifier: FakeNotifier;
  readonly deps: ExecutionDeps;
  now(): number;
  advance(ms: number): void;
  with(overrides: Partial<ExecutionDeps>): ExecutionDeps;
  enqueueEmail(key: string, overrides?: Partial<EnqueueInput>): ActionRow;
  action(id: string): ActionRow;
}

export function makeEnv(options: { db?: SqlDatabase; seed?: boolean; fake?: FakeEmailProvider } = {}): TestEnv {
  const db = options.db ?? openSqliteDatabase(':memory:');
  if (options.seed ?? true) seedWorkspace(db);
  const fake = options.fake ?? new FakeEmailProvider();
  const notifier = new FakeNotifier();
  let now = T0;
  const deps: ExecutionDeps = {
    db,
    adapters: new Map([
      [fake.name, fake.adapter()],
      [notifier.name, notifier.adapter()],
    ]),
    secrets: staticSecrets({ 'env:FAKE_EMAIL': FAKE_EMAIL_SECRET, 'env:FAKE_WEBHOOK': 'fake-webhook-secret-value' }),
    now: () => now,
    workerId: 'worker-1',
    sendGate: { mode: 'open' },
    config: { reconcileDelayMs: 0 },
    random: () => 0.5,
  };
  const env: TestEnv = {
    db,
    fake,
    notifier,
    deps,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    with: (overrides) => ({ ...deps, ...overrides }),
    enqueueEmail: (key, overrides = {}) =>
      db.transaction(
        () =>
          enqueueAction(
            db,
            {
              workspaceId: WS,
              kind: 'email.send',
              providerAccountId: EMAIL_ACCOUNT,
              purpose: 'automated_outreach',
              recipient: 'lead@example.org',
              idempotencyKey: key,
              dueAt: now,
              senderDomain: 'example.com',
              payload: {
                from: { address: 'sender@example.com', name: 'Sam Sender' },
                to: [{ address: 'lead@example.org' }],
                subject: `Hello ${key}`,
                text: 'Hi there',
                headers: {},
              },
              ...overrides,
            },
            workerActor('test', 'setup'),
            now,
          ).action,
      ),
    action: (id) => {
      const row = db.prepare('SELECT * FROM scheduled_actions WHERE id = ?').get<ActionRow>(id);
      if (!row) throw new Error(`no action ${id}`);
      return row;
    },
  };
  return env;
}

export class SimulatedCrash extends Error {
  constructor(at: string) {
    super(`simulated crash at ${at}`);
    this.name = 'SimulatedCrash';
  }
}

export function attempts(db: SqlDatabase, actionId: string): { outcome: string; error_class: string | null }[] {
  return db
    .prepare('SELECT outcome, error_class FROM action_attempts WHERE action_id = ? ORDER BY attempt_no')
    .all<{ outcome: string; error_class: string | null }>(actionId);
}
