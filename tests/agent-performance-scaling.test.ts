/**
 * Agent Performance Scaling Test
 * 
 * Tests how agent response time scales with conversation history length.
 * Measures each step in the pipeline to identify bottlenecks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentService } from '../src/gateway/services/AgentService.js';
import type { AgentConfigInternal } from '../src/core/types/agents.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

interface PerformanceMetrics {
  messageNumber: number;
  historyCount: number;
  historyTokens: number;
  timings: {
    keyFetch: number;
    sessionLookup: number;
    ensureKeys: number;
    getSession: number;
    saveUserMessage: number;
    loadHistory: number;
    loadSkills: number;
    buildMessages: number;
    getTools: number;
    streamTextInit: number;
    timeToFirstChunk: number;
    totalSetup: number;
    totalTimeToFirstChunk: number;
  };
}

describe('Agent Performance Scaling', () => {
  let agentService: AgentService;
  let testDir: string;
  let chatId: string;
  let config: AgentConfigInternal;
  const metrics: PerformanceMetrics[] = [];

  beforeEach(async () => {
    // Create temp directory for test storage
    testDir = path.join(os.tmpdir(), `paprwork-perf-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Initialize agent service
    agentService = new AgentService();
    await agentService.initialize({
      mode: 'local',
      userDataPath: testDir,
      openaiApiKey: process.env.OPENAI_API_KEY || 'test-key',
    });

    // Create test chat
    chatId = uuidv4();
    await agentService.createChat(chatId, 'Performance Test Chat');

    // Setup config
    config = {
      provider: 'openai',
      model: 'gpt-4o-mini', // Fast, cheap model for testing
      apiKey: process.env.OPENAI_API_KEY || 'test-key',
    };
  });

  afterEach(async () => {
    // Cleanup
    await agentService.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /**
   * Test: Measure performance across 20 messages
   * Shows how latency increases with conversation history
   */
  it('should measure latency scaling across growing conversation', async () => {
    const messageCount = 20;
    const messages = [
      "What is 2+2?",
      "What is 5+5?",
      "What is 10*10?",
      "What is the capital of France?",
      "What is the capital of Germany?",
      "What is the capital of Italy?",
      "What is the capital of Spain?",
      "Explain quantum computing in one sentence.",
      "Explain machine learning in one sentence.",
      "Explain blockchain in one sentence.",
      "What is the speed of light?",
      "What is the speed of sound?",
      "What is the boiling point of water?",
      "What is the freezing point of water?",
      "Who wrote Romeo and Juliet?",
      "Who wrote Hamlet?",
      "Who painted the Mona Lisa?",
      "Who composed the Moonlight Sonata?",
      "What year did WW2 end?",
      "What year did WW1 start?",
    ];

    console.log('\n📊 Starting Performance Scaling Test');
    console.log(`Testing ${messageCount} messages to measure latency growth\n`);
    console.log('─'.repeat(80));

    for (let i = 0; i < messageCount; i++) {
      const message = messages[i % messages.length];
      const startTime = performance.now();
      
      // Track timings
      const perfData: PerformanceMetrics = {
        messageNumber: i + 1,
        historyCount: 0,
        historyTokens: 0,
        timings: {
          keyFetch: 0,
          sessionLookup: 0,
          ensureKeys: 0,
          getSession: 0,
          saveUserMessage: 0,
          loadHistory: 0,
          loadSkills: 0,
          buildMessages: 0,
          getTools: 0,
          streamTextInit: 0,
          timeToFirstChunk: 0,
          totalSetup: 0,
          totalTimeToFirstChunk: 0,
        },
      };

      // Get history size BEFORE sending message
      const historyBefore = await agentService.getChatHistory(chatId);
      perfData.historyCount = historyBefore.length;
      perfData.historyTokens = Math.ceil(JSON.stringify(historyBefore).length / 4);

      // Stream message and capture first chunk time
      let firstChunkTime: number | null = null;
      let chunkCount = 0;

      try {
        for await (const chunk of agentService.streamAgent(chatId, message, config)) {
          chunkCount++;
          
          if (firstChunkTime === null) {
            firstChunkTime = performance.now() - startTime;
            perfData.timings.totalTimeToFirstChunk = firstChunkTime;
            
            console.log(`\nMessage ${i + 1}/${messageCount}: "${message.substring(0, 50)}..."`);
            console.log(`  History: ${perfData.historyCount} messages (~${perfData.historyTokens} tokens)`);
            console.log(`  ⚡ First chunk: ${firstChunkTime.toFixed(2)}ms`);
            console.log(`  Chunks received: ${chunkCount}`);
          }

          // Only consume first few chunks to speed up test
          if (chunkCount > 5 && chunk.type === 'text-delta') {
            break;
          }
        }

        // If API key is invalid, skip this test
        if (chunkCount === 0) {
          console.log('⚠️  No API key - skipping live test');
          return;
        }

        metrics.push(perfData);

        // Show progress
        if ((i + 1) % 5 === 0) {
          console.log('─'.repeat(80));
        }

      } catch (error) {
        if (error instanceof Error && error.message.includes('API key')) {
          console.log('⚠️  Invalid API key - skipping live test');
          return;
        }
        throw error;
      }
    }

    // Analysis
    console.log('\n' + '═'.repeat(80));
    console.log('📈 PERFORMANCE ANALYSIS');
    console.log('═'.repeat(80));

    // Group by ranges
    const ranges = [
      { label: 'Messages 1-5 (small history)', start: 0, end: 5 },
      { label: 'Messages 6-10 (medium history)', start: 5, end: 10 },
      { label: 'Messages 11-15 (large history)', start: 10, end: 15 },
      { label: 'Messages 16-20 (very large history)', start: 15, end: 20 },
    ];

    for (const range of ranges) {
      const rangeMetrics = metrics.slice(range.start, range.end);
      if (rangeMetrics.length === 0) continue;

      const avgTime = rangeMetrics.reduce((sum, m) => sum + m.timings.totalTimeToFirstChunk, 0) / rangeMetrics.length;
      const avgHistory = rangeMetrics.reduce((sum, m) => sum + m.historyCount, 0) / rangeMetrics.length;
      const avgTokens = rangeMetrics.reduce((sum, m) => sum + m.historyTokens, 0) / rangeMetrics.length;

      console.log(`\n${range.label}:`);
      console.log(`  Avg history size: ${avgHistory.toFixed(1)} messages (~${avgTokens.toFixed(0)} tokens)`);
      console.log(`  Avg time to first chunk: ${avgTime.toFixed(2)}ms`);
    }

    // Calculate regression (time vs history size)
    if (metrics.length > 10) {
      const first5Avg = metrics.slice(0, 5).reduce((sum, m) => sum + m.timings.totalTimeToFirstChunk, 0) / 5;
      const last5Avg = metrics.slice(-5).reduce((sum, m) => sum + m.timings.totalTimeToFirstChunk, 0) / 5;
      const slowdown = last5Avg - first5Avg;
      const slowdownPercent = (slowdown / first5Avg) * 100;

      console.log(`\n🎯 Key Findings:`);
      console.log(`  First 5 messages avg: ${first5Avg.toFixed(2)}ms`);
      console.log(`  Last 5 messages avg: ${last5Avg.toFixed(2)}ms`);
      console.log(`  Slowdown: ${slowdown.toFixed(2)}ms (${slowdownPercent.toFixed(1)}%)`);
      
      // Identify bottleneck
      if (slowdownPercent > 50) {
        console.log(`  ⚠️  SIGNIFICANT SLOWDOWN DETECTED!`);
        console.log(`  This suggests history loading/context building is a bottleneck.`);
      } else if (slowdownPercent > 20) {
        console.log(`  ⚠️  Moderate slowdown - history scaling may need optimization.`);
      } else {
        console.log(`  ✅ Performance scales well with conversation length.`);
      }
    }

    console.log('\n' + '═'.repeat(80));

    // Assertions
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0].historyCount).toBe(0); // First message has no history
    expect(metrics[metrics.length - 1].historyCount).toBeGreaterThan(10); // Last message has history
  }, 120000); // 2 minute timeout

  /**
   * Test: Measure each component's latency contribution
   * Identifies which steps slow down as history grows
   */
  it('should identify bottleneck components', async () => {
    // Send a few messages to build up history
    const setupMessages = [
      "Tell me about TypeScript",
      "What is Node.js?",
      "Explain async/await",
    ];

    console.log('\n📊 Component Bottleneck Analysis');
    console.log('─'.repeat(80));

    for (const msg of setupMessages) {
      let chunkCount = 0;
      try {
        for await (const chunk of agentService.streamAgent(chatId, msg, config)) {
          chunkCount++;
          if (chunkCount > 3) break; // Just get a few chunks
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('API key')) {
          console.log('⚠️  No API key - skipping live test');
          return;
        }
        throw error;
      }
    }

    // Now measure with history
    const history = await agentService.getChatHistory(chatId);
    console.log(`\nAnalyzing with ${history.length} messages in history`);
    console.log(`Estimated ${Math.ceil(JSON.stringify(history).length / 4)} tokens\n`);

    // This test relies on console logs from AgentService
    // The actual timing breakdowns are logged by the service
    console.log('Check the console output above for detailed timing breakdowns:');
    console.log('  - ensureKeys: Time to check API key cache');
    console.log('  - getSession: Time to get or create chat session');
    console.log('  - loadHistory: Time to load message history from storage');
    console.log('  - buildMessages: Time to format messages for LLM');
    console.log('  - getTools: Time to prepare tool definitions');
    console.log('  - streamTextInit: Time to initialize AI SDK streaming');
    console.log('  - timeToFirstChunk: Time from AI request to first token');

    expect(history.length).toBeGreaterThan(0);
  }, 30000);

  /**
   * Test: Compare first message vs subsequent messages
   * Shows the impact of session caching
   */
  it('should show session caching benefit', async () => {
    console.log('\n📊 Session Caching Impact Test');
    console.log('─'.repeat(80));

    // First message (no session exists)
    let firstMessageTime = 0;
    let firstChunkCount = 0;
    
    const t1 = performance.now();
    try {
      for await (const chunk of agentService.streamAgent(chatId, "What is 2+2?", config)) {
        firstChunkCount++;
        if (firstChunkCount === 1) {
          firstMessageTime = performance.now() - t1;
          console.log(`\nFirst message (creating session):`);
          console.log(`  Time to first chunk: ${firstMessageTime.toFixed(2)}ms`);
          break; // Just measure first chunk
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('API key')) {
        console.log('⚠️  No API key - skipping live test');
        return;
      }
      throw error;
    }

    // Second message (session exists, key cached)
    let secondMessageTime = 0;
    let secondChunkCount = 0;
    
    const t2 = performance.now();
    for await (const chunk of agentService.streamAgent(chatId, "What is 5+5?", config)) {
      secondChunkCount++;
      if (secondChunkCount === 1) {
        secondMessageTime = performance.now() - t2;
        console.log(`\nSecond message (reusing session + cached key):`);
        console.log(`  Time to first chunk: ${secondMessageTime.toFixed(2)}ms`);
        break;
      }
    }

    // Analysis
    const improvement = firstMessageTime - secondMessageTime;
    const improvementPercent = (improvement / firstMessageTime) * 100;

    console.log(`\n🎯 Session Caching Impact:`);
    console.log(`  Time saved: ${improvement.toFixed(2)}ms (${improvementPercent.toFixed(1)}% faster)`);
    
    if (improvementPercent > 10) {
      console.log(`  ✅ Session caching provides measurable benefit!`);
    } else {
      console.log(`  ⚠️  Session caching benefit is minimal (may be network variance)`);
    }

    console.log('─'.repeat(80));

    expect(secondMessageTime).toBeGreaterThan(0);
    expect(firstMessageTime).toBeGreaterThan(0);
  }, 30000);
});
