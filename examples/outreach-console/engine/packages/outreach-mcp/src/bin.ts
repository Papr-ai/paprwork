#!/usr/bin/env node
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ulid } from '@splitin/outreach-contracts';
import { authenticate, createEngine } from '@splitin/outreach-core';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { serveStdio } from './index';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { db: { type: 'string' }, workspace: { type: 'string', default: 'default' } }, strict: true });
  if (!values.db) throw new Error('--db is required; initialize the database through outreach CLI first');
  const db = openSqliteDatabase(resolve(values.db));
  try {
    // A control surface never loads executable configs, provider credentials or provider adapters.
    const engine = createEngine({ db, adapters: [], secrets: { get: async () => { throw new Error('MCP cannot resolve secrets'); } }, workerId: `mcp-${process.pid}` });
    const authenticateLocal = () => authenticate(db, values.workspace ?? 'default', `cli:${userInfo().username}`, 'mcp', ulid());
    authenticateLocal(); // Refuse unknown users before accepting protocol traffic.
    const server = await serveStdio({ engine, authenticate: authenticateLocal });
    server.server.onclose = () => db.close();
    const close = () => { void server.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    db.close();
    throw error;
  }
}
void main().catch(() => { process.stderr.write('outreach-mcp failed: check database, local principal and configuration.\n'); process.exitCode = 1; });
