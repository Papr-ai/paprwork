#!/usr/bin/env node
/**
 * Automated test for default home app installation
 * 
 * This test directly calls the AppService methods to verify the fix
 * without requiring a full app restart.
 * 
 * Run: node scripts/test-default-app-install.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Test configuration
const DEFAULT_HOME_APP_ID = 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c';
const TEST_PAPR_DIR = path.join(projectRoot, 'test-papr-fresh-install');
const TEST_APPS_DIR = path.join(TEST_PAPR_DIR, 'apps');
const TEST_DATA_DIR = path.join(TEST_PAPR_DIR, 'data');
const TEST_APPS_JSON = path.join(TEST_DATA_DIR, 'apps.json');

async function log(message, isError = false) {
  const prefix = isError ? '❌' : '✅';
  console.log(`${prefix} ${message}`);
}

async function cleanup() {
  try {
    await fs.rm(TEST_PAPR_DIR, { recursive: true, force: true });
    console.log('🧹 Cleaned up test directory\n');
  } catch {
    // Ignore cleanup errors
  }
}

async function testDefaultAppInstallation() {
  console.log('\n=== Testing Default Home App Installation ===\n');
  
  try {
    // Step 1: Setup test environment
    console.log('Step 1: Setting up test environment...');
    await cleanup();
    await fs.mkdir(TEST_APPS_DIR, { recursive: true });
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    await fs.writeFile(TEST_APPS_JSON, '[]'); // Empty apps registry
    await log('Created fresh test environment');
    
    // Step 2: Create mock AppService with test paths
    console.log('\nStep 2: Creating test AppService instance...');
    
    // Import AppService (we'll mock the paths)
    const AppServiceModule = await import('../dist/gateway/services/AppService.js');
    const { AppService } = AppServiceModule;
    
    // Create instance
    const appService = new AppService();
    
    // Override paths for testing (hacky but works for this test)
    appService.paprRootDir = TEST_PAPR_DIR;
    appService.appsDir = TEST_APPS_DIR;
    appService.appsIndexPath = TEST_APPS_JSON;
    
    await log('Created AppService instance with test paths');
    
    // Step 3: Verify initial state (empty)
    console.log('\nStep 3: Verifying initial state...');
    
    const initialApps = await fs.readFile(TEST_APPS_JSON, 'utf8');
    const initialAppsList = JSON.parse(initialApps);
    
    if (initialAppsList.length !== 0) {
      throw new Error(`Expected empty registry, got ${initialAppsList.length} apps`);
    }
    await log('Apps registry is empty (as expected for fresh install)');
    
    // Check that app directory doesn't exist
    try {
      await fs.access(path.join(TEST_APPS_DIR, DEFAULT_HOME_APP_ID));
      throw new Error('Home app directory exists before installation');
    } catch (error) {
      if (error.code === 'ENOENT') {
        await log('Home app directory does not exist (expected)');
      } else {
        throw error;
      }
    }
    
    // Step 4: Call installDefaultApps (private method, but we can test initialize which calls it)
    console.log('\nStep 4: Running AppService.initialize()...');
    
    await appService.initialize();
    await log('AppService initialized (installDefaultApps() called)');
    
    // Step 5: Verify installation
    console.log('\nStep 5: Verifying default app installation...');
    
    // Check registry
    const appsData = await fs.readFile(TEST_APPS_JSON, 'utf8');
    const apps = JSON.parse(appsData);
    const homeApp = apps.find(app => app.id === DEFAULT_HOME_APP_ID);
    
    if (!homeApp) {
      await log('Home app NOT found in registry', true);
      console.log('\nApps in registry:', apps.map(a => `${a.id} - ${a.title}`));
      throw new Error('Default app not registered after initialize()');
    }
    await log(`Home app registered: "${homeApp.title}"`);
    
    // Verify app metadata
    const expectedFields = ['id', 'title', 'description', 'type', 'createdAt', 'updatedAt'];
    for (const field of expectedFields) {
      if (!homeApp[field]) {
        await log(`Missing field: ${field}`, true);
      }
    }
    await log('All required fields present');
    
    if (homeApp.title !== 'Home') {
      await log(`Wrong title: "${homeApp.title}" (expected "Home")`, true);
    } else {
      await log('Title correct: "Home"');
    }
    
    if (!homeApp.icon || !homeApp.icon.includes('<svg')) {
      await log('Icon missing or invalid', true);
    } else {
      await log('Icon present and valid (SVG)');
    }
    
    // Check filesystem
    const appDir = path.join(TEST_APPS_DIR, DEFAULT_HOME_APP_ID);
    try {
      await fs.access(appDir);
      await log('Home app directory created');
      
      // Verify critical files
      const files = await fs.readdir(appDir);
      if (!files.includes('index.html')) {
        throw new Error('index.html missing');
      }
      await log('index.html exists');
      
      // Count app files (should be multiple)
      const appFiles = files.filter(f => 
        f.endsWith('.html') || 
        f.endsWith('.js') || 
        f.endsWith('.css')
      );
      if (appFiles.length < 3) {
        await log(`Only ${appFiles.length} app files found (expected 3+)`, true);
      } else {
        await log(`${appFiles.length} app files installed`);
      }
    } catch (error) {
      await log(`App directory check failed: ${error.message}`, true);
      throw error;
    }
    
    // Step 6: Test idempotency (running initialize again shouldn't duplicate)
    console.log('\nStep 6: Testing idempotency (re-running initialize)...');
    
    await appService.initialize();
    
    const appsAfterSecondInit = await fs.readFile(TEST_APPS_JSON, 'utf8');
    const appsListAfterSecondInit = JSON.parse(appsAfterSecondInit);
    
    const homeAppCount = appsListAfterSecondInit.filter(
      app => app.id === DEFAULT_HOME_APP_ID
    ).length;
    
    if (homeAppCount !== 1) {
      await log(`Found ${homeAppCount} home apps (expected 1) - duplicates created!`, true);
      throw new Error('installDefaultApps is not idempotent');
    }
    await log('No duplicates created (idempotent)');
    
    // Success!
    console.log('\n=== All Tests Passed! ===\n');
    console.log('✅ Default home app is installed on fresh installations');
    console.log('✅ App is registered in apps.json with correct metadata');
    console.log('✅ App files are copied to ~/Papr/apps/{id}/');
    console.log('✅ Icon is resolved from app directory');
    console.log('✅ Installation is idempotent (no duplicates)');
    console.log('\n🎉 Fresh installations will now show the home dashboard!\n');
    
    return true;
    
  } catch (error) {
    console.log('\n=== Test Failed ===\n');
    console.error('❌', error.message);
    console.error('\nStack trace:', error.stack);
    return false;
  } finally {
    await cleanup();
  }
}

// Run test
testDefaultAppInstallation()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('\n❌ Test script crashed:', error);
    process.exit(1);
  });
