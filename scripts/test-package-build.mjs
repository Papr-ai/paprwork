#!/usr/bin/env node
/**
 * Test Package Build
 * 
 * Verifies that all required files are included in the electron-builder package.
 * This catches issues like missing IPC files that work in dev but fail in production.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ANSI colors
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';

function log(message, color = RESET) {
  console.log(`${color}${message}${RESET}`);
}

function success(message) {
  log(`✓ ${message}`, GREEN);
}

function error(message) {
  log(`✗ ${message}`, RED);
}

function warn(message) {
  log(`⚠ ${message}`, YELLOW);
}

function info(message) {
  log(`ℹ ${message}`, CYAN);
}

function section(message) {
  log(`\n=== ${message} ===`, BLUE);
}

/**
 * Check if required files exist before build
 */
function checkPreBuildFiles() {
  section('Pre-Build File Check');
  
  const requiredFiles = [
    'src/electron/index.cjs',
    'src/electron/main.cjs',
    'src/electron/supervisor-logic.cjs',
    'src/electron/preload.cjs',
    'electron-builder.json',
    'package.json'
  ];
  
  let allExist = true;
  
  for (const file of requiredFiles) {
    const fullPath = join(ROOT, file);
    if (existsSync(fullPath)) {
      success(`Found: ${file}`);
    } else {
      error(`Missing: ${file}`);
      allExist = false;
    }
  }
  
  return allExist;
}

/**
 * Check electron-builder.json configuration
 */
