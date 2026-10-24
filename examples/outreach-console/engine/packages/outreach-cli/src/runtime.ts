import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ulid, type ManualTaskProvider, type ProviderAdapter, type SecretResolver, type SqlDatabase } from '@splitin/outreach-contracts';
import { authenticate, createEngine, type AuthContext, type Engine } from '@splitin/outreach-core';
import { FAKE_EMAIL_SECRET, FakeEmailProvider, FakeNotifier } from '@splitin/outreach-fakes';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';

/** What an `outreach.config.mjs` default-exports: the host's adapters and optional manual-task hook. */
export interface OutreachConfig {
  readonly adapters: readonly ProviderAdapter[] | (() => readonly ProviderAdapter[] | Promise<readonly ProviderAdapter[]>);
  readonly manual?: ManualTaskProvider;
}

export interface GlobalOptions {
  readonly db: string;
  readonly workspace: string;
  readonly config?: string;
  /** Use in-memory fake providers (dry runs, demos, the soak test). Never sends anything. */
  readonly fake: boolean;
  readonly json: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return path === '~' || path.startsWith('~/') ? `${env.HOME ?? homedir()}${path.slice(1)}` : path;
}

/**
 * Secrets are read at call time from the environment ("env:NAME") or from a file only its owner can read
 * ("file:PATH", e.g. an OAuth grant written by `outreach account connect gmail`). The database stores the
 * reference, never the value.
 */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return {
    async get(ref) {
      if (ref.startsWith('env:')) {
        const value = env[ref.slice(4)];
        if (value === undefined || value === '') throw new Error(`secret ${ref} is not set in the environment`);
        return value;
      }
      if (ref.startsWith('file:')) {
        const path = resolve(expandHome(ref.slice(5), env));
        if (!existsSync(path)) throw new Error(`secret file ${path} does not exist`);
        if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
          throw new Error(`secret file ${path} is readable by other users; run chmod 600 on it`);
        }
        return readFileSync(path, 'utf8').trim();
      }
      throw new Error(`secret reference ${ref} is not supported by the CLI; use env:NAME or file:PATH`);
    },
    // Only file: secrets can be rewritten (rotated OAuth refresh tokens); the write is atomic and owner-only.
    async put(ref, value) {
      if (!ref.startsWith('file:')) throw new Error(`secret ${ref} cannot be updated; store it as file:PATH to keep rotated tokens`);
      const path = resolve(expandHome(ref.slice(5), env));
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${value}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

function fakeSecrets(): SecretResolver {
  return { get: async (ref) => (ref.startsWith('env:') || ref.startsWith('keychain:') ? FAKE_EMAIL_SECRET : Promise.reject(new Error(`bad ref ${ref}`))) };
}

export function principalRef(env: NodeJS.ProcessEnv = process.env): string {
  return env.OUTREACH_PRINCIPAL ?? `cli:${userInfo().username}`;
}

async function loadConfig(options: GlobalOptions): Promise<{ adapters: readonly ProviderAdapter[]; manual?: ManualTaskProvider }> {
  if (options.fake) return { adapters: [new FakeEmailProvider().adapter(), new FakeNotifier().adapter()] };
  const path = resolve(options.config ?? 'outreach.config.mjs');
  if (!existsSync(path)) {
    if (options.config) throw new UsageError(`config file ${path} not found`);
    return { adapters: [] };
  }
  const module = (await import(pathToFileURL(path).href)) as { default?: OutreachConfig };
  if (!module.default?.adapters) throw new UsageError(`${path} must default-export { adapters }`);
  const adapters = typeof module.default.adapters === 'function' ? await module.default.adapters() : module.default.adapters;
  return { adapters, ...(module.default.manual ? { manual: module.default.manual } : {}) };
}

export interface Runtime {
  readonly options: GlobalOptions;
  readonly db: SqlDatabase;
  readonly engine: Engine;
  /** The caller as a principal; throws if `outreach init` has not registered them. */
  ctx(): AuthContext;
  close(): void;
}

export async function openRuntime(options: GlobalOptions, env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const db = openSqliteDatabase(resolve(options.db));
  try {
    const { adapters, manual } = await loadConfig(options);
    const baseUrl = env.OUTREACH_PUBLIC_URL;
    const secret = env.OUTREACH_UNSUBSCRIBE_SECRET;
    const engine = createEngine({
      db,
      adapters,
      secrets: options.fake ? fakeSecrets() : envSecrets(env),
      workerId: `cli-${process.pid}-${ulid().slice(-6)}`,
      ...(baseUrl && secret ? { unsubscribe: { baseUrl: `${baseUrl.replace(/\/+$/, '')}/u/`, secret } } : {}),
      ...(manual ? { manual } : {}),
    });
    return {
      options,
      db,
      engine,
      ctx: () => authenticate(db, options.workspace, principalRef(env), 'cli', ulid()),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
