import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import type { ServerEnv } from './app';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export class PublicBindRefusedError extends Error {
  constructor(host: string) {
    super(`Refusing to listen on ${host}: pass allowPublic (CLI: --public) and put TLS termination in front of it`);
    this.name = 'PublicBindRefusedError';
  }
}

/** Starts the server. Loopback only unless explicitly allowed (BUILD_PLAN.md §11.2, §12). */
export function startServer(app: Hono<ServerEnv>, options: { host?: string; port: number; allowPublic?: boolean }): Promise<{ server: ServerType; url: string }> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && !options.allowPublic) throw new PublicBindRefusedError(host);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: host, port: options.port }, (info) => {
      resolve({ server, url: `http://${host.includes(':') ? `[${host}]` : host}:${info.port}` });
    });
  });
}
