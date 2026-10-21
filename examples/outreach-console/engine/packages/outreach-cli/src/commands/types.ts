import type { Output } from '../output';
import type { GlobalOptions, Runtime } from '../runtime';

export type Flags = Readonly<Record<string, string | boolean | undefined>>;

export interface CommandInput {
  readonly args: readonly string[];
  readonly flags: Flags;
  readonly out: Output;
  readonly options: GlobalOptions;
  /** The environment of this invocation (never read process.env directly). */
  readonly env: NodeJS.ProcessEnv;
  /** Human-facing progress on stderr, shown even with --json (e.g. a sign-in URL). */
  notice(text: string): void;
  readonly openUrl?: (url: string) => void;
  /** Opens the database and engine lazily (some commands, like `init`, prepare it themselves). */
  runtime(): Promise<Runtime>;
}

export interface Command {
  /** e.g. "campaign create". */
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  /** Flag name -> type. Unknown flags are usage errors. */
  readonly flags?: Readonly<Record<string, 'string' | 'boolean'>>;
  /** Returns a non-zero exit code for a completed-but-failed check (e.g. a broken audit chain). */
  run(input: CommandInput): Promise<number | void>;
}

export function flag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function required(flags: Flags, name: string): string {
  const value = flag(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function arg(args: readonly string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`<${name}> is required`);
  return value;
}
