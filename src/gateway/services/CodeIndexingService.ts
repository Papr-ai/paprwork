/**
 * Code Indexing Service Initialization
 * 
 * Manages the lifecycle of the code indexing system:
 * - Registers schema on first run
 * - Seeds controlled vocabulary
 * - Starts smart index manager (initial index + file watching)
 * - Provides status endpoint
 */

import { Papr } from '@papr/memory';
import { registerCodeSchema, seedControlledVocabulary } from './CodeSchemaRegistration.js';
import { SmartCodeIndexManager } from './storage/SmartCodeIndexManager.js';
import { CodeIndexTracker } from './storage/CodeIndexTracker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let indexManager: SmartCodeIndexManager | null = null;
let fallbackTracker: CodeIndexTracker | null = null;
let schemaId: string | null = null;
let indexingInitialized = false;
let initializationPromise: Promise<void> | null = null; // Mutex to prevent duplicate initialization

const SCHEMA_FILE = path.join(os.homedir(), '.paprwork-v2', 'code-schema-id.txt');

/**
 * Get or register the code schema
 */
async function ensureCodeSchema(client: Papr): Promise<string> {
  const SCHEMA_NAME = 'paprwork-code';
  const SCHEMA_VERSION = '2.0.0';
  
  // Check if schema exists in user's namespace
  try {
    console.log('[CodeIndexing] Checking for existing code schema in namespace...');
    const response: any = await client.schemas.list();
    const schemasList = response.data || response || [];
    
    // Find schema by name AND version
    const existingSchema = schemasList.find(
      (s: any) => s.name === SCHEMA_NAME && s.version === SCHEMA_VERSION
    );
    
    if (existingSchema) {
      const schemaId = existingSchema.id || existingSchema.schema_id;
      console.log(`[CodeIndexing] Found existing schema: ${schemaId} (v${SCHEMA_VERSION})`);
      
      // Cache it
      const dir = path.dirname(SCHEMA_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SCHEMA_FILE, JSON.stringify({
        schema_id: schemaId,
        version: SCHEMA_VERSION,
        created_at: new Date().toISOString()
      }), 'utf-8');
      
      return schemaId;
    }
    
    // Check if there's an older version we should warn about
    const olderSchema = schemasList.find((s: any) => s.name === SCHEMA_NAME);
    if (olderSchema) {
      console.log(`[CodeIndexing] Found schema with name '${SCHEMA_NAME}' but different version (${olderSchema.version}), registering new v${SCHEMA_VERSION}`);
    } else {
      console.log('[CodeIndexing] No existing schema found, will register new one');
    }
  } catch (error) {
    console.log('[CodeIndexing] Error checking schemas, will register new one');
  }

  // Check local cache as fallback
  if (fs.existsSync(SCHEMA_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf-8'));
      if (cached.schema_id && cached.version === SCHEMA_VERSION) {
        console.log(`[CodeIndexing] Using cached schema: ${cached.schema_id} (v${SCHEMA_VERSION})`);
        return cached.schema_id;
      } else if (cached.version !== SCHEMA_VERSION) {
        console.log(`[CodeIndexing] Cached schema version mismatch (${cached.version} vs ${SCHEMA_VERSION}), will register new one`);
      }
    } catch (error) {
      console.log('[CodeIndexing] Invalid cache file, will register new schema');
    }
  }

  // Register new schema
  console.log(`[CodeIndexing] Registering code schema v${SCHEMA_VERSION} in user namespace...`);
  const { schema_id } = await registerCodeSchema(client);
  
  // Cache it with metadata
  const dir = path.dirname(SCHEMA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify({
    schema_id,
    version: SCHEMA_VERSION,
    created_at: new Date().toISOString()
  }, null, 2), 'utf-8');
  
  // Seed controlled vocabulary on first registration
  console.log('[CodeIndexing] Seeding controlled vocabulary...');
  await seedControlledVocabulary(client);
  
  return schema_id;
}

/**
 * Lazy initialization - start indexing when PAPR key is first used
 * Uses a mutex to prevent duplicate initialization from multiple callers
 */
export async function ensureIndexingStarted(paprApiKey: string): Promise<void> {
  // If already initialized, return immediately
  if (indexingInitialized && indexManager) {
    return; // Already started
  }
  
  // If initialization is in progress, wait for it
  if (initializationPromise) {
    console.log('[CodeIndexing] Initialization already in progress, waiting...');
    return initializationPromise;
  }
  
  // Start initialization and store the promise
  initializationPromise = (async () => {
    try {
      console.log('[CodeIndexing] Starting lazy initialization...');
      await initializeCodeIndexing(paprApiKey);
      indexingInitialized = true;
      console.log('[CodeIndexing] ✅ Lazy initialization complete');
    } catch (error) {
      console.error('[CodeIndexing] Failed to start:', error);
      // Don't throw - indexing is optional
    } finally {
      initializationPromise = null; // Clear the mutex
    }
  })();
  
  return initializationPromise;
}

/**
 * Initialize code indexing system
 */
export async function initializeCodeIndexing(paprApiKey: string): Promise<void> {
  try {
    console.log('[CodeIndexing] Starting initialization...');
    
    // Initialize PAPR client
    const client = new Papr({ xAPIKey: paprApiKey });
    
    // Ensure schema is registered
    schemaId = await ensureCodeSchema(client);
    
    // Start smart index manager
    indexManager = new SmartCodeIndexManager(client, {
      schemaId,
      debounceMs: 5000, // 5 seconds
      batchSize: 10 // Reduced from 50 to avoid rate limiting
    });
    
    await indexManager.start();
    
    console.log('[CodeIndexing] ✅ Code indexing ready');
    
  } catch (error) {
    console.error('[CodeIndexing] Failed to initialize:', error);
    throw error;
  }
}

/**
 * Shared tracker for agent tools (local summary cache).
 */
export function getSharedCodeIndexTracker(): CodeIndexTracker {
  if (indexManager) {
    return indexManager.getTracker();
  }

  if (!fallbackTracker) {
    fallbackTracker = new CodeIndexTracker();
  }

  return fallbackTracker;
}

/**
 * Get code indexing status
 */
export function getCodeIndexingStatus(): {
  enabled: boolean;
  schema_id: string | null;
  status: ReturnType<SmartCodeIndexManager['getStatus']> | null;
} {
  return {
    enabled: indexManager !== null,
    schema_id: schemaId,
    status: indexManager ? indexManager.getStatus() : null
  };
}

/**
 * Stop code indexing (called on shutdown)
 */
export function stopCodeIndexing(): void {
  if (indexManager) {
    console.log('[CodeIndexing] Stopping...');
    indexManager.stop();
    indexManager = null;
  }
}
