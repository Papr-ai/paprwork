import {
  listManualTasks,
  listUpcoming,
  listReview,
  recordManualOutcome,
  resolveReview,
  setEnrollmentState,
  setKillSwitchAs,
  type Engine,
} from '@splitin/outreach-core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';

const resolution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sent'), providerMessageId: z.string().min(1).max(500), providerThreadId: z.string().max(500).optional() }).strict(),
  z.object({ kind: z.literal('not_sent_retry') }).strict(),
  z.object({ kind: z.literal('drop'), reason: z.string().min(1).max(500) }).strict(),
]);

export function registerOperationRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/actions/upcoming', (c) => {
    const hours = z.coerce.number().int().min(1).max(168).default(24).parse(c.req.query('hours') ?? undefined);
    return c.json({ actions: listUpcoming(engine, auth(c), hours) });
  });

  app.get('/v1/tasks', (c) => {
    const status = z.enum(['open', 'done', 'skipped', 'expired']).default('open').parse(c.req.query('status'));
    return c.json({ tasks: listManualTasks(engine, auth(c), status) });
  });

  app.post('/v1/tasks/:id/outcome', async (c) => {
    const body = z.object({ outcome: z.enum(['done', 'skipped']), note: z.string().max(1000).optional() }).strict().parse(await c.req.json());
    recordManualOutcome(engine, auth(c), c.req.param('id'), body.outcome, body.note);
    return c.json({ status: body.outcome });
  });

  app.get('/v1/review', (c) => c.json({ actions: listReview(engine, auth(c)).map(({ payload: _payload, ...row }) => row) }));

  app.post('/v1/review/:id/resolve', async (c) => {
    resolveReview(engine, auth(c), c.req.param('id'), resolution.parse(await c.req.json()));
    return c.json({ resolved: true });
  });

  app.post('/v1/enrollments/:id/:change', async (c) => {
    const change = z.enum(['pause', 'resume', 'stop']).parse(c.req.param('change'));
    const body = z.object({ reason: z.string().min(1).max(500) }).strict().parse(await c.req.json());
    setEnrollmentState(engine, auth(c), c.req.param('id'), change, body.reason);
    return c.json({ change });
  });

  app.post('/v1/kill-switches', async (c) => {
    const body = z
      .object({ scope: z.enum(['global', 'workspace', 'provider_account', 'campaign']), targetId: z.string().min(1).optional(), engaged: z.boolean(), reason: z.string().min(1).max(500) })
      .strict()
      .parse(await c.req.json());
    setKillSwitchAs(engine, auth(c), { scope: body.scope, engaged: body.engaged, reason: body.reason, ...(body.targetId ? { targetId: body.targetId } : {}) });
    return c.json({ scope: body.scope, engaged: body.engaged });
  });
}
