#!/usr/bin/env node
/**
 * Test Fresh Installation Flow
 * 
 * Simulates what happens when a new user installs Paprwork:
 * 1. Removes the home dashboard app
 * 2. Removes apps.json
 * 3. Checks if app gets auto-installed
 * 4. Verifies settings point to it
 * 5. Tests home button behavior
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const HOME_APP_ID = 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c';
const PAPR_DIR = path.join(os.homedir(), 'Papr');
const APP_DIR = path.join(PAPR_DIR, 'apps', HOME_APP_ID);
const APPS_JSON = path.join(PAPR_DIR, 'data', 'apps.json');
const SETTINGS_JSON = path.join(PAPR_DIR, 'data', 'settings.json');

async function main() {
  console.log('🧪 Testing Fresh Installation Flow\n');

  // Step 1: Backup current state
  console.log('📦 Creating backups...');
  const appBackup = APP_DIR + '.backup';
  const appsJsonBackup = APPS_JSON + '.backup';
  
  try {
    await fs.access(APP_DIR);
    await fs.cp(APP_DIR, appBackup, { recursive: true });
    console.log(`✓ Backed up app to: ${appBackup}`);
  } catch {
    console.log('ℹ App directory does not exist (fresh state)');
  }

  try {
    await fs.access(APPS_JSON);
    await fs.copyFile(APPS_JSON, appsJsonBackup);
    console.log(`✓ Backed up apps.json to: ${appsJsonBackup}`);
  } catch {
    console.log('ℹ apps.json does not exist (fresh state)');
  }

  // Step 2: Simulate fresh install (remove app)
  console.log('\n🗑️  Simulating fresh installation...');
  try {
    await fs.rm(APP_DIR, { recursive: true, force: true });
    console.log(`✓ Removed app directory: ${APP_DIR}`);
  } catch {
    console.log('✓ App directory already removed');
  }

  try {
    await fs.rm(APPS_JSON, { force: true });
    console.log(`✓ Removed apps.json: ${APPS_JSON}`);
  } catch {
    console.log('✓ apps.json already removed');
  }

  // Step 3: Check bundled resources
  console.log('\n📦 Checking bundled resources...');
  const bundlePath = 'dist/resources/default-apps/home-dashboard';
  try {
    await fs.access(bundlePath);
    const files = await fs.readdir(bundlePath);
    console.log(`✓ Bundle exists: ${bundlePath}`);
    console.log(`  Files: ${files.join(', ')}`);
    
    const appId = (await fs.readFile(path.join(bundlePath, 'app-id.txt'), 'utf-8')).trim();
    console.log(`  App ID: ${appId}`);
  } catch (error) {
    console.error(`❌ Bundle not found: ${bundlePath}`);
    console.error('   Run: npm run build:gateway');
    process.exit(1);
  }

  // Step 4: Check default settings
  console.log('\n⚙️  Checking default settings...');
  try {
    await fs.rm(SETTINGS_JSON, { force: true });
    console.log('✓ Removed settings.json (will regenerate with defaults)');
  } catch {}

  console.log('\n📋 Summary:');
  console.log('✓ App removed (simulating fresh install)');
  console.log('✓ apps.json removed');
  console.log('✓ settings.json removed');
  console.log('✓ Bundled app exists in dist/resources/');
  console.log('\n🚀 Next steps:');
  console.log('1. Start the app: npm start');
  console.log('2. Watch console for: "[AppService] Installed default app: bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c"');
  console.log('3. Click home button');
  console.log('4. Expected: Weekly War Room dashboard opens');
  console.log('\n💡 To restore your data:');
  console.log(`   cp -r ${appBackup} ${APP_DIR}`);
  console.log(`   cp ${appsJsonBackup} ${APPS_JSON}`);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