function checkBuilderConfig() {
  section('electron-builder.json Configuration');
  
  const configPath = join(ROOT, 'electron-builder.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  
  info('Checking files array...');
  
  const requiredPatterns = [
    'dist/**/*',
    'src/electron/main.cjs',
    'src/electron/index.cjs',
    'src/electron/supervisor-logic.cjs',
    'src/electron/preload.cjs',
    'src/electron/ipc/**/*.cjs',
    'src/resources/**/*',
    'package.json'
  ];

  const requiredAsarUnpack = [
    'dist/resources/default-apps/**',
    'dist/resources/default-jobs/**',
  ];
  
  let allIncluded = true;
  
  for (const pattern of requiredPatterns) {
    if (config.files.includes(pattern)) {
      success(`Included: ${pattern}`);
    } else {
      error(`Missing: ${pattern}`);
      allIncluded = false;
    }
  }

  info('Checking asarUnpack array...');
  for (const pattern of requiredAsarUnpack) {
    if (config.asarUnpack?.includes(pattern)) {
      success(`Unpacked: ${pattern}`);
    } else {
      error(`Missing from asarUnpack: ${pattern}`);
      allIncluded = false;
    }
  }
  
  return allIncluded;
}

/**
 * Build the production version
 */
function buildProduction() {
  section('Building Production Version');
  
  try {
    info('Running: npm run build');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    success('Build completed successfully');
    return true;
  } catch (err) {
    error(`Build failed: ${err.message}`);
    return false;
  }
}

/**
 * Check if dist files were created
 */
function checkDistFiles() {
  section('Checking dist/ Output');
  
  const distPath = join(ROOT, 'dist');
  
  if (!existsSync(distPath)) {
    error('dist/ directory not found');
    return false;
  }
  
  const requiredDirs = [
    'core',
    'electron',
    'gateway'
  ];
  
  let allExist = true;
  
  for (const dir of requiredDirs) {
    const fullPath = join(distPath, dir);
    if (existsSync(fullPath)) {
      success(`Found: dist/${dir}/`);
    } else {
      error(`Missing: dist/${dir}/`);
      allExist = false;
    }
  }
  
  return allExist;
}

/**
 * Package the app (quick mode - no signing)
 */
function packageApp() {
  section('Packaging App (Mac - No Signing)');
  
  try {
    // Set env vars to skip signing/notarization AND publishing for testing
    const env = {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false', // Skip signing
      SKIP_NOTARIZE: 'true',
      EP_DRAFT: 'false', // Don't create GitHub draft
      EP_PRE_RELEASE: 'false' // Don't mark as pre-release
    };
    
    info('Running: npm run dist:mac (this may take a few minutes...)');
    info('Note: GitHub publish errors are expected and ignored');
    
    // Use --publish never to skip GitHub upload entirely
    execSync('npm run build && electron-builder --mac --arm64 --publish never', { 
      cwd: ROOT, 
      stdio: 'inherit', 
      env 
    });
    success('Packaging completed successfully');
    return true;
  } catch (err) {
    // Check if the error is just about GitHub publishing
    if (err.message.includes('GitHub Personal Access Token')) {
      warn('GitHub publish failed (expected - no GH_TOKEN), but app was built');
      // Check if app was actually built despite publish error
      const appPath = join(ROOT, 'release', 'mac-arm64', 'Papr Work.app');
      if (existsSync(appPath)) {
        success('App bundle was built successfully');
        return true;
      }
    }
    error(`Packaging failed: ${err.message}`);
    return false;
  }
}

/**
 * Check if packaged app was created
 */
function checkPackagedApp() {
  section('Checking Packaged Output');
  
  const releasePath = join(ROOT, 'release');
  
  if (!existsSync(releasePath)) {
    error('release/ directory not found');
    return false;
  }
  
  // Find the .app bundle (might be in mac/ or mac-universal/)
  const macDirs = ['mac', 'mac-universal', 'mac-arm64', 'mac-x64'];
  let appPath = null;
  
  for (const dir of macDirs) {
    const candidatePath = join(releasePath, dir, 'Papr Work.app');
    if (existsSync(candidatePath)) {
      appPath = candidatePath;
      break;
    }
  }
  
  if (!appPath) {
    error('Could not find Papr Work.app in release/');
    return false;
  }
  
  success(`Found app bundle: ${appPath}`);
  return appPath;
}

/**
 * Extract and check ASAR contents
 */
function checkAsarContents(appPath) {
  section('Checking ASAR Archive Contents');
  
  // Check if asar is available
  try {
    execSync('which asar', { stdio: 'ignore' });
  } catch (err) {
    warn('asar tool not installed - skipping archive inspection');
    info('Install with: npm install -g @electron/asar');
    return null;
  }
  
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
  
  if (!existsSync(asarPath)) {
    error('app.asar not found in app bundle');
    return false;
  }
  
  success(`Found ASAR archive: ${asarPath}`);
  
  // Extract to temp directory
  const extractPath = join(ROOT, 'tmp-asar-extract');
  
  try {
    info('Extracting ASAR archive...');
    execSync(`npx @electron/asar extract "${asarPath}" "${extractPath}"`, {
      cwd: ROOT,
      stdio: 'ignore'
    });
    
    // Check for required files in extracted archive
    const requiredFiles = [
      'src/electron/index.cjs',
      'src/electron/main.cjs',
      'src/electron/preload.cjs',
      'src/resources/workspace-templates/SLEEP.md',
    ];

    const requiredUnpackedDirs = [
      'dist/resources/default-apps/home-dashboard/app-id.txt',
      'dist/resources/default-jobs',
    ];
    
    let allIncluded = true;
    
    for (const file of requiredFiles) {
      const fullPath = join(extractPath, file);
      if (existsSync(fullPath)) {
        success(`Found in ASAR: ${file}`);
      } else {
        error(`Missing from ASAR: ${file}`);
        allIncluded = false;
      }
    }

    const unpackedRoot = asarPath.replace('app.asar', 'app.asar.unpacked');
    for (const relPath of requiredUnpackedDirs) {
      const fullPath = join(unpackedRoot, relPath);
      if (existsSync(fullPath)) {
        success(`Found unpacked: ${relPath}`);
      } else {
        error(`Missing from app.asar.unpacked: ${relPath}`);
        allIncluded = false;
      }
    }
    
    // Clean up
    execSync(`rm -rf "${extractPath}"`, { cwd: ROOT, stdio: 'ignore' });
    
    return allIncluded;
  } catch (err) {
    error(`Failed to extract/check ASAR: ${err.message}`);
    return false;
  }
}

/**
 * Main test flow
 */
async function main() {
  log('\n🔍 Paprwork Package Build Test\n', BLUE);
  
  const results = {
    preBuild: false,
    config: false,
    build: false,
    dist: false,
    package: false,
    app: false,
    asar: null // null = skipped
  };
  
  // Step 1: Pre-build checks
  results.preBuild = checkPreBuildFiles();
  if (!results.preBuild) {
    error('\n❌ Pre-build checks failed');
    process.exit(1);
  }
  
  // Step 2: Config checks
  results.config = checkBuilderConfig();
  if (!results.config) {
    error('\n❌ electron-builder.json configuration invalid');
    process.exit(1);
  }
  
  // Step 3: Build
  results.build = buildProduction();
  if (!results.build) {
    error('\n❌ Build failed');
    process.exit(1);
  }
  
  // Step 4: Check dist output
  results.dist = checkDistFiles();
  if (!results.dist) {
    error('\n❌ dist/ files missing');
    process.exit(1);
  }
  
  // Step 5: Package (optional - can be skipped with --no-package)
  if (process.argv.includes('--no-package')) {
    warn('\nSkipping packaging step (--no-package flag)');
  } else {
    results.package = packageApp();
    if (!results.package) {
      error('\n❌ Packaging failed');
      process.exit(1);
    }
    
    // Step 6: Check packaged app
    const appPath = checkPackagedApp();
    results.app = !!appPath;
    
    if (!results.app) {
      error('\n❌ Packaged app not found');
      process.exit(1);
    }
    
    // Step 7: Check ASAR contents
    results.asar = checkAsarContents(appPath);
    if (results.asar === false) {
      error('\n❌ ASAR contents check failed');
      process.exit(1);
    }
  }
  
  // Summary
  section('Test Summary');
  success(`✓ Pre-build files: ${results.preBuild ? 'PASS' : 'FAIL'}`);
  success(`✓ electron-builder.json: ${results.config ? 'PASS' : 'FAIL'}`);
  success(`✓ Production build: ${results.build ? 'PASS' : 'FAIL'}`);
  success(`✓ dist/ output: ${results.dist ? 'PASS' : 'FAIL'}`);
  
  if (!process.argv.includes('--no-package')) {
    success(`✓ App packaging: ${results.package ? 'PASS' : 'FAIL'}`);
    success(`✓ App bundle: ${results.app ? 'PASS' : 'FAIL'}`);
    
    if (results.asar !== null) {
      success(`✓ ASAR contents: ${results.asar ? 'PASS' : 'FAIL'}`);
    } else {
      info('  ASAR check: SKIPPED (install @electron/asar)');
    }
  }
  
  log('\n✅ All tests passed!\n', GREEN);
}

main().catch((err) => {
  error(`\n❌ Test script failed: ${err.message}`);
  process.exit(1);
});
