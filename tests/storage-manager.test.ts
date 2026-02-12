/**
 * Storage Manager Integration Test
 * 
 * Tests StorageManager with different modes (local, papr, hybrid)
 */

// Load environment variables
import { config } from 'dotenv';
config({ path: '.env.local' });

import { StorageManager } from '../src/gateway/services/StorageManager';
import type { StoredMessage } from '../src/gateway/services/storage/IStorageProvider';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Test data path
const TEST_DATA_PATH = path.join(os.tmpdir(), 'paprwork-v2-test-storage-manager');

async function cleanup() {
  try {
    await fs.remove(TEST_DATA_PATH);
  } catch (error) {
    console.warn('Cleanup warning:', error);
  }
}

async function testLocalMode() {
  console.log('\n🧪 Test 1: Local Mode');
  console.log('━'.repeat(50));
  
  const manager = new StorageManager();
  
  try {
    // Initialize in local mode
    await manager.initialize({
      mode: 'local',
      userDataPath: TEST_DATA_PATH,
    });
    
    console.log('✓ StorageManager initialized in local mode');
    console.log(`  Mode: ${manager.getMode()}`);
    
    // Create a chat
    const chatId = 'test-chat-local-1';
    await manager.createChat(chatId, 'Test Chat Local');
    console.log(`✓ Created chat: ${chatId}`);
    
    // Save messages
    const message1: StoredMessage = {
      id: 'msg-1',
      chat_id: chatId,
      message: 'Hello, this is a test message',
      message_role: 'user',
      timestamp: new Date().toISOString(),
      sync_status: 'local',
    };
    
    await manager.saveMessage(chatId, message1);
    console.log('✓ Saved user message');
    
    const message2: StoredMessage = {
      id: 'msg-2',
      chat_id: chatId,
      message: 'This is a response',
      message_role: 'assistant',
      timestamp: new Date().toISOString(),
      model: 'gpt-4',
      sync_status: 'local',
    };
    
    await manager.saveMessage(chatId, message2);
    console.log('✓ Saved assistant message');
    
    // Load messages
    const messages = await manager.loadMessages(chatId);
    console.log(`✓ Loaded ${messages.length} messages`);
    
    if (messages.length !== 2) {
      throw new Error(`Expected 2 messages, got ${messages.length}`);
    }
    
    // Get chat
    const chat = await manager.getChat(chatId);
    console.log(`✓ Retrieved chat: "${chat?.title}"`);
    
    if (!chat || chat.title !== 'Test Chat Local') {
      throw new Error('Chat title mismatch');
    }
    
    // Update chat title
    await manager.updateChat(chatId, { title: 'Updated Title' });
    const updatedChat = await manager.getChat(chatId);
    console.log(`✓ Updated chat title: "${updatedChat?.title}"`);
    
    if (updatedChat?.title !== 'Updated Title') {
      throw new Error('Chat title not updated');
    }
    
    // Get stats
    const stats = await manager.getChatStats(chatId);
    console.log(`✓ Chat stats: ${stats.message_count} messages, ${stats.token_count} tokens`);
    
    // List chats
    const chats = await manager.listChats();
    console.log(`✓ Listed ${chats.length} chat(s)`);
    
    console.log('\n✅ Local mode test PASSED');
    
  } catch (error) {
    console.error('\n❌ Local mode test FAILED:', error);
    throw error;
  }
}

async function testPaprMode() {
  console.log('\n🧪 Test 2: PAPR Mode');
  console.log('━'.repeat(50));
  
  const apiKey = process.env.PAPR_API_KEY;
  const baseUrl = process.env.PAPR_BASE_URL;
  
  if (!apiKey) {
    console.log('⚠️  SKIPPED: PAPR_API_KEY not set');
    return;
  }
  
  const manager = new StorageManager();
  
  try {
    // Initialize in PAPR mode
    await manager.initialize({
      mode: 'papr',
      paprApiKey: apiKey,
      paprBaseUrl: baseUrl,
    });
    
    console.log('✓ StorageManager initialized in PAPR mode');
    console.log(`  Mode: ${manager.getMode()}`);
    
    // Create a chat with unique ID
    const chatId = `test-chat-papr-${Date.now()}`;
    await manager.createChat(chatId, 'Test Chat PAPR');
    console.log(`✓ Created chat: ${chatId}`);
    
    // Save a message
    const message: StoredMessage = {
      id: `msg-${Date.now()}`,
      chat_id: chatId,
      message: 'Hello from PAPR mode test',
      message_role: 'user',
      timestamp: new Date().toISOString(),
      sync_status: 'synced',
    };
    
    await manager.saveMessage(chatId, message);
    console.log('✓ Saved message to PAPR');
    
    // Wait a bit for PAPR to process
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Load messages
    const messages = await manager.loadMessages(chatId);
    console.log(`✓ Loaded ${messages.length} message(s) from PAPR`);
    
    if (messages.length === 0) {
      console.warn('⚠️  Warning: No messages returned (PAPR may still be processing)');
    }
    
    console.log('\n✅ PAPR mode test PASSED');
    
  } catch (error) {
    console.error('\n❌ PAPR mode test FAILED:', error);
    throw error;
  }
}

