import { escapeHtml, handleUnsubscribe, ingestWebhook, type Engine } from '@splitin/outreach-core';
import type { Hono } from 'hono';
import type { ServerEnv } from './app';

const MAX_WEBHOOK_BYTES = 1_000_000;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#1f2328}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #1f2328;background:#1f2328;color:#fff;cursor:pointer}</style>
</head><body>${body}</body></html>`;

/** Routes that do not use bearer tokens: health, provider webhooks (signature) and unsubscribe (HMAC token). */
export function registerPublicRoutes(app: Hono<ServerEnv>, engine: Engine): void {
  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/v1/webhooks/:accountId', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_WEBHOOK_BYTES) return c.json({ accepted: false, reason: 'too_large' }, 413);
    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const result = await ingestWebhook(engine, { providerAccountId: c.req.param('accountId'), rawBody, headers });
    if (result.accepted) return c.json(result);
    const status = result.reason === 'too_large' ? 413 : result.reason === 'not_configured' ? 404 : 401;
    return c.json(result, status);
  });

  // Mail clients and scanners prefetch GET links, so GET only shows a confirmation form (RFC 8058).
  app.get('/u/:token', (c) =>
    c.html(page('Unsubscribe', `<h1>Unsubscribe</h1><p>Stop receiving these emails?</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`)),
  );

  // One-click POST from the mail client (List-Unsubscribe-Post) or the form above.
  app.post('/u/:token', (c) => {
    const result = handleUnsubscribe(engine, c.req.param('token'));
    if (!result.ok) {
      return c.html(page('Link not valid', '<h1>This link is not valid</h1><p>Reply to the email and ask us to stop, and we will.</p>'), result.reason === 'not_configured' ? 404 : 400);
    }
    return c.html(page('Unsubscribed', '<h1>You are unsubscribed</h1><p>You will not receive further emails from us.</p>'));
  });
}
