import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { flagBoolean, flagString, type ParsedArgv } from './argv.ts';
import { CLI_VERSION, PIN } from './pin.ts';
import { defaultRunner, type ProcessRunner } from './process.ts';
import { redact } from './redact.ts';

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface RunOptions { runner?: ProcessRunner; nodeVersion?: string; home?: string }

export async function dispatch(parsed: ParsedArgv, options: RunOptions = {}): Promise<CommandResult> {
  if (parsed.flags.help === true || parsed.flags.h === true || parsed.command === 'help') return ok(usage());
  if (parsed.command === 'version' || parsed.flags.version === true || parsed.flags.v === true) return ok(versionText());
  const runner = options.runner ?? defaultRunner();
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const suppliedDir = flagString(parsed.flags, 'dir');
  const dir = suppliedDir || defaultDir(options.home ?? homedir());
  switch (parsed.command) {
    case 'doctor': return cmdDoctor(resolve(dir), runner, nodeVersion);
    case 'checkout': return cmdCheckout(dir, flagString(parsed.flags, 'commit', PIN.commit), runner);
    case 'start': return cmdStart(resolve(dir), runner, nodeVersion, flagBoolean(parsed.flags, 'print-only'));
    default: return fail(`Unknown command "${parsed.command}".\n\n${usage()}`);
  }
}

export function defaultDir(home: string): string { return join(home, 'Papr', 'src', 'paprwork'); }

function versionText(): string {
  return [`paprwork ${CLI_VERSION}`, `upstream ${PIN.repository}`, `commit ${PIN.commit}`, `branch ${PIN.branch}`, `release baseline ${PIN.releaseBaseline}`, ''].join('\n');
}

function usage(): string {
  return [
    'paprwork version',
    'paprwork doctor [--dir <checkout>]',
    'paprwork checkout [--dir <checkout>] [--commit <40-char sha>]',
    'paprwork start [--dir <checkout>] [--print-only]',
    '',
    'Default checkout: ~/Papr/src/paprwork',
    `Pinned commit: ${PIN.commit}`,
    'checkout clones Papr Work and detaches that commit. start runs npm start after npm install.',
    'The launcher does not install dependencies and does not print secrets.',
    '',
  ].join('\n');
}

async function cmdDoctor(dir: string, runner: ProcessRunner, nodeVersion: string): Promise<CommandResult> {
  const report = await inspect(dir, runner, nodeVersion);
  return { exitCode: report.ok ? 0 : 1, stdout: report.text, stderr: '' };
}

async function cmdCheckout(inputDir: string, commit: string, runner: ProcessRunner): Promise<CommandResult> {
  const invalid = validateDir(inputDir);
  if (invalid) return fail(invalid);
  if (!/^[0-9a-fA-F]{40}$/.test(commit)) return fail('Commit must be a 40-character hexadecimal sha.\n');
  const dir = resolve(inputDir);
  const gitDir = join(dir, '.git');
  if (!existsSync(dir) || !existsSync(gitDir)) {
    if (existsSync(dir) && readdirSync(dir).length > 0) return fail(`Refusing to use ${dir} because it is not a git checkout.\n`);
    mkdirSync(dirname(dir), { recursive: true });
    const cloned = await runner.exec('git', ['clone', PIN.repository, dir]);
    if (cloned.code !== 0) return fail(`${redact(cloned.stderr || cloned.stdout)}git clone failed.\n`);
  } else {
    const fetched = await runner.exec('git', ['-C', dir, 'fetch', 'origin', commit]);
    if (fetched.code !== 0) return fail(`${redact(fetched.stderr || fetched.stdout)}git fetch failed.\n`);
  }
  const checked = await runner.exec('git', ['-C', dir, 'checkout', '--detach', commit]);
  if (checked.code !== 0) return fail(`${redact(checked.stderr || checked.stdout)}git checkout failed.\n`);
  return ok([`Checked out ${commit}`, dir, `Next: npm install in that directory, then paprwork start --dir ${dir}`, ''].join('\n'));
}

async function cmdStart(dir: string, runner: ProcessRunner, nodeVersion: string, printOnly: boolean): Promise<CommandResult> {
  const report = await inspect(dir, runner, nodeVersion);
  if (!report.ok) return fail(report.text);
  if (!existsSync(join(dir, 'node_modules'))) return fail(`Dependencies are not installed in ${dir}.\nRun npm install there, then paprwork start --dir ${dir}\n`);
  if (printOnly) return ok(`npm start\ncwd: ${dir}\n`);
  const code = await runner.spawn('npm', ['start'], dir);
  return { exitCode: code, stdout: '', stderr: '' };
}

interface Inspection { ok: boolean; text: string }
async function inspect(dir: string, runner: ProcessRunner, nodeVersion: string): Promise<Inspection> {
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  const lines = [`node ${nodeVersion}`, `required node >=${PIN.minimumNode}`, `checkout ${dir}`, `pinned ${PIN.commit}`];
  if (!Number.isInteger(nodeMajor) || nodeMajor < PIN.minimumNode) { lines.push('node: too old'); return report(false, lines); }
  if (!existsSync(dir) || !existsSync(join(dir, '.git'))) { lines.push('checkout: absent'); return report(false, lines); }
  const pkg = readPackage(dir);
  if (pkg?.name !== 'paprwork') { lines.push('package: not paprwork'); return report(false, lines); }
  const head = await runner.exec('git', ['-C', dir, 'rev-parse', 'HEAD']);
  const commit = head.stdout.trim();
  lines.push(`head ${commit || 'unknown'}`);
  if (head.code !== 0 || commit !== PIN.commit) { lines.push('commit: differs from the pinned Outreach Console baseline'); return report(false, lines); }
  lines.push(`package ${pkg.version ?? 'unknown'}`);
  lines.push(existsSync(join(dir, 'node_modules')) ? 'dependencies: installed' : 'dependencies: missing');
  lines.push('commit: matches');
  return report(true, lines);
}
function report(okay: boolean, lines: string[]): Inspection { return { ok: okay, text: `${lines.join('\n')}\n` }; }
function readPackage(dir: string): { name?: string; version?: string } | null {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }; } catch { return null; }
}
function validateDir(dir: string): string | null {
  if (!isAbsolute(dir) || resolve(dir) === parse(resolve(dir)).root) return 'Checkout directory must be an absolute path and not the filesystem root.\n';
  return null;
}
function ok(stdout: string): CommandResult { return { exitCode: 0, stdout, stderr: '' }; }
function fail(stderr: string): CommandResult { return { exitCode: 1, stdout: '', stderr: redact(stderr) }; }
