#!/usr/bin/env node
/**
 * Set Default Home App
 * 
 * Sets the defaultHomeAppId in preferences so the home button opens
 * the specified mini-app instead of the placeholder.
 * 
 * Usage:
 *   node scripts/set-default-home-app.mjs <appId>
 *   node scripts/set-default-home-app.mjs --clear  # Remove default home app
 * 
 * Example:
 *   node scripts/set-default-home-app.mjs bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const SETTINGS_PATH = path.join(os.homedir(), 'PAPR', 'data', 'settings.json');

async function main() {
  const appId = process.argv[2];
  
  if (!appId) {
    console.error('Usage: node scripts/set-default-home-app.mjs <appId>');
    console.error('   Or: node scripts/set-default-home-app.mjs --clear');
    process.exit(1);
  }
  
  // Load existing settings
  let settings = { preferences: {} };
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(content);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to read settings:', error);
      process.exit(1);
    }
    // File doesn't exist, will create new one
  }
  
  // Ensure preferences object exists
  if (!settings.preferences) {
    settings.preferences = {};
  }
  
  if (appId === '--clear') {
    // Remove default home app
    delete settings.preferences.defaultHomeAppId;
    console.log('✓ Cleared default home app');
  } else {
    // Set default home app
    settings.preferences.defaultHomeAppId = appId;
    console.log(`✓ Set default home app to: ${appId}`);
  }
  
  // Save settings
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  
  console.log('\nSettings updated. Restart Paprwork for changes to take effect.');
  console.log('The home button will now open your configured app.');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
