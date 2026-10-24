import { resolve } from 'node:path';
import { commitRetention, prepareRetention, requireRole } from '@splitin/outreach-core';
import { runDueBackup } from '@splitin/outreach-store-sqlite';
import type { Runtime } from '../runtime';
import { arg, flag, required, type Command, type Flags } from './types';

function hours(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 8760) throw new Error('Backup cadence must be explicit whole hours from 1 to 8760');
  return number * 3_600_000;
}
/** Optional worker integration; absence of both flags means no maintenance writes. */
export function backupConfiguration(flags: Flags, rt: Runtime) {
  const directory = flag(flags, 'backup-dir'); const every = flag(flags, 'backup-every-hours');
  if (!directory && !every) return undefined;
  if (!directory || !every) throw new Error('--backup-dir and --backup-every-hours must be configured together');
  requireRole(rt.ctx(), 'admin');
  return { directory: resolve(directory), intervalMs: hours(every), sourceDatabasePath: resolve(rt.options.db) };
}
export const maintenanceCommands: Command[] = [
  {
    name: 'backup', usage: 'outreach backup --backup-dir <private-directory> --backup-every-hours 24 [--dry-run]',
    summary: 'Opt-in consistent SQLite snapshot. Never overwrites or deletes previous backups.',
    flags: { 'backup-dir': 'string', 'backup-every-hours': 'string', 'dry-run': 'boolean' },
    async run({ flags, runtime, out }) {
      const rt = await runtime(); const config = backupConfiguration(flags, rt);
      if (!config) throw new Error('Explicit backup directory and cadence required');
      if (flags['dry-run']) { out.result({ dryRun: true, configuration: config, note: 'No backup or destination files created; the existing database is opened normally.' }); return; }
      out.result(await runDueBackup(rt.db, config));
    },
  },
  {
    name: 'retention preview', usage: 'outreach retention preview --days <explicit-days> [--limit 100] [--after <contact-id>]',
    summary: 'Preview conservative opt-out pruning; no contact records changed. Admin only.',
    flags: { days: 'string', limit: 'string', after: 'string' },
    async run({ flags, runtime, out }) {
      const rt = await runtime();
      out.result(prepareRetention(rt.engine, rt.ctx(), { days: Number(required(flags, 'days')), ...(flag(flags, 'limit') ? { limit: Number(flag(flags, 'limit')) } : {}), ...(flag(flags, 'after') ? { afterId: flag(flags, 'after')! } : {}) }));
    },
  },
  {
    name: 'retention commit', usage: 'outreach retention commit <preview-id> --confirm-hash <exact-preview-hash> --acknowledge-exclusions',
    summary: 'Permanently prune only an unchanged reviewed preview. Audit/backups and documented exclusions remain.',
    flags: { 'confirm-hash': 'string', 'acknowledge-exclusions': 'boolean' },
    async run({ args, flags, runtime, out }) {
      if (flags['acknowledge-exclusions'] !== true) throw new Error('Review the exclusions and backup/restore implications before confirming retention');
      const rt = await runtime();
      out.result(commitRetention(rt.engine, rt.ctx(), arg(args, 0, 'preview-id'), required(flags, 'confirm-hash')));
    },
  },
];
