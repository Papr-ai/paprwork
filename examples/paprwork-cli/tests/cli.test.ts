import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../src/cli.ts';
import { PIN } from '../src/pin.ts';
import type { ProcessRunner } from '../src/process.ts';
import { redact } from '../src/redact.ts';

const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function runner(head = PIN.commit): ProcessRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    exec(command, args) {
      calls.push([command, ...args].join(' '));
      if (args.includes('rev-parse')) return Promise.resolve({ code: 0, stdout: `${head}\n`, stderr: '' });
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
    spawn() {
      calls.push('spawn npm start');
      return Promise.resolve(0);
    },
  };
}

function checkout(name = 'paprwork'): string {
  const dir = mkdtempSync(join(tmpdir(), 'paprwork-cli-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '2.7.2' }));
  return dir;
}

describe('paprwork version', () => {
  it('prints the pinned Outreach Console commit', async () => {
    const result = await run(['node', 'paprwork', 'version']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(PIN.commit));
    assert.match(result.stdout, /2\.7\.2/);
    assert.doesNotMatch(result.stdout, /li_at=/);
  });
});

describe('paprwork doctor', () => {
  it('accepts a checkout at the pinned commit', async () => {
    const dir = checkout();
    try {
      const git = runner();
      const result = await run(['node', 'paprwork', 'doctor', '--dir', dir], { runner: git, nodeVersion: '24.13.0' });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /commit: matches/);
      assert.match(result.stdout, /dependencies: missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a different commit', async () => {
    const dir = checkout();
    try {
      const result = await run(['node', 'paprwork', 'doctor', '--dir', dir], { runner: runner(OTHER), nodeVersion: '24.13.0' });
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /differs from the pinned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('paprwork checkout', () => {
  it('clones the upstream repository and detaches the pinned commit', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'paprwork-parent-')), 'src', 'paprwork');
    const git = runner();
    const result = await run(['node', 'paprwork', 'checkout', '--dir', dir], { runner: git });
    assert.equal(result.exitCode, 0);
    assert.equal(git.calls[0], `git clone ${PIN.repository} ${dir}`);
    assert.equal(git.calls.at(-1), `git -C ${dir} checkout --detach ${PIN.commit}`);
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });

  it('refuses a commit that is not a sha', async () => {
    const result = await run(['node', 'paprwork', 'checkout', '--dir', '/tmp/paprwork-cli-nope', '--commit', 'main']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /40-character/);
  });
});

describe('paprwork start', () => {
  it('prints the desktop start command and does not spawn it', async () => {
    const dir = checkout();
    mkdirSync(join(dir, 'node_modules'));
    const git = runner();
    try {
      const result = await run(['node', 'paprwork', 'start', '--dir', dir, '--print-only'], { runner: git, nodeVersion: '24.13.0' });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /npm start/);
      assert.equal(git.calls.includes('spawn npm start'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('redaction', () => {
  it('removes session material from command output', () => {
    const text = redact('failed li_at=secretcookie Bearer eyJhbGciOi.payload.sig');
    assert.equal(text.includes('secretcookie'), false);
    assert.equal(text.includes('eyJhbGciOi'), false);
  });
});

describe('argument validation and stderr redaction', () => {
  it('refuses a relative checkout directory and the filesystem root', async () => {
    for (const dir of ['relative/path', '/']) {
      const result = await run(['node', 'paprwork', 'checkout', '--dir', dir]);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stderr, 'Checkout directory must be an absolute path and not the filesystem root.\n');
    }
  });

  it('does not let boolean flags consume following tokens', async () => {
    const result = await run(['node', 'paprwork', '--print-only', 'version']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /paprwork 0\.1\.0/);
  });

  it('redacts secrets from failures', async () => {
    const result = await run(['node', 'paprwork', 'Bearer secret-token']);
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(result.stderr, /secret-token/);
  });
});
