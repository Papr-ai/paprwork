#!/usr/bin/env node
/**
 * Quick verification that the fix is working
 * Checks the actual installation status in production paths
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const homeDir = os.homedir();
const paprDir = path.join(homeDir, 'Papr');
const appsJsonPath = path.join(paprDir, 'data', 'apps.json');
const homeAppId = 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c';
const homeAppDir = path.join(paprDir, 'apps', homeAppId);

async function verify() {
  console.log('\n=== Verifying Default Home App Installation ===\n');
  
  try {
    // Check apps.json
    const appsData = await fs.readFile(appsJsonPath, 'utf8');
    const apps = JSON.parse(appsData);
    const homeApp = apps.find(app => app.id === homeAppId);
    
    if (homeApp) {
      console.log('✅ Home app found in registry');
      console.log(`   Title: "${homeApp.title}"`);
      console.log(`   Description: "${homeApp.description}"`);
      console.log(`   Has icon: ${homeApp.icon ? 'Yes' : 'No'}`);
    } else {
      console.log('❌ Home app NOT in registry');
      console.log('   This is expected if you haven\'t restarted the app yet.');
    }
    
    // Check filesystem
    try {
      await fs.access(homeAppDir);
      const files = await fs.readdir(homeAppDir);
      console.log('\n✅ Home app directory exists');
      console.log(`   Files: ${files.length} total`);
      
      const hasIndex = files.includes('index.html');
      console.log(`   index.html: ${hasIndex ? 'Yes' : 'No'}`);
    } catch {
      console.log('\n❌ Home app directory does not exist');
    }
    
    // Check settings
    const settingsPath = path.join(paprDir, 'data', 'settings.json');
    try {
      const settingsData = await fs.readFile(settingsPath, 'utf8');
      const settings = JSON.parse(settingsData);
      const defaultHomeAppId = settings?.preferences?.defaultHomeAppId;
      
      console.log('\n✅ Settings configured');
      console.log(`   defaultHomeAppId: ${defaultHomeAppId}`);
      console.log(`   Matches home app: ${defaultHomeAppId === homeAppId ? 'Yes' : 'No'}`);
    } catch {
      console.log('\n⚠️  Settings file not found');
    }
    
    console.log('\n=== Next Steps ===\n');
    if (!homeApp) {
      console.log('1. Restart Paprwork (Cmd+Q then npm start)');
      console.log('2. The home dashboard should install automatically');
      console.log('3. Click the home button to verify it opens');
    } else {
      console.log('✅ Home app is installed! Click the home button to verify.');
    }
    console.log('');
    
  } catch (error) {
    console.error('❌ Verification failed:', error.message);
  }
}

verify();
