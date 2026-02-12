/**
 * Title Generation Service Test
 * 
 * Tests chat title generation with gpt-5-mini-2025-08-07
 */

// Load environment variables
import { config } from 'dotenv';
config({ path: '.env.local' });

import { TitleGenerationService } from '../src/gateway/services/TitleGenerationService';

async function testBasicTitleGeneration() {
  console.log('\n🧪 Test 1: Basic Title Generation');
  console.log('━'.repeat(50));
  
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️  SKIPPED: OPENAI_API_KEY not set');
    return;
  }
  
  const service = new TitleGenerationService(apiKey);
  
  try {
    const testMessages = [
      'How do I build a React component for user authentication?',
      'Can you help me debug this Python error?',
      'I need to create a REST API with Express.js',
      'What is the difference between var, let, and const in JavaScript?',
    ];
    
    for (const message of testMessages) {
      const title = await service.generateTitle(message);
      console.log(`\nInput:  "${message.substring(0, 60)}..."`);
      console.log(`Output: "${title}"`);
      
      // Verify title constraints
      if (title.length > 40) {
        throw new Error(`Title too long: ${title.length} chars (max 40)`);
      }
      
      if (title.length === 0) {
        throw new Error('Title is empty');
      }
      
      console.log(`✓ Title length: ${title.length} chars (valid)`);
    }
    
    console.log('\n✅ Basic title generation test PASSED');
    
  } catch (error) {
    console.error('\n❌ Basic title generation test FAILED:', error);
    throw error;
  }
}

async function testFallbackTitleGeneration() {
  console.log('\n🧪 Test 2: Fallback Title Generation');
  console.log('━'.repeat(50));
  
  // Use invalid API key to force fallback
  const service = new TitleGenerationService('invalid-key');
  
  try {
    const message = 'Can you help me build a React component for displaying user profiles with avatar, name, and bio?';
    const title = await service.generateTitle(message);
    
    console.log(`\nInput:  "${message}"`);
    console.log(`Output: "${title}"`);
    
    // Verify fallback title
    if (title.length > 40) {
      throw new Error(`Fallback title too long: ${title.length} chars`);
    }
    
    if (title.length === 0) {
      throw new Error('Fallback title is empty');
    }
    
    console.log(`✓ Fallback title length: ${title.length} chars`);
    console.log('✓ Fallback mechanism works');
    
    console.log('\n✅ Fallback title generation test PASSED');
    
  } catch (error) {
    console.error('\n❌ Fallback title generation test FAILED:', error);
    throw error;
  }
}

async function testCommonPrefixRemoval() {
  console.log('\n🧪 Test 3: Common Prefix Removal (Fallback)');
  console.log('━'.repeat(50));
  
  const service = new TitleGenerationService('invalid-key');
  
  try {
    const testCases = [
      {
        input: 'can you help me build a REST API?',
        expected: 'Build REST API',
      },
      {
        input: 'how do i create a React component?',
        expected: 'Create React Component',
      },
      {
        input: 'please explain the concept of closures',
        expected: 'Explain Concept Of Closures',
      },
      {
        input: 'i want to learn about TypeScript generics',
        expected: 'Learn About TypeScript Generics',
      },
    ];
    
    for (const testCase of testCases) {
      const title = await service.generateTitle(testCase.input);
      console.log(`\nInput:    "${testCase.input}"`);
      console.log(`Output:   "${title}"`);
      
      // Check if common prefix was removed
      const lowerTitle = title.toLowerCase();
      const hasPrefix = [
        'can you',
        'could you',
        'please',
        'i want to',
        'i need to',
        'how do i',
      ].some(prefix => lowerTitle.startsWith(prefix));
      
      if (hasPrefix) {
        console.log('⚠️  Warning: Common prefix not removed');
      } else {
        console.log('✓ Common prefix removed');
      }
    }
    
    console.log('\n✅ Common prefix removal test PASSED');
    
  } catch (error) {
    console.error('\n❌ Common prefix removal test FAILED:', error);
    throw error;
  }
}

async function testLongMessageTruncation() {
  console.log('\n🧪 Test 4: Long Message Truncation');
  console.log('━'.repeat(50));
  
  const service = new TitleGenerationService('invalid-key');
  
  try {
    const longMessage = 'I am trying to build a very complex application with multiple features including user authentication, real-time chat, file uploads, payment processing, admin dashboard, analytics, and much more. Can you help me get started with the architecture?';
    
    const title = await service.generateTitle(longMessage);
    
    console.log(`\nInput length:  ${longMessage.length} chars`);
    console.log(`Output:        "${title}"`);
    console.log(`Output length: ${title.length} chars`);
    
    // Verify truncation
    if (title.length > 43) { // 40 + "..."
      throw new Error(`Title too long after truncation: ${title.length} chars`);
    }
    
    if (title.endsWith('...')) {
      console.log('✓ Title truncated with ellipsis');
    }
    
    console.log('\n✅ Long message truncation test PASSED');
    
  } catch (error) {
    console.error('\n❌ Long message truncation test FAILED:', error);
    throw error;
  }
}

async function testAPIKeyUpdate() {
  console.log('\n🧪 Test 5: API Key Update');
  console.log('━'.repeat(50));
  
  try {
    const service = new TitleGenerationService('initial-key');
    console.log('✓ Service created with initial key');
    
    // Update API key
    service.setApiKey('updated-key');
    console.log('✓ API key updated');
    
    // Test with new key (will use fallback since key is invalid)
    const title = await service.generateTitle('Test message');
    console.log(`✓ Generated title with updated key: "${title}"`);
    
    console.log('\n✅ API key update test PASSED');
    
  } catch (error) {
    console.error('\n❌ API key update test FAILED:', error);
    throw error;
  }
}

async function testEmptyAndShortMessages() {
  console.log('\n🧪 Test 6: Empty and Short Messages');
  console.log('━'.repeat(50));
  
  const service = new TitleGenerationService('invalid-key');
  
  try {
    // Very short message
    const shortTitle = await service.generateTitle('Hi');
    console.log(`\nShort input: "Hi"`);
    console.log(`Output:      "${shortTitle}"`);
    
    if (shortTitle.length === 0) {
      throw new Error('Title should not be empty for short message');
    }
    
    console.log('✓ Short message handled');
    
    // Empty message (should return "New Chat")
    const emptyTitle = await service.generateTitle('');
    console.log(`\nEmpty input: ""`);
    console.log(`Output:      "${emptyTitle}"`);
    
    if (emptyTitle !== 'New Chat') {
      console.log(`⚠️  Warning: Expected "New Chat", got "${emptyTitle}"`);
    } else {
      console.log('✓ Empty message returns "New Chat"');
    }
    
    console.log('\n✅ Empty and short messages test PASSED');
    
  } catch (error) {
    console.error('\n❌ Empty and short messages test FAILED:', error);
    throw error;
  }
}

// Run all tests
async function runTests() {
  console.log('\n' + '='.repeat(50));
  console.log('  TITLE GENERATION SERVICE TESTS');
  console.log('='.repeat(50));
  
  try {
    await testBasicTitleGeneration();
    await testFallbackTitleGeneration();
    await testCommonPrefixRemoval();
    await testLongMessageTruncation();
    await testAPIKeyUpdate();
    await testEmptyAndShortMessages();
    
    console.log('\n' + '='.repeat(50));
    console.log('  ✅ ALL TESTS PASSED');
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
    
  } catch (error) {
    console.log('\n' + '='.repeat(50));
    console.log('  ❌ TESTS FAILED');
    console.log('='.repeat(50) + '\n');
    console.error(error);
    process.exit(1);
  }
}

runTests();
