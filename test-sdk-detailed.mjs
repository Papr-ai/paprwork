import Papr from '@papr/memory';

const chatId = '444e1d63-1759-4d1c-a88d-903e01be186b';
const apiKey = 'sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I';

const client = new Papr({
  xAPIKey: apiKey,
  maxRetries: 3,
  timeout: 30000,
});

console.log('\n' + '='.repeat(80));
console.log('Testing Papr SDK with limit=100 (what Paprwork uses)');
console.log('='.repeat(80) + '\n');

// First, let's see what the raw API returns
console.log('Making API call...\n');

const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

console.log(`Total count reported: ${response.total_count}`);
console.log(`Messages returned: ${response.messages.length}\n`);

// Analyze roles
const roleCount = response.messages.reduce((acc, m) => {
  acc[m.role] = (acc[m.role] || 0) + 1;
  return acc;
}, {});

console.log('Role distribution:', roleCount);

// Show first and last few messages
console.log('\nFirst 3 messages:');
response.messages.slice(0, 3).forEach((m, i) => {
  const ts = m.timestamp || m.createdAt;
  const preview = (m.content?.substring?.(0, 50) || JSON.stringify(m.content).substring(0, 50)) + '...';
  console.log(`  [${i}] ${m.role.padEnd(10)} ${ts} - "${preview}"`);
});

console.log('\nLast 3 messages:');
response.messages.slice(-3).forEach((m, i) => {
  const ts = m.timestamp || m.createdAt;
  const preview = (m.content?.substring?.(0, 50) || JSON.stringify(m.content).substring(0, 50)) + '...';
  console.log(`  [${response.messages.length - 3 + i}] ${m.role.padEnd(10)} ${ts} - "${preview}"`);
});

// Check for gaps in timestamps
console.log('\nChecking for timestamp gaps (potential missing messages)...');
const timestamps = response.messages.map(m => new Date(m.timestamp || m.createdAt).getTime());
const sortedTs = [...timestamps].sort((a, b) => b - a); // newest first

for (let i = 0; i < sortedTs.length - 1; i++) {
  const gap = sortedTs[i] - sortedTs[i+1];
  if (gap > 60000) { // Gap > 1 minute
    const gapMinutes = (gap / 60000).toFixed(1);
    console.log(`  ⚠️  ${gapMinutes} minute gap between message ${i} and ${i+1}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('CONCLUSION:');
console.log('='.repeat(80));
console.log(`Expected: 12 messages (6 user + 6 assistant)`);
console.log(`Got: ${response.messages.length} messages (${roleCount.user || 0} user + ${roleCount.assistant || 0} assistant)`);
console.log(`Missing: ${12 - response.messages.length} messages (${6 - (roleCount.assistant || 0)} assistant)`);
console.log('='.repeat(80) + '\n');
