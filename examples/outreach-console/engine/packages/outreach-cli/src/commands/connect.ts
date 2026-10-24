import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { authorizeGoogle, GMAIL_SCOPES } from '@splitin/outreach-provider-email-gmail';
import { authorizeMicrosoft } from '@splitin/outreach-provider-email-outlook';
import { expandHome, UsageError } from '../runtime';
import { flag, required, type Command, type Flags } from './types';

/** Writes a grant to an owner-only file (0600 in a 0700 directory) and returns its absolute path. */
function saveGrant(flags: Flags, env: NodeJS.ProcessEnv, provider: string, emailAddress: string, grant: unknown): string {
  const path = resolve(expandHome(flag(flags, 'out') ?? `~/.config/outreach/${provider}-${emailAddress}.json`, env));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync keeps the old mode when the file already existed.
  return path;
}

const nextStep = (provider: string, address: string, path: string) =>
  `outreach account add --provider ${provider} --external-id ${address} --sender-email ${address} ` +
  `--sender-name "<your name>" --postal "<postal address>" --purposes <purposes> --secret file:${path}`;

export const connectCommands: readonly Command[] = [
  {
    name: 'account connect gmail',
    usage: 'outreach account connect gmail --client-id <id> --client-secret-env <ENV_NAME> [--login-hint <address>] [--out <path>]',
    summary: 'Sign in to Google and store the Gmail grant in an owner-only file for a file: secret reference.',
    flags: { 'client-id': 'string', 'client-secret-env': 'string', 'login-hint': 'string', out: 'string' },
    async run({ flags, out, env, notice, openUrl }) {
      // The client secret is read from the environment, never from argv (visible to other users in `ps`).
      const secretEnv = required(flags, 'client-secret-env');
      const clientSecret = env[secretEnv];
      if (!clientSecret) throw new UsageError(`environment variable ${secretEnv} is empty; export the OAuth client secret there`);
      const loginHint = flag(flags, 'login-hint');
      const result = await authorizeGoogle({
        clientId: required(flags, 'client-id'),
        clientSecret,
        scopes: GMAIL_SCOPES,
        ...(loginHint ? { loginHint } : {}),
        onUrl: (url) => {
          notice(`Open this URL in a browser on this machine and sign in to the mailbox you will send from:\n\n  ${url}\n\nWaiting for Google...`);
          openUrl?.(url);
        },
        // Endpoint overrides exist for testing against a fake Google; leave them unset in real use.
        ...(env.OUTREACH_GOOGLE_AUTH_URL ? { authUrl: env.OUTREACH_GOOGLE_AUTH_URL } : {}),
        ...(env.OUTREACH_GOOGLE_TOKEN_URL ? { tokenUrl: env.OUTREACH_GOOGLE_TOKEN_URL } : {}),
        ...(env.OUTREACH_GMAIL_API ? { api: env.OUTREACH_GMAIL_API } : {}),
      });
      if (loginHint && loginHint.toLowerCase() !== result.emailAddress) {
        throw new Error(`you signed in as ${result.emailAddress}, not ${loginHint}; nothing was saved`);
      }
      const path = saveGrant(flags, env, 'gmail', result.emailAddress, result.grant);
      out.result({ connected: result.emailAddress, secretRef: `file:${path}`, next: nextStep('gmail', result.emailAddress, path) });
    },
  },
  {
    name: 'account connect outlook',
    usage: 'outreach account connect outlook --tenant <tenant-id|domain> --client-id <id> [--client-secret-env <ENV_NAME>] [--login-hint <address>] [--out <path>]',
    summary: 'Sign in to Microsoft 365 and store the Outlook grant in an owner-only file (rotated tokens are written back).',
    flags: { tenant: 'string', 'client-id': 'string', 'client-secret-env': 'string', 'login-hint': 'string', out: 'string' },
    async run({ flags, out, env, notice, openUrl }) {
      const secretEnv = flag(flags, 'client-secret-env');
      const clientSecret = secretEnv ? env[secretEnv] : undefined;
      if (secretEnv && !clientSecret) throw new UsageError(`environment variable ${secretEnv} is empty`);
      const loginHint = flag(flags, 'login-hint');
      const result = await authorizeMicrosoft({
        tenant: required(flags, 'tenant'),
        clientId: required(flags, 'client-id'),
        ...(clientSecret ? { clientSecret } : {}),
        ...(loginHint ? { loginHint } : {}),
        onUrl: (url) => {
          notice(`Open this URL in a browser on this machine and sign in to the mailbox you will send from:\n\n  ${url}\n\nWaiting for Microsoft...`);
          openUrl?.(url);
        },
        // Endpoint overrides exist for testing against a fake Microsoft; leave them unset in real use.
        ...(env.OUTREACH_MICROSOFT_AUTHORITY ? { authority: env.OUTREACH_MICROSOFT_AUTHORITY } : {}),
        ...(env.OUTREACH_GRAPH_API ? { api: env.OUTREACH_GRAPH_API } : {}),
      });
      if (loginHint && loginHint.toLowerCase() !== result.emailAddress) {
        throw new Error(`you signed in as ${result.emailAddress}, not ${loginHint}; nothing was saved`);
      }
      const path = saveGrant(flags, env, 'outlook', result.emailAddress, result.grant);
      out.result({ connected: result.emailAddress, secretRef: `file:${path}`, next: nextStep('outlook', result.emailAddress, path) });
    },
  },
];
