#!/usr/bin/env node

/**
 * Test script to directly call PAPR API and inspect message retrieval
 */

import Papr from '@papr/memory';

const chatId = '444e1d63-1759-4d1c-a88d-903e01be186b';
const apiKey = 'sk-org-Y8D4H7Yp3Z-namespace-onnNQFe3DN-ZKza5sLT03qW8GVdhhj1MzHyjBL21w6I';

console.log(`✓ Using provided API key`);
console.log(`Chat ID: ${chatId}`);
console.log('');

const client = new Papr({
  xAPIKey: apiKey,
  maxRetries: 3,
  timeout: 30000,
});

try {
  console.log('Calling PAPR API: retrieveHistory()');
  console.log('─'.repeat(80));
  
  const response = await client.messages.sessions.retrieveHistory(chatId);
  
  console.log(`✓ Retrieved ${response.messages?.length || 0} messages`);
  console.log(`  Total count: ${response.total_count}`);
  console.log(`  Has summary: ${!!response.summaries}`);
  console.log(`  Context for LLM: ${response.context_for_llm}`);
  console.log('');
  
  if (response.messages && response.messages.length > 0) {
    console.log('MESSAGE BREAKDOWN:');
    console.log('─'.repeat(80));
    
    // Count by role
    const roleCount = response.messages.reduce((acc, m) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {});
    
    console.log('Role distribution:', roleCount);
    console.log('');
    
    // Show all messages
    console.log('ALL MESSAGES (in order returned by PAPR):');
    console.log('─'.repeat(80));
    response.messages.forEach((m, i) => {
      const timestamp = m.timestamp || m.createdAt;
      const contentPreview = typeof m.content === 'string' 
        ? m.content.substring(0, 60) 
        : JSON.stringify(m.content).substring(0, 60);
      
      console.log(`[${i}] ${m.role.padEnd(10)} ${timestamp}  ${contentPreview}...`);
    });
    console.log('');
    
    // Show summary if present
    if (response.summaries) {
      console.log('SUMMARY:');
      console.log('─'.repeat(80));
      console.log('Short term:', response.summaries.short_term?.substring(0, 100) + '...');
      console.log('Medium term:', response.summaries.medium_term?.substring(0, 100) + '...');
      console.log('Long term:', response.summaries.long_term?.substring(0, 100) + '...');
      console.log('Topics:', response.summaries.topics?.join(', '));
      console.log('');
    }
    
    // Check for recent assistant messages
    console.log('RECENT ASSISTANT MESSAGES (last 5):');
    console.log('─'.repeat(80));
    const assistantMessages = response.messages.filter(m => m.role === 'assistant');
    
    if (assistantMessages.length === 0) {
      console.log('⚠️  NO ASSISTANT MESSAGES FOUND!');
      console.log('This is the problem - PAPR is not returning assistant messages');
    } else {
      console.log(`Found ${assistantMessages.length} assistant messages total`);
      assistantMessages.slice(-5).forEach((m, i) => {
        const timestamp = m.timestamp || m.createdAt;
        const contentPreview = typeof m.content === 'string' 
          ? m.content.substring(0, 100) 
          : JSON.stringify(m.content).substring(0, 100);
        
        console.log(`[${i}] ${timestamp}`);
        console.log(`    ${contentPreview}...`);
        console.log('');
      });
    }
    
  } else {
    console.log('⚠️  No messages returned!');
  }
  
} catch (error) {
  console.error('❌ PAPR API Error:', error);
  if (error.response) {
    console.error('Response status:', error.response.status);
    console.error('Response data:', error.response.data);
  }
  process.exit(1);
}
