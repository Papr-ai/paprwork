#!/usr/bin/env node
// Real subprocess stdio smoke; synthetic temporary database, no providers or network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bootstrapWorkspace } from '@splitin/outreach-core';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
const directory = mkdtempSync(join(tmpdir(), 'outreach-mcp-smoke-'));
const dbPath = join(directory, 'test.db');
const db = openSqliteDatabase(dbPath);
bootstrapWorkspace(db, { workspaceId: 'default', name: 'Synthetic smoke', adminRef: `cli:${userInfo().username}`, adminName: 'Smoke' });
db.close();
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../packages/outreach-mcp/dist/bin.js', import.meta.url)), '--db', dbPath], stderr: 'pipe' });
const client = new Client({ name: 'outreach-smoke', version: '1' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (tools.length !== 10) throw new Error('Expected exactly ten tools');
  const result = await client.callTool({ name: 'outreach_status', arguments: {} });
  if (result.isError || !JSON.stringify(result).includes('untrusted_data')) throw new Error('Status failed');
  console.log('Real stdio subprocess handshake, ten-tool allowlist and status passed. Not a Claude Code acceptance test.');
} finally {
  await client.close();
  await transport.close();
  rmSync(directory, { recursive: true, force: true });
}
