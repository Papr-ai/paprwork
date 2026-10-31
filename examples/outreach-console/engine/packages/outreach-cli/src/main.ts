import { maintenanceCommands } from './commands/maintenance';
import { parseArgs } from 'node:util';
import { campaignCommands } from './commands/campaigns';
import { connectCommands } from './commands/connect';
import { contentCommands } from './commands/content';
import { runtimeCommands } from './commands/serve';
import { setupCommands } from './commands/setup';
import type { Command, Flags } from './commands/types';
import { createOutput } from './output';
import { UsageError, openRuntime, type GlobalOptions, type Runtime } from './runtime';

export const COMMANDS: readonly Command[] = [...setupCommands, ...connectCommands, ...contentCommands, ...campaignCommands, ...runtimeCommands, ...maintenanceCommands];

const GLOBAL_FLAGS = {
  db: { type: 'string' },
  workspace: { type: 'string' },
  config: { type: 'string' },
  fake: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function help(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'outreach: provider-neutral outreach engine CLI',
    '',
    'Global options: --db <file> (OUTREACH_DB, default ./outreach.db)  --workspace <id> (OUTREACH_WORKSPACE, default "default")',
    '                --config <file> (default ./outreach.config.mjs)  --fake (fake providers, sends nothing)  --json',
    '',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Run `outreach <command> --help` for its usage.',
  ].join('\n');
}

function findCommand(positionals: readonly string[]): { command: Command; args: string[] } | null {
  for (const words of [3, 2, 1]) {
    const name = positionals.slice(0, words).join(' ');
    const command = COMMANDS.find((c) => c.name === name);
    if (command) return { command, args: positionals.slice(words) };
  }
  return null;
}

export interface MainIo {
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  /** Stands in for the user's browser in tests of sign-in flows. By default URLs are only printed. */
  readonly openUrl?: (url: string) => void;
}

/** Runs one CLI invocation. Returns the exit code: 0 ok, 1 error, 2 usage. */
export async function main(argv: readonly string[], io: MainIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const writeError = io.writeError ?? ((text: string) => process.stderr.write(text));
  const allFlags: Record<string, { type: 'string' | 'boolean'; short?: string }> = { ...GLOBAL_FLAGS };
  for (const command of COMMANDS) for (const [name, type] of Object.entries(command.flags ?? {})) allFlags[name] = { type };
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: allFlags, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (error) {
    writeError(`${(error as Error).message}\n\n${help()}\n`);
    return 2;
  }
  const found = findCommand(parsed.positionals);
  if (!found) {
    (parsed.values.help || parsed.positionals.length === 0 ? (io.write ?? ((t: string) => process.stdout.write(t))) : writeError)(`${help()}\n`);
    return parsed.values.help || parsed.positionals.length === 0 ? 0 : 2;
  }
  const { command, args } = found;
  if (parsed.values.help) {
    (io.write ?? ((t: string) => process.stdout.write(t)))(`${command.usage}\n\n${command.summary}\n`);
    return 0;
  }
  const unknown = Object.keys(parsed.values).filter((name) => parsed.values[name] !== undefined && !(name in GLOBAL_FLAGS) && !(name in (command.flags ?? {})));
  if (unknown.length) {
    writeError(`unknown option${unknown.length > 1 ? 's' : ''} for "${command.name}": ${unknown.map((n) => `--${n}`).join(', ')}\n\nusage: ${command.usage}\n`);
    return 2;
  }
  const options: GlobalOptions = {
    db: (parsed.values.db as string | undefined) ?? env.OUTREACH_DB ?? 'outreach.db',
    workspace: (parsed.values.workspace as string | undefined) ?? env.OUTREACH_WORKSPACE ?? 'default',
    ...((parsed.values.config as string | undefined) ? { config: parsed.values.config as string } : {}),
    fake: parsed.values.fake === true,
    json: parsed.values.json === true,
  };
  const out = createOutput(options.json, io.write);
  let runtime: Runtime | undefined;
  try {
    const code = await command.run({
      args,
      flags: parsed.values as Flags,
      out,
      options,
      env,
      notice: (text) => writeError(`${text}\n`),
      ...(io.openUrl ? { openUrl: io.openUrl } : {}),
      runtime: async () => (runtime ??= await openRuntime(options, env)),
    });
    return code ?? 0;
  } catch (error) {
    const err = error as Error & { issues?: readonly string[] };
    writeError(`error: ${err.message}${err.issues ? `\n- ${err.issues.join('\n- ')}` : ''}\n`);
    if (error instanceof UsageError) writeError(`usage: ${command.usage}\n`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    runtime?.close();
  }
}
