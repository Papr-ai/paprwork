#!/usr/bin/env node

/**
 * Test script to verify frequency schemas vs KG schemas distinction
 */

import Papr from '@papr/memory';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config({ path: join(__dirname, '..', '.env.local') });

const client = new Papr({
  xAPIKey: process.env.PAPR_API_KEY,
  timeout: 30000
});

console.log('🧪 Testing Schema Type Distinction\n');
console.log('='.repeat(70));

async function testFrequencySchemas() {
  console.log('\n1. FREQUENCY SCHEMAS (for holographic neural transforms)');
  console.log('-'.repeat(70));
  
  try {
    const response = await fetch('https://api.papr.ai/v1/frequencies', {
      headers: { 'X-API-Key': process.env.PAPR_API_KEY }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`Total frequency schemas: ${data.data?.length || 0}`);
    console.log('\nFirst 5 frequency schemas:');
    data.data?.slice(0, 5).forEach(schema => {
      console.log(`  • ${schema.id.padEnd(15)} → ${schema.name} (${schema.frequency_count} frequencies)`);
    });
    
    console.log('\n📌 Usage: Use these IDs with signalDomain or vectorPolicy.domainId');
    console.log('   Example: add_agent_memory({ signalDomain: "general" })');
    
    return data.data;
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    console.log('   Note: Network issues with frequency endpoint');
    return [];
  }
}

async function testKnowledgeGraphSchemas() {
  console.log('\n\n2. KNOWLEDGE GRAPH SCHEMAS (user-created entities/relationships)');
  console.log('-'.repeat(70));
  
  try {
    const schemas = await client.schemas.list();
    console.log(`Total KG schemas: ${schemas.data?.length || 0}`);
    console.log('\nYour KG schemas:');
    schemas.data?.slice(0, 5).forEach(schema => {
      console.log(`  • ${schema.id} - ${schema.name}`);
      console.log(`    Node types: ${Object.keys(schema.node_types || {}).length}, Relationships: ${Object.keys(schema.relationship_types || {}).length}`);
    });
    
    console.log('\n📌 Usage: Use these IDs with schemaId in create_entities or register_schema');
    console.log('   Example: create_entities({ schemaId: "BNSv8YCQXJ", nodes: [...] })');
    
    return schemas.data;
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return [];
  }
}

async function showDistinction(frequencySchemas, kgSchemas) {
  console.log('\n\n3. KEY DISTINCTIONS');
  console.log('-'.repeat(70));
  
  console.log('\n📊 FREQUENCY SCHEMAS (Holographic):');
  console.log('  • Purpose: Neural semantic encoding for better search');
  console.log('  • Created by: Papr (pre-built)');
  console.log('  • ID format: Short names like "general", "cosqa", "scifact"');
  console.log('  • Count:', frequencySchemas.length);
  console.log('  • List them: list_signal_domains tool');
  console.log('  • Use with: signalDomain (add), vectorPolicy.domainId (search)');
  
  console.log('\n🗺️  KNOWLEDGE GRAPH SCHEMAS:');
  console.log('  • Purpose: Define entity types and relationships for your data');
  console.log('  • Created by: You (via register_schema)');
  console.log('  • ID format: 10-char random IDs like "BNSv8YCQXJ"');
  console.log('  • Count:', kgSchemas.length);
  console.log('  • List them: list_schemas tool');
  console.log('  • Use with: schemaId in create_entities, register_schema');
  
  console.log('\n⚠️  DON\'T CONFUSE THEM:');
  console.log('  ❌ Wrong: add_agent_memory({ signalDomain: "BNSv8YCQXJ" })');
  console.log('  ✅ Right: add_agent_memory({ signalDomain: "general" })');
  console.log('  ❌ Wrong: create_entities({ schemaId: "cosqa", nodes: [...] })');
  console.log('  ✅ Right: create_entities({ schemaId: "BNSv8YCQXJ", nodes: [...] })');
}

async function main() {
  const frequencySchemas = await testFrequencySchemas();
  const kgSchemas = await testKnowledgeGraphSchemas();
  await showDistinction(frequencySchemas, kgSchemas);
  
  console.log('\n' + '='.repeat(70));
  console.log('✅ Test complete!\n');
}

main().catch(console.error);
