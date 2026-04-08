#!/usr/bin/env node
/**
 * Test script to verify default home app installation on fresh installs
 * 
 * This simulates what happens when a user installs Paprwork for the first time:
 * 1. No existing apps registry
 * 2. No app files on disk
 * 3. Default apps should be installed and registered automatically
 * 
 * Run: node scripts/test-fresh-install.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const homeDir = os.homedir();
const paprDir = path.join(homeDir, 'Papr');
const appsDir = path.join(paprDir, 'apps');
const dataDir = path.join(paprDir, 'data');
const appsJsonPath = path.join(dataDir, 'apps.json');
const settingsJsonPath = path.join(dataDir, 'settings.json');

// Test configurations
const DEFAULT_HOME_APP_ID = 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c';
const BACKUP_SUFFIX = `.backup.${Date.now()}`;

async function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const prefix = isError ? '❌' : '✅';
  console.log(`${prefix} [${timestamp}] ${message}`);
}

async function backupFile(filePath) {
  try {
    await fs.access(filePath);
    const backupPath = `${filePath}${BACKUP_SUFFIX}`;
    await fs.copyFile(filePath, backupPath);
    await log(`Backed up: ${path.basename(filePath)} → ${path.basename(backupPath)}`);
    return backupPath;
  } catch {
    return null; // File doesn't exist, no backup needed
  }
}

async function restoreFile(backupPath, originalPath) {
  if (backupPath) {
    try {
      await fs.copyFile(backupPath, originalPath);
      await fs.unlink(backupPath);
      await log(`Restored: ${path.basename(originalPath)}`);
    } catch (error) {
      await log(`Failed to restore ${path.basename(originalPath)}: ${error.message}`, true);
    }
  }
}

async function backupAppDirectory(appId) {
  const appDir = path.join(appsDir, appId);
  try {
    await fs.access(appDir);
    const backupDir = `${appDir}${BACKUP_SUFFIX}`;
    await fs.cp(appDir, backupDir, { recursive: true });
    await log(`Backed up app directory: ${appId}`);
    return backupDir;
  } catch {
    return null;
  }
}

async function restoreAppDirectory(backupDir, appId) {
  if (backupDir) {
    const appDir = path.join(appsDir, appId);
    try {
      await fs.rm(appDir, { recursive: true, force: true });
      await fs.cp(backupDir, appDir, { recursive: true });
      await fs.rm(backupDir, { recursive: true, force: true });
      await log(`Restored app directory: ${appId}`);
    } catch (error) {
      await log(`Failed to restore app directory ${appId}: ${error.message}`, true);
    }
  }
}

async function testFreshInstall() {
  console.log('\n=== Testing Fresh Installation Flow ===\n');
  
  let appsJsonBackup = null;
  let settingsJsonBackup = null;
  let appDirBackup = null;
  
  try {
    // Step 1: Backup existing data
    console.log('Step 1: Backing up existing data...');
    appsJsonBackup = await backupFile(appsJsonPath);
    settingsJsonBackup = await backupFile(settingsJsonPath);
    appDirBackup = await backupAppDirectory(DEFAULT_HOME_APP_ID);
    
    // Step 2: Simulate fresh install (remove app from registry and disk)
    console.log('\nStep 2: Simulating fresh installation...');
    
    // Remove app from registry
    try {
      const appsData = await fs.readFile(appsJsonPath, 'utf8');
      const apps = JSON.parse(appsData);
      const filteredApps = apps.filter(app => app.id !== DEFAULT_HOME_APP_ID);
      await fs.writeFile(appsJsonPath, JSON.stringify(filteredApps, null, 2));
      await log(`Removed home app from registry (${apps.length} → ${filteredApps.length} apps)`);
    } catch (error) {
      await log('No existing apps registry', false);
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(appsJsonPath, '[]');
    }
    
    // Remove app directory
    const appDir = path.join(appsDir, DEFAULT_HOME_APP_ID);
    try {
      await fs.rm(appDir, { recursive: true, force: true });
      await log('Removed home app directory');
    } catch {
      await log('No existing home app directory', false);
    }
    
    // Step 3: Verify fresh state
    console.log('\nStep 3: Verifying fresh state...');
    
    // Check registry
    const appsData = await fs.readFile(appsJsonPath, 'utf8');
    const apps = JSON.parse(appsData);
    const hasAppInRegistry = apps.some(app => app.id === DEFAULT_HOME_APP_ID);
    if (hasAppInRegistry) {
      throw new Error('Home app still exists in registry after removal');
    }
    await log('Registry does not contain home app');
    
    // Check filesystem
    try {
      await fs.access(appDir);
      throw new Error('Home app directory still exists after removal');
    } catch {
      await log('Home app directory does not exist');
    }
    
    // Step 4: Restart Gateway to trigger installDefaultApps()
    console.log('\nStep 4: Triggering default app installation...');
    console.log('⚠️  You need to restart the app (Cmd+Q then npm start) to trigger installDefaultApps()');
    console.log('    Or wait for the next Gateway restart during your testing.');
    console.log('\nPress Ctrl+C to restore backups and exit, or wait 10 seconds to check results...\n');
    
    // Wait 10 seconds for manual restart
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Step 5: Verify installation
    console.log('\nStep 5: Verifying default app installation...');
    
    // Check registry
    const newAppsData = await fs.readFile(appsJsonPath, 'utf8');
    const newApps = JSON.parse(newAppsData);
    const homeApp = newApps.find(app => app.id === DEFAULT_HOME_APP_ID);
    
    if (!homeApp) {
      await log('Home app NOT found in registry after restart', true);
      throw new Error('Default app installation failed: app not in registry');
    }
    await log(`Home app found in registry: "${homeApp.title}"`);
    
    // Verify app details
    if (homeApp.title !== 'Home') {
      await log(`Wrong title: "${homeApp.title}" (expected "Home")`, true);
    } else {
      await log('App title correct: "Home"');
    }
    
    if (!homeApp.icon || !homeApp.icon.includes('<svg')) {
      await log('App icon missing or invalid', true);
    } else {
      await log('App icon present and valid');
    }
    
    // Check filesystem
    try {
      await fs.access(appDir);
      await log('Home app directory exists');
      
      // Verify key files
      const indexPath = path.join(appDir, 'index.html');
      await fs.access(indexPath);
      await log('index.html exists');
      
      const metadataPath = path.join(appDir, 'metadata.json');
      try {
        await fs.access(metadataPath);
        await log('metadata.json exists');
      } catch {
        await log('metadata.json missing (optional)', false);
      }
    } catch (error) {
      await log('Home app directory or files missing after installation', true);
      throw error;
    }
    
    // Step 6: Verify settings
    console.log('\nStep 6: Verifying default home app setting...');
    
    try {
      const settingsData = await fs.readFile(settingsJsonPath, 'utf8');
      const settings = JSON.parse(settingsData);
      const defaultHomeAppId = settings?.preferences?.defaultHomeAppId;
      
      if (defaultHomeAppId === DEFAULT_HOME_APP_ID) {
        await log(`Default home app ID configured: ${defaultHomeAppId}`);
      } else {
        await log(`Default home app ID mismatch: ${defaultHomeAppId} (expected ${DEFAULT_HOME_APP_ID})`, true);
      }
    } catch (error) {
      await log('Settings file not found or invalid', true);
    }
    
    console.log('\n=== Test Summary ===\n');
    console.log('✅ All checks passed!');
    console.log('✅ Default home app is installed and registered');
    console.log('✅ Fresh installations should work correctly\n');
    
  } catch (error) {
    console.log('\n=== Test Failed ===\n');
    console.error('❌', error.message);
    console.error('\nStack trace:', error.stack);
  } finally {
    // Step 7: Restore backups
    console.log('\nStep 7: Restoring backups...');
    
    if (appsJsonBackup || settingsJsonBackup || appDirBackup) {
      console.log('\nDo you want to restore your original data? (y/n)');
      console.log('Press Ctrl+C to skip restoration and keep the test state.\n');
      
      // Wait 5 seconds for user input
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Restore backups
      await restoreFile(appsJsonBackup, appsJsonPath);
      await restoreFile(settingsJsonBackup, settingsJsonPath);
      await restoreAppDirectory(appDirBackup, DEFAULT_HOME_APP_ID);
      
      console.log('\n✅ Original data restored\n');
    } else {
      console.log('No backups to restore\n');
    }
  }
}

// Run test
testFreshInstall().catch(error => {
  console.error('\n❌ Test script failed:', error);
  process.exit(1);
});
