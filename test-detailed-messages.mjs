import Papr from '@papr/memory';

const apiKey = "sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I";
const client = new Papr({ xAPIKey: apiKey });
const chatId = '95992479-4fe0-4acb-883d-5cbea7de5eb7';

const response = await client.messages.sessions.retrieveHistory(chatId, { limit: 100 });

console.log(`\nTotal in PAPR: ${response.total_count}`);
console.log(`Returned: ${response.messages.length}\n`);

console.log('=== ALL MESSAGES (newest first from PAPR) ===\n');
response.messages.forEach((m, i) => {
  const contentPreview = typeof m.content === 'string' 
    ? m.content.substring(0, 100)
    : `Array[${m.content?.length || 0}] - ${JSON.stringify(m.content[0] || {}).substring(0, 80)}`;
  console.log(`[${i}] ${m.role.padEnd(10)} | ${m.createdAt} | ${contentPreview}...`);
});

console.log('\n=== Taking FIRST 6 (newest) ===\n');
const newest6 = response.messages.slice(0, 6);
newest6.forEach((m, i) => {
  const contentPreview = typeof m.content === 'string' 
    ? m.content.substring(0, 100)
    : `Array[${m.content?.length || 0}]`;
  console.log(`[${i}] ${m.role.padEnd(10)} | ${contentPreview}...`);
});

console.log('\n=== Reversed (chronological for LLM) ===\n');
newest6.reverse().forEach((m, i) => {
  const contentPreview = typeof m.content === 'string' 
    ? m.content.substring(0, 100)
    : `Array[${m.content?.length || 0}]`;
  console.log(`[${i}] ${m.role.padEnd(10)} | ${contentPreview}...`);
});
