import { runDueBackup } from '@splitin/outreach-store-sqlite';
import { requireRole } from '@splitin/outreach-core';
import { backupConfiguration } from './maintenance';
import { createApp, startServer } from '@splitin/outreach-server';
import { flag, type Command } from './types';

function parseInterval(value: string | undefined): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value ?? '60s');
  if (!match) throw new Error('--interval must look like 500ms, 30s or 2m');
  const amount = Number(match[1]);
  return match[2] === 'ms' ? amount : match[2] === 'm' ? amount * 60_000 : amount * 1_000;
}

export const runtimeCommands: Command[] = [
  {
    name: 'worker',
    usage: 'outreach worker [--once | --loop [--interval 60s]] [--backup-dir <dir> --backup-every-hours 24]',
    summary: 'Poll mailboxes, apply inbound events, reconcile and send due actions. Safe to run concurrently.',
    flags: { once: 'boolean', loop: 'boolean', interval: 'string', 'backup-dir': 'string', 'backup-every-hours': 'string' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      const backup = backupConfiguration(flags, rt);
      const maintenance = async () => { if (backup) { requireRole(rt.ctx(), 'admin'); await runDueBackup(rt.db, backup); } };
      if (!flags.loop) {
        await maintenance();
        const report = await rt.engine.runOnce();
        out.result(report);
        return;
      }
      const interval = parseInterval(flag(flags, 'interval'));
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      out.line(`worker ${rt.engine.exec.workerId} running every ${interval} ms; Ctrl+C finishes the current pass and exits`);
      while (!stopping) {
        await maintenance();
        const report = await rt.engine.runOnce();
        if (report.execute.claimed || report.inbound.processed || report.reconcile.found + report.reconcile.absent) out.result({ at: new Date().toISOString(), ...report });
        const until = Date.now() + interval;
        while (!stopping && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
      }
    },
  },
  {
    name: 'serve',
    usage: 'outreach serve [--port 8787] [--host 127.0.0.1] [--public]',
    summary: 'Run the HTTP API, webhook ingress and unsubscribe endpoint (loopback unless --public).',
    flags: { port: 'string', host: 'string', public: 'boolean' },
    async run({ flags, out, runtime }) {
      const rt = await runtime();
      const host = flag(flags, 'host');
      const { url, server } = await startServer(createApp({ engine: rt.engine }), { port: Number(flag(flags, 'port') ?? 8787), ...(host ? { host } : {}), allowPublic: flags.public === true });
      out.line(`outreach API listening on ${url}`);
      await new Promise<void>((resolve) => {
        const close = () => server.close(() => resolve());
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
      });
    },
  },
];
