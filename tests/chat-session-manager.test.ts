/**
 * Chat Session Manager Test
 * 
 * Tests parallel chat session management with multiple agents
 */

import { ChatSessionManager } from '../src/gateway/services/ChatSessionManager';
import { StorageManager } from '../src/gateway/services/StorageManager';
import type { AgentConfigInternal } from '../src/core/types/agents';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';

const TEST_DATA_PATH = path.join(os.tmpdir(), 'paprwork-v2-test-session-manager');

async function cleanup() {
  try {
    await fs.remove(TEST_DATA_PATH);
  } catch (error) {
    console.warn('Cleanup warning:', error);
  }
}

async function testSessionCreation() {
  console.log('\n🧪 Test 1: Session Creation');
  console.log('━'.repeat(50));
  
  // Create storage manager
  const storageManager = new StorageManager();
  await storageManager.initialize({
    mode: 'local',
    userDataPath: TEST_DATA_PATH,
  });
  
  const sessionManager = new ChatSessionManager(storageManager);
  
  try {
    const config: AgentConfigInternal = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: process.env.ANTHROPIC_API_KEY || 'test-key',
      systemPrompt: 'You are a helpful assistant.',
    };
    
    // Create first session
    const session1 = await sessionManager.getSession('chat-1', config);
    console.log(`✓ Created session for chat-1`);
    console.log(`  Agent: ${session1.config.provider}/${session1.config.model}`);
    console.log(`  Streaming: ${session1.isStreaming}`);
    
    // Create second session
    const session2 = await sessionManager.getSession('chat-2', config);
    console.log(`✓ Created session for chat-2`);
    
    // Verify sessions are independent
    if (session1.agent === session2.agent) {
      throw new Error('Sessions should have independent agents');
    }
    
    console.log('✓ Sessions have independent agents');
    
    // Get all sessions
    const allSessions = sessionManager.getAllActiveSessions();
    console.log(`✓ Total active sessions: ${allSessions.length}`);
    
    if (allSessions.length !== 2) {
      throw new Error(`Expected 2 sessions, got ${allSessions.length}`);
    }
    
    console.log('\n✅ Session creation test PASSED');
    
  } catch (error) {
    console.error('\n❌ Session creation test FAILED:', error);
    throw error;
  }
}

async function testSessionReuse() {
  console.log('\n🧪 Test 2: Session Reuse');
  console.log('━'.repeat(50));
  
  const storageManager = new StorageManager();
  await storageManager.initialize({
    mode: 'local',
    userDataPath: TEST_DATA_PATH,
  });
  
  const sessionManager = new ChatSessionManager(storageManager);
  
  try {
    const config: AgentConfigInternal = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
      systemPrompt: 'You are a helpful assistant.',
    };
    
    // Create session
    const session1 = await sessionManager.getSession('chat-1', config);
    console.log('✓ Created initial session');
    
    // Get same session again (should reuse)
    const session2 = await sessionManager.getSession('chat-1', config);
    console.log('✓ Retrieved session again');
    
    // Verify it's the same session
    if (session1 !== session2) {
      throw new Error('Session should be reused');
    }
    
    console.log('✓ Session was reused correctly');
    
    // Change config (should create new session)
    const newConfig: AgentConfigInternal = {
      ...config,
      model: 'claude-3-7-sonnet-20250219',
    };
    
    const session3 = await sessionManager.getSession('chat-1', newConfig);
    console.log('✓ Created new session after config change');
    
    // Verify it's a different session
    if (session1 === session3) {
      throw new Error('Session should be recreated on config change');
    }
    
    console.log('✓ Session was recreated on config change');
    
    console.log('\n✅ Session reuse test PASSED');
    
  } catch (error) {
    console.error('\n❌ Session reuse test FAILED:', error);
    throw error;
  }
}

async function testStreamingManagement() {
  console.log('\n🧪 Test 3: Streaming Management');
  console.log('━'.repeat(50));
  
  const storageManager = new StorageManager();
  await storageManager.initialize({
    mode: 'local',
    userDataPath: TEST_DATA_PATH,
  });
  
  const sessionManager = new ChatSessionManager(storageManager);
  
  try {
    const config: AgentConfigInternal = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
      systemPrompt: 'You are a helpful assistant.',
    };
    
    // Create sessions
    await sessionManager.getSession('chat-1', config);
    await sessionManager.getSession('chat-2', config);
    console.log('✓ Created 2 sessions');
    
    // Mark chat-1 as streaming
    sessionManager.setStreaming('chat-1', true);
    console.log('✓ Set chat-1 to streaming');
    
    // Check streaming status
    if (!sessionManager.isStreaming('chat-1')) {
      throw new Error('chat-1 should be streaming');
    }
    
    if (sessionManager.isStreaming('chat-2')) {
      throw new Error('chat-2 should not be streaming');
    }
    
    console.log('✓ Streaming status tracked correctly');
    
    // Get streaming sessions
    const streamingSessions = sessionManager.getStreamingSessions();
    console.log(`✓ Streaming sessions: ${streamingSessions.length}`);
    
    if (streamingSessions.length !== 1) {
      throw new Error('Expected 1 streaming session');
    }
    
    if (streamingSessions[0].chatId !== 'chat-1') {
      throw new Error('Streaming session should be chat-1');
    }
    
    // Stop streaming
    sessionManager.setStreaming('chat-1', false);
    console.log('✓ Stopped streaming for chat-1');
    
    if (sessionManager.isStreaming('chat-1')) {
      throw new Error('chat-1 should not be streaming');
    }
    
    console.log('\n✅ Streaming management test PASSED');
    
  } catch (error) {
    console.error('\n❌ Streaming management test FAILED:', error);
    throw error;
  }
}

