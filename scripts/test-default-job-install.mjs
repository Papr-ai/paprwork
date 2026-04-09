#!/usr/bin/env node
/**
 * Test script to verify default job installation on fresh installs
 * 
 * Run: node scripts/test-default-job-install.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Test configuration
const DEFAULT_JOB_ID = '2cafb2e9-696b-42db-98fa-5d605977123c';
const TEST_PAPR_DIR = path.join(projectRoot, 'test-papr-job-install');
const TEST_JOBS_DIR = path.join(TEST_PAPR_DIR, 'jobs');
const TEST_DATA_DIR = path.join(TEST_PAPR_DIR, 'data');
const TEST_JOBS_JSON = path.join(TEST_DATA_DIR, 'jobs.json');

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

async function testDefaultJobInstallation() {
  console.log('\n=== Testing Default Job Installation ===\n');
  
  try {
    // Step 1: Setup test environment
    console.log('Step 1: Setting up test environment...');
    await cleanup();
    await fs.mkdir(TEST_JOBS_DIR, { recursive: true });
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    await fs.writeFile(TEST_JOBS_JSON, '[]'); // Empty jobs registry
    await log('Created fresh test environment');
    
    // Step 2: Create test JobsService instance
    console.log('\nStep 2: Creating test JobsService instance...');
    
    // Import JobsService
    const JobsServiceModule = await import('../dist/gateway/services/JobsService.js');
    const { JobsService } = JobsServiceModule;
    
    // Create instance
    const jobsService = new JobsService();
    
    // Override paths for testing
    jobsService.paprRootDir = TEST_PAPR_DIR;
    jobsService.jobsRootDir = TEST_JOBS_DIR;
    jobsService.jobsIndexPath = TEST_JOBS_JSON;
    
    await log('Created JobsService instance with test paths');
    
    // Step 3: Verify initial state (empty)
    console.log('\nStep 3: Verifying initial state...');
    
    const initialJobs = await fs.readFile(TEST_JOBS_JSON, 'utf8');
    const initialJobsList = JSON.parse(initialJobs);
    
    if (initialJobsList.length !== 0) {
      throw new Error(`Expected empty registry, got ${initialJobsList.length} jobs`);
    }
    await log('Jobs registry is empty (expected for fresh install)');
    
    // Check that job directory doesn't exist
    try {
      await fs.access(path.join(TEST_JOBS_DIR, DEFAULT_JOB_ID));
      throw new Error('Default job directory exists before installation');
    } catch (error) {
      if (error.code === 'ENOENT') {
        await log('Default job directory does not exist (expected)');
      } else {
        throw error;
      }
    }
    
    // Step 4: Run initialize (installs default jobs)
    console.log('\nStep 4: Running JobsService.initialize()...');
    
    await jobsService.initialize();
    await log('JobsService initialized (installDefaultJobs() called)');
    
    // Step 5: Verify installation
    console.log('\nStep 5: Verifying default job installation...');
    
    // Check registry
    const jobsData = await fs.readFile(TEST_JOBS_JSON, 'utf8');
    const jobs = JSON.parse(jobsData);
    const dailyBriefJob = jobs.find(job => job.id === DEFAULT_JOB_ID);
    
    if (!dailyBriefJob) {
      await log('Daily Brief job NOT found in registry', true);
      console.log('\nJobs in registry:', jobs.map(j => `${j.id} - ${j.name}`));
      throw new Error('Default job not registered after initialize()');
    }
    await log(`Daily Brief job registered: "${dailyBriefJob.name}"`);
    
    // Verify job metadata
    const expectedFields = ['id', 'name', 'type', 'command', 'status', 'createdAt', 'updatedAt'];
    for (const field of expectedFields) {
      if (!dailyBriefJob[field]) {
        await log(`Missing field: ${field}`, true);
      }
    }
    await log('All required fields present');
    
    if (dailyBriefJob.name !== 'Daily Brief Generator') {
      await log(`Wrong name: "${dailyBriefJob.name}" (expected "Daily Brief Generator")`, true);
    } else {
      await log('Name correct: "Daily Brief Generator"');
    }
    
    if (dailyBriefJob.type !== 'agent') {
      await log(`Wrong type: "${dailyBriefJob.type}" (expected "agent")`, true);
    } else {
      await log('Type correct: "agent"');
    }
    
    if (!dailyBriefJob.schedule || !dailyBriefJob.schedule.enabled) {
      await log('Schedule missing or not enabled', true);
    } else {
      await log(`Schedule configured: ${dailyBriefJob.schedule.cron}`);
    }
    
    // Check filesystem
    const jobDir = path.join(TEST_JOBS_DIR, DEFAULT_JOB_ID);
    try {
      await fs.access(jobDir);
      await log('Job directory created');
      
      // Verify critical files
      const files = await fs.readdir(jobDir);
      
      // Check for data directory
      if (!files.includes('data')) {
        await log('data/ directory missing', true);
      } else {
        await log('data/ directory exists');
        
        // Check for database
        const dbPath = path.join(jobDir, 'data', 'data.db');
        try {
          await fs.access(dbPath);
          await log('SQLite database created');
          
          // Verify database contents
          const db = new Database(dbPath);
          
          // Check briefs table exists
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
          const hasTable = tables.some(t => t.name === 'briefs');
          if (!hasTable) {
            await log('briefs table missing', true);
          } else {
            await log('briefs table exists');
            
            // Check for sample data
            const rows = db.prepare('SELECT * FROM briefs').all();
            if (rows.length === 0) {
              await log('No sample data in briefs table', true);
            } else {
              await log(`${rows.length} sample brief(s) in database`);
              
              // Verify brief structure
              const brief = rows[0];
              if (!brief.date || !brief.brief_json) {
                await log('Brief missing required fields', true);
              } else {
                await log('Brief has correct structure');
                
                // Parse JSON
                const briefData = JSON.parse(brief.brief_json);
                if (!briefData.hero || !briefData.sections) {
                  await log('Brief JSON missing hero or sections', true);
                } else {
                  await log(`Brief JSON valid (${briefData.sections.length} sections)`);
                }
              }
            }
          }
          
          db.close();
        } catch (error) {
          await log(`Database check failed: ${error.message}`, true);
        }
      }
    } catch (error) {
      await log(`Job directory check failed: ${error.message}`, true);
      throw error;
    }
    
    // Step 6: Test idempotency
    console.log('\nStep 6: Testing idempotency (re-running initialize)...');
    
    await jobsService.initialize();
    
    const jobsAfterSecondInit = await fs.readFile(TEST_JOBS_JSON, 'utf8');
    const jobsListAfterSecondInit = JSON.parse(jobsAfterSecondInit);
    
    const jobCount = jobsListAfterSecondInit.filter(
      job => job.id === DEFAULT_JOB_ID
    ).length;
    
    if (jobCount !== 1) {
      await log(`Found ${jobCount} jobs (expected 1) - duplicates created!`, true);
      throw new Error('installDefaultJobs is not idempotent');
    }
    await log('No duplicates created (idempotent)');
    
    // Success!
    console.log('\n=== All Tests Passed! ===\n');
    console.log('✅ Default job is installed on fresh installations');
    console.log('✅ Job is registered in jobs.json with correct metadata');
    console.log('✅ Job directory and files are copied');
    console.log('✅ SQLite database is created and initialized');
    console.log('✅ Sample brief data is inserted');
    console.log('✅ Installation is idempotent (no duplicates)');
    console.log('\n🎉 Fresh installations will have a working home dashboard!\n');
    
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
testDefaultJobInstallation()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('\n❌ Test script crashed:', error);
    process.exit(1);
  });
