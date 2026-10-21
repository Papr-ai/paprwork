#!/usr/bin/env node
// Invoked only by the protected, signed-tag release workflow. Never runs during build/check.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { root, verifyRelease } from './release-manifest.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RELEASE_TAG) throw new Error('Publish only from the protected release workflow');
const packages = verifyRelease({ tag: process.env.RELEASE_TAG });
const args = [resolve(root, '../scripts/oidc-npm-publish.mjs'), '--cwd', root];
for (const pkg of packages) args.push('--workspace', pkg.name);
execFileSync(process.execPath, args, { stdio: 'inherit' });
