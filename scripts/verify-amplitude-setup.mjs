#!/usr/bin/env node

/**
 * Verify Amplitude Setup
 * Checks if all pieces are in place
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

console.log('🔍 Verifying Amplitude Setup\n');

let passed = 0;
let failed = 0;

function check(name, condition, details) {
  if (condition) {
    console.log(`✅ ${name}`);
    if (details) console.log(`   ${details}`);
    passed++;
  } else {
    console.log(`❌ ${name}`);
    if (details) console.log(`   ${details}`);
    failed++;
  }
}

// 1. Renderer uses gateway proxy (no @amplitude/analytics-browser — avoids CORS)
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const noBrowserAmplitude = !packageJson.dependencies['@amplitude/analytics-browser'];
const noSessionReplay = !packageJson.dependencies['@amplitude/session-replay-browser'];

check(
  'No browser Amplitude SDK dependency',
  noBrowserAmplitude,
  'Events POST same-origin → gateway → Papr proxy'
);

check(
  'Session replay package absent',
  noSessionReplay,
  'Good - events only, no visual recording'
);

// 2. Check event definitions exist
const eventsFile = join(rootDir, 'src/core/telemetry/events.ts');
check(
  'Event definitions file exists',
  existsSync(eventsFile),
  eventsFile
);

if (existsSync(eventsFile)) {
  const eventsContent = readFileSync(eventsFile, 'utf8');
  const hasSchedulerTick = eventsContent.includes('SCHEDULER_TICK');
  const hasMessageSent = eventsContent.includes('MESSAGE_SENT');
  
  check(
    'scheduler_tick removed from events',
    !hasSchedulerTick,
    hasSchedulerTick ? '⚠️  Still in events.ts!' : 'Removed ✓'
  );
  
  check(
    'Message events defined',
    hasMessageSent,
    'MESSAGE_SENT and other events present'
  );
}

// 3. Check telemetry client
const telemetryFile = join(rootDir, 'ui/lib/telemetry.ts');
check(
  'Telemetry client exists',
  existsSync(telemetryFile),
  telemetryFile
);

if (existsSync(telemetryFile)) {
  const telemetryContent = readFileSync(telemetryFile, 'utf8');
  const hasSessionReplay = telemetryContent.includes('sessionReplayPlugin');
  const hasTrackEvent = telemetryContent.includes('export function trackEvent');
  
  check(
    'Session replay plugin removed',
    !hasSessionReplay,
    hasSessionReplay ? '⚠️  Still has session replay!' : 'Removed ✓'
  );
  
  check(
    'trackEvent function exported',
    hasTrackEvent,
    'Ready to use in components'
  );
}

// 4. Check App.tsx initialization
const appFile = join(rootDir, 'ui/App.tsx');
if (existsSync(appFile)) {
  const appContent = readFileSync(appFile, 'utf8');
  const hasInit = appContent.includes('initializeAmplitudeBrowser');
  
  check(
    'App.tsx initializes renderer telemetry',
    hasInit,
    'Initialization code present'
  );
}

// Gateway proxy route
const gatewayIndex = join(rootDir, 'src/gateway/index.ts');
if (existsSync(gatewayIndex)) {
  const gi = readFileSync(gatewayIndex, 'utf8');
  check(
    'Gateway exposes /api/telemetry/events',
    gi.includes('/api/telemetry/events') && gi.includes('forwardRendererTelemetry'),
    'CORS-safe path for renderer'
  );
}

// 5. Check scheduler no longer tracks
const schedulerFile = join(rootDir, 'src/gateway/services/JobsScheduler.ts');
if (existsSync(schedulerFile)) {
  const schedulerContent = readFileSync(schedulerFile, 'utf8');
  const hasTelemetryCall = schedulerContent.includes('trackFireAndForget("paprwork_scheduler_tick"');
  
  check(
    'Scheduler tick telemetry removed',
    !hasTelemetryCall,
    hasTelemetryCall ? '⚠️  Still tracking in scheduler!' : 'Removed ✓'
  );
}

// 6. Check if built
const distGateway = join(rootDir, 'dist/gateway/services/JobsScheduler.js');
const distUI = join(rootDir, 'dist/ui/index.html');

check(
  'Gateway built',
  existsSync(distGateway),
  existsSync(distGateway) ? 'dist/gateway/ exists' : 'Run: npm run build'
);

check(
  'UI built',
  existsSync(distUI),
  existsSync(distUI) ? 'dist/ui/ exists' : 'Run: npm run build'
);

// Summary
console.log('\n' + '='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);

if (failed === 0) {
  console.log('\n🎉 Setup verified! Ready to track events.');
  console.log('\nNext steps:');
  console.log('1. Open the app (npm start)');
  console.log('2. Open DevTools (Cmd/Ctrl + Option/Shift + I)');
  console.log('3. Look for: "[Telemetry] Renderer proxy → .../api/telemetry/events"');
  console.log('4. Trigger events (send message, create job)');
  console.log('5. Check Amplitude dashboard');
} else {
  console.log('\n⚠️  Some checks failed. Review above.');
}

process.exit(failed > 0 ? 1 : 0);