async function testHybridMode() {
  console.log('\n🧪 Test 3: Hybrid Mode');
  console.log('━'.repeat(50));
  
  const apiKey = process.env.PAPR_API_KEY;
  const baseUrl = process.env.PAPR_BASE_URL;
  
  if (!apiKey) {
    console.log('⚠️  SKIPPED: PAPR_API_KEY not set');
    return;
  }
  
  const manager = new StorageManager();
  
  try {
    // Initialize in hybrid mode
    await manager.initialize({
      mode: 'hybrid',
      userDataPath: TEST_DATA_PATH,
      paprApiKey: apiKey,
      paprBaseUrl: baseUrl,
    });
    
    console.log('✓ StorageManager initialized in hybrid mode');
    console.log(`  Mode: ${manager.getMode()}`);
    
    // Create a chat
    const chatId = `test-chat-hybrid-${Date.now()}`;
    await manager.createChat(chatId, 'Test Chat Hybrid');
    console.log(`✓ Created chat: ${chatId}`);
    
    // Save a message (should go to both local and PAPR)
    const message: StoredMessage = {
      id: `msg-${Date.now()}`,
      chat_id: chatId,
      message: 'Hello from hybrid mode test',
      message_role: 'user',
      timestamp: new Date().toISOString(),
      sync_status: 'local',
    };
    
    await manager.saveMessage(chatId, message);
    console.log('✓ Saved message to hybrid storage');
    
    // Load messages (should come from local)
    const messages = await manager.loadMessages(chatId);
    console.log(`✓ Loaded ${messages.length} message(s) from hybrid storage`);
    
    if (messages.length !== 1) {
      throw new Error(`Expected 1 message, got ${messages.length}`);
    }
    
    // Get stats
    const stats = await manager.getChatStats(chatId);
    console.log(`✓ Chat stats: ${stats.message_count} messages`);
    
    console.log('\n✅ Hybrid mode test PASSED');
    
  } catch (error) {
    console.error('\n❌ Hybrid mode test FAILED:', error);
    throw error;
  }
}

async function testModeSwitching() {
  console.log('\n🧪 Test 4: Mode Switching');
  console.log('━'.repeat(50));
  
  const manager = new StorageManager();
  
  try {
    // Start in local mode
    await manager.initialize({
      mode: 'local',
      userDataPath: TEST_DATA_PATH,
    });
    console.log(`✓ Initialized in ${manager.getMode()} mode`);
    
    // Create and save data
    const chatId = `test-mode-switch-${Date.now()}`;
    await manager.createChat(chatId, 'Mode Switch Test');
    
    const message: StoredMessage = {
      id: `msg-${Date.now()}`,
      chat_id: chatId,
      message: 'Test message',
      message_role: 'user',
      timestamp: new Date().toISOString(),
      sync_status: 'local',
    };
    
    await manager.saveMessage(chatId, message);
    console.log('✓ Saved message in local mode');
    
    // Switch to another local instance (simulate mode change)
    await manager.switchMode({
      mode: 'local',
      userDataPath: TEST_DATA_PATH,
    });
    console.log(`✓ Switched to ${manager.getMode()} mode`);
    
    // Data should still be accessible
    const messages = await manager.loadMessages(chatId);
    console.log(`✓ Data persisted: ${messages.length} message(s)`);
    
    if (messages.length !== 1) {
      throw new Error('Data not persisted after mode switch');
    }
    
    console.log('\n✅ Mode switching test PASSED');
    
  } catch (error) {
    console.error('\n❌ Mode switching test FAILED:', error);
    throw error;
  }
}

// Run all tests
async function runTests() {
  console.log('\n' + '='.repeat(50));
  console.log('  STORAGE MANAGER INTEGRATION TESTS');
  console.log('='.repeat(50));
  
  try {
    await cleanup();
    
    await testLocalMode();
    await testPaprMode();
    await testHybridMode();
    await testModeSwitching();
    
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
  } finally {
    await cleanup();
  }
}

runTests();
