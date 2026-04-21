import Papr from '@papr/memory';

const chatId = '444e1d63-1759-4d1c-a88d-903e01be186b';
const apiKey = 'sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I';

const client = new Papr({
  xAPIKey: apiKey,
  maxRetries: 3,
  timeout: 30000,
});

// Test with different limits
for (const limit of [10, 50, 100]) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing with limit=${limit}`);
  console.log('='.repeat(80));
  
  const response = await client.messages.sessions.retrieveHistory(chatId, { limit });
  
  const roleCount = response.messages.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});
  
  console.log(`Retrieved: ${response.messages.length}/${response.total_count} messages`);
  console.log(`Role distribution:`, roleCount);
  console.log(`\nAll messages:`);
  response.messages.forEach((m, i) => {
    const ts = m.timestamp || m.createdAt;
    console.log(`  [${i}] ${m.role.padEnd(10)} ${ts}`);
  });
}
