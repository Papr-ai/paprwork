#!/usr/bin/env node
/**
 * Fix stale running jobs - marks jobs stuck in "running" status as failed
 * Run this script if jobs show as "running" but no processes exist
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const JOBS_PATH = join(homedir(), 'Papr', 'data', 'jobs.json');
const STALE_THRESHOLD_MS = 60_000; // 60 seconds

async function fixStaleJobs() {
  console.log('🔍 Checking for stale running jobs...\n');
  
  // Read jobs
  const data = await readFile(JOBS_PATH, 'utf-8');
  const jobs = JSON.parse(data);
  
  const now = Date.now();
  let fixedCount = 0;
  const processBackedTypes = ['shell', 'bash', 'node', 'python', 'swift'];
  
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    if (!processBackedTypes.includes(job.type)) continue;
    
    const lastRun = job.lastRunAt || job.updatedAt;
    const staleMs = now - new Date(lastRun).getTime();
    const staleHours = Math.round(staleMs / 1000 / 60 / 60);
    
    if (staleMs >= STALE_THRESHOLD_MS) {
      console.log(`❌ Found stale job: ${job.name}`);
      console.log(`   ID: ${job.id}`);
      console.log(`   Type: ${job.type}`);
      console.log(`   Last run: ${lastRun} (${staleHours} hours ago)`);
      console.log(`   Marking as failed...\n`);
      
      job.status = 'failed';
      job.error = `Stale running state — the worker likely finished but Paprwork did not save completion. Check logs, then run again if needed. (Stuck for ${staleHours} hours)`;
      job.completedAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();
      job.currentExecutionId = undefined;
      
      fixedCount++;
    }
  }
  
  if (fixedCount === 0) {
    console.log('✅ No stale jobs found!');
    return;
  }
  
  // Write back
  await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2));
  
  console.log(`\n✅ Fixed ${fixedCount} stale job(s)!`);
  console.log('\n⚠️  IMPORTANT: Restart Paprwork for changes to take effect.');
  console.log('   The app caches job state in memory.\n');
}

fixStaleJobs().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
