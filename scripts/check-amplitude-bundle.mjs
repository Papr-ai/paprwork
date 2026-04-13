#!/usr/bin/env node

/**
 * Check if Amplitude is loaded in the built UI bundle
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

console.log('🔍 Checking Amplitude in Built UI\n');

// Find the main UI bundle
const uiDir = join(rootDir, 'dist/ui/assets');
const jsFiles = existsSync(uiDir)
  ? readdirSync(uiDir).filter((f) => f.startsWith('index-') && f.endsWith('.js'))
  : [];

if (jsFiles.length === 0) {
  console.log('❌ No UI bundle found in dist/ui/assets/');
  console.log('   Run: npm run build:ui');
  process.exit(1);
}

const bundlePath = join(uiDir, jsFiles[0]);
console.log(`📦 Found bundle: ${jsFiles[0]}`);

const content = readFileSync(bundlePath, 'utf8');

// Renderer uses same-origin proxy (no @amplitude/analytics-browser in bundle)
const checks = [
  { name: 'No browser Amplitude SDK', search: '@amplitude/analytics-browser', shouldNotExist: true },
  { name: 'Gateway proxy URL in renderer', search: '/api/telemetry/events' },
  { name: 'initializeAmplitudeBrowser function', search: 'initializeAmplitudeBrowser' },
  { name: 'Renderer telemetry module', search: 'Renderer proxy' },
  { name: 'Session replay plugin', search: 'sessionReplayPlugin', shouldNotExist: true },
];

console.log('\nChecking bundle contents:\n');

let allGood = true;
for (const check of checks) {
  const found = content.includes(check.search);
  const expected = check.shouldNotExist ? !found : found;
  
  if (expected) {
    console.log(`✅ ${check.name}`);
  } else {
    console.log(`❌ ${check.name} - ${found ? 'Found (should not exist)' : 'Not found'}`);
    allGood = false;
  }
}

// Check telemetry initialization in App code
const telemetryFile = join(rootDir, 'ui/App.tsx');
if (existsSync(telemetryFile)) {
  const appContent = readFileSync(telemetryFile, 'utf8');
  const hasInit = appContent.includes('initializeAmplitudeBrowser');
  
  console.log(`\n${hasInit ? '✅' : '❌'} App.tsx calls initializeAmplitudeBrowser`);
  
  if (!hasInit) {
    allGood = false;
  }
}

console.log('\n' + '='.repeat(60));

if (allGood) {
  console.log('✅ Amplitude is properly bundled!');
  console.log('\nIf you\'re not seeing initialization:');
  console.log('1. Make sure the app is actually open');
  console.log('2. Press Cmd+Option+I to open DevTools');
  console.log('3. Click the "Console" tab');
  console.log('4. Look for: [Telemetry] Renderer proxy → .../api/telemetry/events');
  console.log('\nIf still nothing:');
  console.log('- Check Settings → Privacy → Send anonymous usage data is checked');
  console.log('- Restart the app');
} else {
  console.log('❌ Amplitude setup incomplete');
  console.log('\nRun: npm run build:ui');
}

process.exit(allGood ? 0 : 1);
