import { ulid } from '@splitin/outreach-contracts';
import { authenticateToken, type AuthContext, type Engine } from '@splitin/outreach-core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { toApiError } from './errors';
import { registerCampaignRoutes } from './routes-campaigns';
import { registerOperationRoutes } from './routes-operations';
import { registerPublicRoutes } from './routes-public';

export interface ServerEnv {
  Variables: { auth: AuthContext; traceId: string };
}

export type ServerContext = Context<ServerEnv>;

export interface ServerOptions {
  readonly engine: Engine;
  /** JSON bodies; imports have their own larger limit. */
  readonly maxJsonBytes?: number;
  readonly maxImportBytes?: number;
}

export function auth(c: ServerContext): AuthContext {
  return c.get('auth');
}

/**
 * The HTTP surface (BUILD_PLAN.md §11.2). Thin by design: every route authenticates, parses with zod and
 * calls one application service. Business rules live in @splitin/outreach-core only.
 */
export function createApp(options: ServerOptions): Hono<ServerEnv> {
  const { engine } = options;
  const app = new Hono<ServerEnv>();

  app.use('*', async (c, next) => {
    const traceId = ulid();
    c.set('traceId', traceId);
    await next();
    c.header('x-trace-id', traceId);
    c.header('x-content-type-options', 'nosniff');
    c.header('cache-control', 'no-store');
  });

  app.onError((error, c) => {
    const apiError = toApiError(error);
    if (apiError.status === 500) console.error(`[outreach-server] ${c.get('traceId')}`, error);
    return c.json({ error: apiError.code, message: apiError.message, ...(apiError.issues ? { issues: apiError.issues } : {}), traceId: c.get('traceId') }, apiError.status);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: 'no such route', traceId: c.get('traceId') }, 404));

  registerPublicRoutes(app, engine);

  app.use('/v1/*', async (c, next) => {
    // Provider webhooks authenticate by signature, not by bearer token.
    if (c.req.path.startsWith('/v1/webhooks/')) return next();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    c.set('auth', engine.db.transaction(() => authenticateToken(engine.db, token, 'http', c.get('traceId'), engine.now())));
    return next();
  });
  app.use('/v1/imports/preview', bodyLimit({ maxSize: options.maxImportBytes ?? 25 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/imports/preview' || c.req.path.startsWith('/v1/webhooks/')) return next();
    return bodyLimit({ maxSize: options.maxJsonBytes ?? 256 * 1024, onError: (ctx) => ctx.json({ error: 'too_large' }, 413) })(c, next);
  });

  app.get('/v1/me', (c) => {
    const ctx = auth(c);
    return c.json({ workspaceId: ctx.workspaceId, principalId: ctx.principalId, roles: ctx.roles });
  });
  registerCampaignRoutes(app, engine);
  registerOperationRoutes(app, engine);
  return app;
}
