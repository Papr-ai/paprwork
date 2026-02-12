#!/usr/bin/env tsx
/**
 * Test LocalStorageProvider with SQLite
 * Tests schema creation, CRUD operations, and data integrity
 */
import { LocalStorageProvider } from '../src/gateway/services/storage/LocalStorageProvider';
import type { StoredMessage } from '../src/gateway/services/storage/IStorageProvider';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

const TEST_DATA_PATH = path.join(os.tmpdir(), `paprwork-test-${Date.now()}`);
const TEST_CHAT_ID = `local-test-${Date.now()}`;

async function testLocalStorage() {
  console.log('🧪 Testing LocalStorageProvider with SQLite\n');
  console.log(`📁 Test database path: ${TEST_DATA_PATH}\n`);

  try {
    // Clean up test directory if it exists
    await fs.remove(TEST_DATA_PATH);

    // Initialize provider
    console.log('📝 Test 1: Initializing LocalStorageProvider...');
    const provider = new LocalStorageProvider(TEST_DATA_PATH);
    await provider.initialize();
    console.log('✓ Provider initialized');
    console.log(`✓ Database file created: ${path.join(TEST_DATA_PATH, 'chats.db')}`);
    
    // Verify database file exists
    const dbExists = await fs.pathExists(path.join(TEST_DATA_PATH, 'chats.db'));
    if (!dbExists) {
      throw new Error('Database file was not created!');
    }
    console.log('✓ Database file verified\n');

    // Test 2: Create a chat
    console.log('📝 Test 2: Creating a new chat...');
    await provider.createChat(TEST_CHAT_ID, 'Test Chat - React Development');
    console.log(`✓ Chat created with ID: ${TEST_CHAT_ID}\n`);

    // Test 3: Save messages
    console.log('📝 Test 3: Saving messages...');
    const messages: StoredMessage[] = [
      {
        id: 'msg-1',
        message_role: 'user',
        content: 'How do I use React hooks?',
        timestamp: new Date().toISOString(),
        sync_status: 'local',
      },
      {
        id: 'msg-2',
        message_role: 'assistant',
        content: 'React hooks like useState and useEffect allow you to use state and lifecycle features in functional components.',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        sync_status: 'local',
      },
      {
        id: 'msg-3',
        message_role: 'user',
        content: 'Can you show me an example?',
        timestamp: new Date(Date.now() + 2000).toISOString(),
        sync_status: 'local',
      },
    ];

    for (const msg of messages) {
      await provider.saveMessage(TEST_CHAT_ID, msg);
      console.log(`✓ Saved message: ${msg.id} [${msg.message_role}]`);
    }
    console.log('');

    // Test 4: Load messages
    console.log('📝 Test 4: Loading messages...');
    const loadedMessages = await provider.loadMessages(TEST_CHAT_ID);
    console.log(`✓ Loaded ${loadedMessages.length} message(s)`);
    
    if (loadedMessages.length !== messages.length) {
      throw new Error(`Expected ${messages.length} messages, got ${loadedMessages.length}`);
    }
    
    loadedMessages.forEach((msg, idx) => {
      console.log(`   ${idx + 1}. [${msg.message_role}]: ${msg.content?.substring(0, 50)}...`);
    });
    console.log('');

    // Test 5: Chat stats
    console.log('📝 Test 5: Getting chat stats...');
    const stats = await provider.getChatStats(TEST_CHAT_ID);
    console.log(`✓ Message count: ${stats.message_count}`);
    console.log(`✓ Token count: ${stats.token_count}`);
    console.log(`✓ Has summary: ${stats.has_summary}\n`);

    // Test 6: Chat metadata
    console.log('📝 Test 6: Getting chat metadata...');
    const metadata = await provider.getChat(TEST_CHAT_ID);
    if (!metadata) {
      throw new Error('Chat metadata not found!');
    }
    console.log(`✓ Title: ${metadata.title}`);
    console.log(`✓ Created: ${metadata.created_at}`);
    console.log(`✓ Message count: ${metadata.message_count}\n`);

    // Test 7: List all chats
    console.log('📝 Test 7: Listing all chats...');
    const allChats = await provider.listChats();
    console.log(`✓ Found ${allChats.length} chat(s)`);
    allChats.forEach((chat, idx) => {
      console.log(`   ${idx + 1}. ${chat.title} (${chat.message_count} messages)`);
    });
    console.log('');

    // Test 8: Update chat title
    console.log('📝 Test 8: Updating chat title...');
    await provider.updateChat(TEST_CHAT_ID, { title: 'Updated Title - React Hooks' });
    const updatedChat = await provider.getChat(TEST_CHAT_ID);
    console.log(`✓ Title updated to: ${updatedChat?.title}\n`);

    // Test 9: Save a summary
    console.log('📝 Test 9: Saving a summary...');
    const summary = {
      short_term: 'User asking about React hooks. Assistant explaining useState and useEffect.',
      medium_term: 'Conversation about React hooks and their usage in functional components.',
      long_term: 'Complete discussion about React hooks including useState, useEffect, and practical examples.',
      topics: ['React', 'Hooks', 'useState', 'useEffect'],
      last_updated: new Date().toISOString(),
      fetched_from_papr: false,
      last_fetched_at: new Date().toISOString(),
    };
    await provider.saveSummary(TEST_CHAT_ID, summary);
    console.log('✓ Summary saved\n');

    // Test 10: Load summary
    console.log('📝 Test 10: Loading summary...');
    const loadedSummary = await provider.getSummary(TEST_CHAT_ID);
    if (!loadedSummary) {
      throw new Error('Summary not found!');
    }
    console.log(`✓ Short term: ${loadedSummary.short_term}`);
    console.log(`✓ Topics: ${loadedSummary.topics?.join(', ')}\n`);

    // Test 11: Delete chat
    console.log('📝 Test 11: Deleting chat...');
    await provider.deleteChat(TEST_CHAT_ID);
    const deletedChat = await provider.getChat(TEST_CHAT_ID);
    if (deletedChat) {
      throw new Error('Chat was not deleted!');
    }
    console.log('✓ Chat deleted successfully\n');

    console.log('✅ All LocalStorageProvider tests passed!\n');

    // Test 12: Verify database schema
    console.log('📝 Test 12: Verifying database schema...');
    const db = (provider as any).db;
    
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('✓ Tables created:');
    tables.forEach((table: any) => {
      console.log(`   - ${table.name}`);
    });
    
    const chatColumns = db.prepare("PRAGMA table_info(chats)").all();
    console.log('\n✓ Chats table columns:');
    chatColumns.forEach((col: any) => {
      console.log(`   - ${col.name} (${col.type})`);
    });
    
    const messageColumns = db.prepare("PRAGMA table_info(messages)").all();
    console.log('\n✓ Messages table columns:');
    messageColumns.forEach((col: any) => {
      console.log(`   - ${col.name} (${col.type})`);
    });

    console.log('\n✅ Database schema verified!\n');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await fs.remove(TEST_DATA_PATH);
    console.log('✓ Test data cleaned up\n');

    console.log('🎉 All tests completed successfully!');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    
    // Cleanup on error
    try {
      await fs.remove(TEST_DATA_PATH);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    
    process.exit(1);
  }
}

testLocalStorage().catch(console.error);
