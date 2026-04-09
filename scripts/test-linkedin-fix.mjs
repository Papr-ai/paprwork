#!/usr/bin/env node
/**
 * Test script to manually trigger job graph rebuild and verify LinkedIn Autopilot fix
 */

import { getJobsService } from '../dist/gateway/services/JobsService.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

console.log('[Test] Starting LinkedIn Autopilot fix verification...\n');

// Initialize and get job graph
const jobsService = getJobsService();
await jobsService.initialize();

console.log('[Test] Jobs service initialized');

// Force rebuild
console.log('[Test] Forcing job graph rebuild...');
await jobsService['rebuildGraph']();

// Wait for async operations
await new Promise(resolve => setTimeout(resolve, 2000));

// Read the rebuilt graph
const graphPath = join(homedir(), 'Papr', 'data', 'job-graph.json');
const graph = JSON.parse(readFileSync(graphPath, 'utf8'));

// Find LinkedIn Autopilot app
const linkedInApp = Object.entries(graph.appLinks).find(
  ([_, app]) => app.name === 'LinkedIn Autopilot'
);

if (!linkedInApp) {
  console.error('[Test] ❌ LinkedIn Autopilot app not found in graph!');
  process.exit(1);
}

const [appId, appData] = linkedInApp;
console.log(`\n[Test] LinkedIn Autopilot app ID: ${appId}`);
console.log(`[Test] Linked job count: ${appData.jobIds.length}`);

// Count actual jobs with LinkedIn Autopilot folder
const jobsPath = join(homedir(), 'Papr', 'data', 'jobs.json');
const jobs = JSON.parse(readFileSync(jobsPath, 'utf8'));
const linkedInJobs = Object.values(jobs).filter(
  (job) => job.folder === 'LinkedIn Autopilot'
);

console.log(`[Test] Expected job count (from jobs.json): ${linkedInJobs.length}`);

// Verify
if (appData.jobIds.length === linkedInJobs.length) {
  console.log(`\n[Test] ✅ SUCCESS! All ${linkedInJobs.length} LinkedIn Autopilot jobs are linked!`);
  console.log('\n[Test] Linked jobs:');
  appData.jobIds.forEach((jobId, i) => {
    const job = jobs[jobId];
    console.log(`  ${i + 1}. ${job?.name || jobId}`);
  });
} else {
  console.log(`\n[Test] ❌ FAILED! Expected ${linkedInJobs.length} jobs but got ${appData.jobIds.length}`);
  console.log('\n[Test] Missing jobs:');
  linkedInJobs.forEach(job => {
    if (!appData.jobIds.includes(job.id)) {
      console.log(`  - ${job.name} (${job.id})`);
    }
  });
}

process.exit(0);
