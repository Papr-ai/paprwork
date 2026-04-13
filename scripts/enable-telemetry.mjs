#!/usr/bin/env node

/**
 * Enable telemetry for testing
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const settingsPath = join(homedir(), 'Papr', 'data', 'settings.json');

console.log('📝 Enabling telemetry...\n');

try {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  
  // Enable telemetry
  if (!settings.preferences) {
    settings.preferences = {};
  }
  settings.preferences.telemetryEnabled = true;
  
  // Create install ID if missing
  if (!settings.telemetry) {
    settings.telemetry = {};
  }
  if (!settings.telemetry.installId) {
    settings.telemetry.installId = randomBytes(16).toString('hex');
  }
  
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  
  console.log('✅ Telemetry enabled');
  console.log(`   Install ID: ${settings.telemetry.installId.substring(0, 8)}...`);
  console.log('\nRestart the app to see Amplitude initialize!');
  
} catch (error) {
  console.error('❌ Failed:', error.message);
  process.exit(1);
}