async function testSessionClearing() {
  console.log('\n🧪 Test 4: Session Clearing');
  console.log('━'.repeat(50));
  
  const storageManager = new StorageManager();
  await storageManager.initialize({
    mode: 'local',
    userDataPath: TEST_DATA_PATH,
  });
  
  const sessionManager = new ChatSessionManager(storageManager);
  
  try {
    const config: AgentConfigInternal = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key',
      systemPrompt: 'You are a helpful assistant.',
    };
    
    // Create multiple sessions
    await sessionManager.getSession('chat-1', config);
    await sessionManager.getSession('chat-2', config);
    await sessionManager.getSession('chat-3', config);
    console.log('✓ Created 3 sessions');
    
    let count = sessionManager.getSessionCount();
    console.log(`✓ Session count: ${count}`);
    
    if (count !== 3) {
      throw new Error(`Expected 3 sessions, got ${count}`);
    }
    
    // Clear one session
    await sessionManager.clearSession('chat-2');
    console.log('✓ Cleared chat-2 session');
    
    count = sessionManager.getSessionCount();
    console.log(`✓ Session count after clear: ${count}`);
    
    if (count !== 2) {
      throw new Error(`Expected 2 sessions, got ${count}`);
    }
    
    // Clear all sessions
    await sessionManager.clearAllSessions();
    console.log('✓ Cleared all sessions');
    
    count = sessionManager.getSessionCount();
    console.log(`✓ Session count after clear all: ${count}`);
    
    if (count !== 0) {
      throw new Error(`Expected 0 sessions, got ${count}`);
    }
    
    console.log('\n✅ Session clearing test PASSED');
    
  } catch (error) {
    console.error('\n❌ Session clearing test FAILED:', error);
    throw error;
  }
}

async function testMultipleProviders() {
  console.log('\n🧪 Test 5: Multiple Providers');
  console.log('━'.repeat(50));
  
  const storageManager = new StorageManager();
  await storageManager.initialize({
    mode: 'local',
    userDataPath: TEST_DATA_PATH,
  });
  
  const sessionManager = new ChatSessionManager(storageManager);
  
  try {
    // Anthropic session
    const anthropicConfig: AgentConfigInternal = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'test-key-1',
      systemPrompt: 'You are Claude.',
    };
    
    await sessionManager.getSession('chat-anthropic', anthropicConfig);
    console.log('✓ Created Anthropic session');
    
    // OpenAI session
    const openaiConfig: AgentConfigInternal = {
      provider: 'openai',
      model: 'gpt-5.2-turbo',
      apiKey: 'test-key-2',
      systemPrompt: 'You are GPT.',
    };
    
    await sessionManager.getSession('chat-openai', openaiConfig);
    console.log('✓ Created OpenAI session');
    
    // Google session
    const googleConfig: AgentConfigInternal = {
      provider: 'google',
      model: 'gemini-2.0-flash-exp',
      apiKey: 'test-key-3',
      systemPrompt: 'You are Gemini.',
    };
    
    await sessionManager.getSession('chat-google', googleConfig);
    console.log('✓ Created Google session');
    
    // Verify all sessions exist
    const sessions = sessionManager.getAllActiveSessions();
    console.log(`✓ Total sessions: ${sessions.length}`);
    
    if (sessions.length !== 3) {
      throw new Error(`Expected 3 sessions, got ${sessions.length}`);
    }
    
    // Verify each session has correct config
    const anthropicSession = sessions.find(s => s.chatId === 'chat-anthropic');
    const openaiSession = sessions.find(s => s.chatId === 'chat-openai');
    const googleSession = sessions.find(s => s.chatId === 'chat-google');
    
    if (anthropicSession?.config.provider !== 'anthropic') {
      throw new Error('Anthropic session config mismatch');
    }
    
    if (openaiSession?.config.provider !== 'openai') {
      throw new Error('OpenAI session config mismatch');
    }
    
    if (googleSession?.config.provider !== 'google') {
      throw new Error('Google session config mismatch');
    }
    
    console.log('✓ All provider sessions configured correctly');
    
    console.log('\n✅ Multiple providers test PASSED');
    
  } catch (error) {
    console.error('\n❌ Multiple providers test FAILED:', error);
    throw error;
  }
}

// Run all tests
async function runTests() {
  console.log('\n' + '='.repeat(50));
  console.log('  CHAT SESSION MANAGER TESTS');
  console.log('='.repeat(50));
  
  try {
    await cleanup();
    
    await testSessionCreation();
    await testSessionReuse();
    await testStreamingManagement();
    await testSessionClearing();
    await testMultipleProviders();
    
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
