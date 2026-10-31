import {
  campaignStatus,
  commitActivation,
  createCampaign,
  decideApproval,
  listApprovals,
  listCampaigns,
  prepareActivation,
  requireRole,
  requestBatchApproval,
  revokeApproval,
  setCampaignStatus,
  type Engine,
} from '@splitin/outreach-core';
import { commitImport, previewImport } from '@splitin/outreach-import';
import type { Hono } from 'hono';
import { z } from 'zod';
import { auth, type ServerEnv } from './app';

const reason = z.object({ reason: z.string().min(1).max(500) }).strict();

export function registerCampaignRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/v1/campaigns', (c) => c.json({ campaigns: listCampaigns(engine, auth(c)) }));

  app.post('/v1/campaigns', async (c) => {
    const body = z.object({ name: z.string().min(1).max(200), playbook: z.union([z.string().max(100_000), z.record(z.string(), z.unknown())]), providerAccountId: z.string().min(1) }).strict().parse(await c.req.json());
    return c.json(createCampaign(engine, auth(c), body), 201);
  });

  app.get('/v1/campaigns/:id', (c) => c.json(campaignStatus(engine, auth(c), c.req.param('id'))));

  app.post('/v1/campaigns/:id/activation/prepare', (c) => c.json(prepareActivation(engine, auth(c), c.req.param('id'))));

  app.post('/v1/campaigns/:id/activation/commit', async (c) => {
    const body = z.object({ operationHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(await c.req.json());
    return c.json(commitActivation(engine, auth(c), { campaignId: c.req.param('id'), operationHash: body.operationHash }));
  });

  app.post('/v1/campaigns/:id/pause', async (c) => {
    setCampaignStatus(engine, auth(c), c.req.param('id'), 'paused', reason.parse(await c.req.json()).reason);
    return c.json({ status: 'paused' });
  });

  app.post('/v1/campaigns/:id/resume', async (c) => {
    setCampaignStatus(engine, auth(c), c.req.param('id'), 'active', reason.parse(await c.req.json()).reason);
    return c.json({ status: 'active' });
  });

  app.post('/v1/campaigns/:id/approvals/batch', (c) => c.json(requestBatchApproval(engine, auth(c), c.req.param('id')) ?? { approvalId: null, count: 0 }));

  app.get('/v1/approvals', (c) => {
    const decision = z.enum(['pending', 'approved', 'rejected', 'revoked', 'expired']).default('pending').parse(c.req.query('decision'));
    return c.json({ approvals: listApprovals(engine.db, auth(c), decision).map((row) => ({ ...row, preview: JSON.parse(row.preview) as unknown })) });
  });

  app.post('/v1/approvals/:id/decide', async (c) => {
    const body = z.object({ decision: z.enum(['approved', 'rejected']), operationHash: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string().max(500).optional() }).strict().parse(await c.req.json());
    const decided = decideApproval(engine, auth(c), { approvalId: c.req.param('id'), ...body });
    return c.json({ id: decided.id, decision: decided.decision });
  });

  app.post('/v1/approvals/:id/revoke', async (c) => {
    revokeApproval(engine, auth(c), c.req.param('id'), reason.parse(await c.req.json()).reason);
    return c.json({ decision: 'revoked' });
  });

  app.post('/v1/imports/preview', async (c) => {
    const query = z.object({ profileId: z.string().min(1), fileName: z.string().min(1).max(200) }).parse({ profileId: c.req.query('profileId'), fileName: c.req.query('fileName') });
    const ctx = auth(c);
    requireRole(ctx, 'operator');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const preview = await previewImport(engine.db, { workspaceId: ctx.workspaceId, principalId: ctx.principalId, source: 'http', traceId: ctx.traceId }, { ...query, bytes, now: engine.now() });
    return c.json(preview, 201);
  });

  app.post('/v1/imports/:id/commit', async (c) => {
    const body = z.object({ previewHash: z.string().regex(/^[0-9a-f]{64}$/), idempotencyKey: z.string().min(1).max(200) }).strict().parse(await c.req.json());
    const ctx = auth(c);
    requireRole(ctx, 'operator');
    return c.json(commitImport(engine.db, { workspaceId: ctx.workspaceId, principalId: ctx.principalId, source: 'http', traceId: ctx.traceId }, { batchId: c.req.param('id'), ...body, now: engine.now() }));
  });
}
