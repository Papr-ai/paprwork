#!/usr/bin/env node
/**
 * Test Code Search Functionality
 * 
 * Validates that code indexing works and semantic search returns relevant results.
 * 
 * Usage:
 *   npm run test:code-search
 * 
 * This script uses the gateway's key resolver to get the PAPR API key
 * from the keychain, so no environment variables are needed.
 */

import { Papr } from '@papr/memory';
import { getApiKey } from '../utils/keyResolver.js';

interface TestQuery {
  description: string;
  query: string;
  expectedResults?: string[];
}

const testQueries: TestQuery[] = [
  {
    description: 'Find code that fetches GitHub data',
    query: 'Find code that fetches GitHub stargazers data from API',
    expectedResults: ['fetch.py', 'stargazers']
  },
  {
    description: 'Find TypeScript mini-apps',
    query: 'Show me TypeScript mini-apps with UI components',
    expectedResults: ['app.ts', 'TypeScript']
  },
  {
    description: 'Find Python jobs',
    query: 'Find Python jobs that process data and store in SQLite',
    expectedResults: ['Python', 'job']
  },
  {
    description: 'Find async/await patterns',
    query: 'Show code that uses async/await patterns with error handling',
    expectedResults: ['async', 'await']
  },
  {
    description: 'Find code with SQLite databases',
    query: 'Find projects that query SQLite databases',
    expectedResults: ['sqlite', 'database', 'db']
  },
  {
    description: 'Find job dependencies',
    query: 'Show me jobs that depend on other jobs',
    expectedResults: ['dependsOn', 'job']
  },
  {
    description: 'Find API calling code',
    query: 'Find code that makes HTTP API calls with rate limiting',
    expectedResults: ['fetch', 'requests', 'api']
  }
];

async function testSearch(client: Papr, query: TestQuery): Promise<{
  passed: boolean;
  results: number;
  relevantResults: number;
}> {
  console.log(`\n🔍 Query: "${query.description}"`);
  console.log(`   Search: "${query.query}"`);
  
  try {
    const response = await client.memory.search({
      query: query.query,
      external_user_id: 'paprwork_system',
      max_memories: 10,
      enable_agentic_graph: true,
      rank_results: true
    });
    
    const memories = response.data?.memories || [];
    const nodes = response.data?.nodes || [];
    
    console.log(`   Found: ${memories.length} memories, ${nodes.length} graph nodes`);
    
    // Check for relevant results
    let relevantCount = 0;
    if (query.expectedResults) {
      for (const memory of memories.slice(0, 5)) {
        const content = memory.content?.toLowerCase() || '';
        const metadata = JSON.stringify(memory.customMetadata || {}).toLowerCase();
        const combined = content + ' ' + metadata;
        
        const isRelevant = query.expectedResults.some(keyword => 
          combined.includes(keyword.toLowerCase())
        );
        
        if (isRelevant) {
          relevantCount++;
        }
      }
    }
    
    // Show top result
    if (memories.length > 0) {
      const topResult = memories[0];
      const metadata = topResult.customMetadata as any;
      console.log(`   Top result: ${metadata?.file_name || metadata?.project_name || 'Unknown'}`);
      console.log(`   Similarity: ${topResult.similarity_score?.toFixed(3) || 'N/A'}`);
    }
    
    // Show graph nodes
    if (nodes.length > 0) {
      const nodeTypes = nodes.map((n: any) => n.label || n.type).filter(Boolean);
      const uniqueTypes = [...new Set(nodeTypes)];
      console.log(`   Node types: ${uniqueTypes.join(', ')}`);
    }
    
    const passed = memories.length > 0 && relevantCount > 0;
    console.log(`   ${passed ? '✅ PASS' : '❌ FAIL'}: ${relevantCount}/${Math.min(5, memories.length)} relevant`);
    
    return {
      passed,
      results: memories.length,
      relevantResults: relevantCount
    };
    
  } catch (error) {
    console.error(`   ❌ ERROR: ${(error as Error).message}`);
    return {
      passed: false,
      results: 0,
      relevantResults: 0
    };
  }
}

async function main() {
  console.log('🧪 PAPR Code Search Tests\n');
  
  try {
    // Get API key from keychain (same as gateway does)
    console.log('📋 Fetching PAPR API key from keychain...');
    const apiKey = await getApiKey('PAPR_API_KEY');
    
    if (!apiKey) {
      console.error('❌ No PAPR_API_KEY found in keychain');
      console.log('💡 Please add your PAPR API key in Settings > API Keys');
      process.exit(1);
    }
    
    console.log('✓ API key loaded\n');
    
    // Initialize client
    const client = new Papr({ xAPIKey: apiKey });
    
    // Run tests
    const results = [];
    for (const query of testQueries) {
      const result = await testSearch(client, query);
      results.push(result);
      
      // Pause between queries to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 Test Summary');
    console.log('='.repeat(50));
    
    const passed = results.filter(r => r.passed).length;
    const total = results.length;
    const totalResults = results.reduce((sum, r) => sum + r.results, 0);
    const totalRelevant = results.reduce((sum, r) => sum + r.relevantResults, 0);
    
    console.log(`Tests passed: ${passed}/${total} (${(passed/total*100).toFixed(0)}%)`);
    console.log(`Total results: ${totalResults}`);
    console.log(`Relevant results: ${totalRelevant}`);
    
    if (passed === total) {
      console.log('\n🎉 All tests passed! Code search is working correctly.');
    } else {
      console.log(`\n⚠️  ${total - passed} test(s) failed. This may be expected if:`);
      console.log('   - Code hasn\'t been indexed yet (run: npm run index:code)');
      console.log('   - LLM hasn\'t extracted graph nodes yet (processing may take time)');
      console.log('   - Query doesn\'t match your specific code');
    }
    
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
    }
    process.exit(1);
  }
}

main().catch(console.error);
