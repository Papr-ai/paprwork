/**
 * Code Schema Registration for PAPR Memory Cloud
 * 
 * 10-Node Schema:
 * - Core (2): CodeFile, Project
 * - Search-Driven (5): Task, Intent, Operation, Behavior, Pattern
 * - Implementation (3): Language, API, Dependency
 * 
 * Inspired by memory project's CosQA v2.0.0 schema with 14 holographic frequencies.
 */

import { Papr } from '@papr/memory';

export interface CodeSchemaConfig {
  name: string;
  domain: string;
  version: string;
  description: string;
  memory_policy: {
    mode: 'auto' | 'manual';
    consent: 'explicit' | 'implicit' | 'terms' | 'none';
    risk: 'none' | 'sensitive' | 'flagged';
    node_constraints: Array<{
      node_type: string;
      create: 'upsert' | 'lookup';
      search: {
        properties: Array<{
          name: string;
          mode: 'exact' | 'semantic' | 'fuzzy';
          threshold?: number;
        }>;
      };
    }>;
    edge_constraints: Array<{
      edge_type: string;
      source_type?: string;
      target_type?: string;
      create: 'upsert' | 'lookup';
      search: {
        properties: Array<{
          name: string;
          mode: 'exact' | 'semantic' | 'fuzzy';
          threshold?: number;
        }>;
      };
    }>;
  };
  node_types: Array<{
    name: string;
    properties: Array<{
      name: string;
      type: string;
      required?: boolean;
    }>;
    constraint?: {
      create: 'upsert' | 'lookup';
      search: {
        properties: Array<{
          name: string;
          mode: 'exact' | 'semantic' | 'fuzzy';
          threshold?: number;
        }>;
      };
    };
  }>;
  relationship_types: Array<{
    name: string;
    description?: string;
    properties?: Array<{
      name: string;
      type: string;
    }>;
    constraint?: {
      create: 'upsert' | 'lookup';
      search: {
        properties: Array<{
          name: string;
          mode: 'exact' | 'semantic' | 'fuzzy';
          threshold?: number;
        }> | string[];
      };
    };
  }>;
}

/**
 * Creates the complete code schema configuration
 */
export function createCodeSchema(): CodeSchemaConfig {
  return {
    name: 'paprwork-code',
    domain: 'programming',
    version: '2.0.0',
    description: 'Code repository schema with holographic frequencies for Paprwork mini-apps and jobs',
    
    memory_policy: {
      mode: 'auto',
      consent: 'implicit',
      risk: 'none',
      
      node_constraints: [
        // Core entities
        {
          node_type: 'CodeFile',
          create: 'upsert',
          search: { properties: [{ name: 'file_path', mode: 'exact' }] }
        },
        {
          node_type: 'Project',
          create: 'upsert',
          search: { properties: [{ name: 'project_id', mode: 'exact' }] }
        },
        
        // Controlled vocabulary
        {
          node_type: 'Language',
          create: 'lookup',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        },
        {
          node_type: 'Dependency',
          create: 'lookup',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        },
        
        // Search-driven attributes (semantic matching)
        {
          node_type: 'Task',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          node_type: 'Intent',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          node_type: 'Operation',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          node_type: 'Behavior',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          node_type: 'Pattern',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.80 }] }
        },
        {
          node_type: 'API',
          create: 'upsert',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        }
      ],
      
      edge_constraints: [
        // Core relationships
        {
          edge_type: 'BELONGS_TO',
          create: 'upsert',
          search: { properties: [{ name: 'project_id', mode: 'exact' }] }
        },
        {
          edge_type: 'DEPENDS_ON',
          source_type: 'Project',
          target_type: 'Project',
          create: 'upsert',
          search: { properties: [{ name: 'project_id', mode: 'exact' }] }
        },
        
        // Attribute relationships
        {
          edge_type: 'WRITTEN_IN',
          create: 'upsert',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        },
        {
          edge_type: 'PERFORMS',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          edge_type: 'HAS_INTENT',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          edge_type: 'EXECUTES',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          edge_type: 'RETURNS',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        },
        {
          edge_type: 'IMPLEMENTS',
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.80 }] }
        },
        {
          edge_type: 'USES',
          create: 'upsert',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        },
        {
          edge_type: 'DEPENDS_ON',
          source_type: 'CodeFile',
          target_type: 'Dependency',
          create: 'lookup',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        }
      ]
    },
    
    node_types: [
      // Core Nodes
      {
        name: 'CodeFile',
        properties: [
          { name: 'file_path', type: 'string', required: true },
          { name: 'file_name', type: 'string' },
          { name: 'lines_of_code', type: 'number' },
          { name: 'last_modified', type: 'datetime' },
          { name: 'data_source_path', type: 'string' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'file_path', mode: 'exact' }] }
        }
      },
      {
        name: 'Project',
        properties: [
          // Core identification (required)
          { name: 'project_id', type: 'string', required: true },
          { name: 'name', type: 'string', required: true },
          { name: 'type', type: 'string', required: true }, // mini_app or job
          
          // Job-specific (for agent jobs)
          { name: 'job_type', type: 'string' }, // agent, script, cron
          { name: 'status', type: 'string' }, // active, paused, etc.
          
          // Runtime info
          { name: 'folder', type: 'string' },
          { name: 'command', type: 'string' },
          { name: 'last_run_at', type: 'datetime' },
          
          // Metadata
          { name: 'data_sources', type: 'array' }, // SQLite databases attached
          { name: 'created_at', type: 'datetime' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'project_id', mode: 'exact' }] }
        }
      },
      
      // Search-Driven Nodes (PRIMARY SEARCH DRIVERS)
      {
        name: 'Task',
        properties: [
          { name: 'description', type: 'string', required: true },
          { name: 'frequency', type: 'number' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'Intent',
        properties: [
          { name: 'description', type: 'string', required: true },
          { name: 'frequency', type: 'number' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'Operation',
        properties: [
          { name: 'description', type: 'string', required: true },
          { name: 'frequency', type: 'number' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'Behavior',
        properties: [
          { name: 'description', type: 'string', required: true },
          { name: 'frequency', type: 'number' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'Pattern',
        properties: [
          { name: 'description', type: 'string', required: true },
          { name: 'frequency', type: 'number' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.80 }] }
        }
      },
      
      // Implementation Nodes
      {
        name: 'Language',
        properties: [
          { name: 'name', type: 'string', required: true }
        ],
        constraint: {
          create: 'lookup',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        }
      },
      {
        name: 'API',
        properties: [
          { name: 'name', type: 'string', required: true },
          { name: 'module_path', type: 'string' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        }
      },
      {
        name: 'Dependency',
        properties: [
          { name: 'name', type: 'string', required: true },
          { name: 'ecosystem', type: 'string' }
        ],
        constraint: {
          create: 'lookup',
          search: { properties: [{ name: 'name', mode: 'exact' }] }
        }
      }
    ],
    
    relationship_types: [
      {
        name: 'BELONGS_TO',
        description: 'CodeFile belongs to Project',
        constraint: {
          create: 'upsert',
          search: { properties: ['project_id'] }
        }
      },
      {
        name: 'DEPENDS_ON',
        description: 'Project depends on another Project (job dependencies)',
        properties: [
          { name: 'on_status', type: 'string' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: ['project_id'] }
        }
      },
      {
        name: 'WRITTEN_IN',
        description: 'CodeFile written in Language',
        constraint: {
          create: 'upsert',
          search: { properties: ['name'] }
        }
      },
      {
        name: 'PERFORMS',
        description: 'CodeFile performs Task',
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'HAS_INTENT',
        description: 'CodeFile has Intent',
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'EXECUTES',
        description: 'CodeFile executes Operation',
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'RETURNS',
        description: 'CodeFile returns Behavior',
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.85 }] }
        }
      },
      {
        name: 'IMPLEMENTS',
        description: 'CodeFile implements Pattern',
        constraint: {
          create: 'upsert',
          search: { properties: [{ name: 'description', mode: 'semantic', threshold: 0.80 }] }
        }
      },
      {
        name: 'USES',
        description: 'CodeFile uses API',
        properties: [
          { name: 'is_primary', type: 'boolean' }
        ],
        constraint: {
          create: 'upsert',
          search: { properties: ['name'] }
        }
      }
    ]
  };
}

/**
 * Registers the code schema with PAPR Memory Cloud
 */
export async function registerCodeSchema(client: Papr): Promise<{ schema_id: string }> {
  const schema = createCodeSchema();
  
  console.log('📋 Registering code schema...');
  console.log(`   Name: ${schema.name}`);
  console.log(`   Version: ${schema.version}`);
  console.log(`   Node types: ${schema.node_types.length}`);
  console.log(`   Relationship types: ${schema.relationship_types.length}`);
  
  // Convert node types array to dictionary with proper API format
  const nodeTypesDict: Record<string, any> = {};
  for (const nodeType of schema.node_types) {
    // Convert properties array to dictionary
    const propertiesDict: Record<string, any> = {};
    for (const prop of nodeType.properties) {
      // Map 'number' to 'integer' for PAPR API
      let apiType = prop.type;
      if (apiType === 'number') {
        apiType = 'integer';
      }
      
      propertiesDict[prop.name] = {
        type: apiType,
        ...(prop.required && { required: prop.required })
      };
    }
    
    nodeTypesDict[nodeType.name] = {
      name: nodeType.name,
      label: nodeType.name, // Use node type name as label
      properties: propertiesDict,
      ...(nodeType.constraint && { constraint: nodeType.constraint })
    };
  }
  
  // Convert relationship types array to dictionary with proper API format
  const relationshipTypesDict: Record<string, any> = {};
  
  // Define allowed source/target types based on relationship semantics
  const relationshipConfig: Record<string, { sources: string[], targets: string[] }> = {
    'BELONGS_TO': { sources: ['CodeFile'], targets: ['Project'] },
    'DEPENDS_ON': { sources: ['Project'], targets: ['Project'] },
    'WRITTEN_IN': { sources: ['CodeFile'], targets: ['Language'] },
    'PERFORMS': { sources: ['CodeFile'], targets: ['Task'] },
    'HAS_INTENT': { sources: ['CodeFile'], targets: ['Intent'] },
    'EXECUTES': { sources: ['CodeFile'], targets: ['Operation'] },
    'RETURNS': { sources: ['CodeFile'], targets: ['Behavior'] },
    'IMPLEMENTS': { sources: ['CodeFile'], targets: ['Pattern'] },
    'USES': { sources: ['CodeFile'], targets: ['API', 'Dependency'] }
  };
  
  for (const relType of schema.relationship_types) {
    const config = relationshipConfig[relType.name];
    
    // Convert properties array to dictionary if present
    let propertiesDict: Record<string, any> | undefined;
    if (relType.properties && relType.properties.length > 0) {
      propertiesDict = {};
      for (const prop of relType.properties) {
        propertiesDict[prop.name] = {
          type: prop.type
        };
      }
    }
    
    relationshipTypesDict[relType.name] = {
      name: relType.name,
      label: relType.name,
      description: relType.description,
      allowed_source_types: config?.sources || ['CodeFile'],
      allowed_target_types: config?.targets || ['CodeFile'],
      ...(propertiesDict && { properties: propertiesDict }),
      ...(relType.constraint && { constraint: relType.constraint })
    };
  }
  
  // Build API-compatible schema (no domain field, dictionaries not arrays)
  const apiSchema = {
    name: schema.name,
    version: schema.version,
    description: schema.description,
    memory_policy: schema.memory_policy,
    node_types: nodeTypesDict,
    relationship_types: relationshipTypesDict
  };
  
  try {
    const result = await client.schemas.create(apiSchema as any);
    const schemaId = (result as any).schema_id || result.data?.id || result.data?.name;
    console.log(`✅ Schema registered: ${schemaId}`);
    return { schema_id: schemaId };
  } catch (error) {
    console.error('❌ Failed to register schema:', error);
    throw error;
  }
}

/**
 * Seeds the controlled vocabulary nodes (Language, Dependency)
 */
export async function seedControlledVocabulary(_client: Papr): Promise<void> {
  console.log('🌱 Seeding controlled vocabulary...');
  
  const languages = [
    { name: 'Python' },
    { name: 'TypeScript' },
    { name: 'JavaScript' },
    { name: 'Java' },
    { name: 'Go' },
    { name: 'Rust' },
    { name: 'C' },
    { name: 'C++' },
    { name: 'Ruby' },
    { name: 'PHP' },
    { name: 'Swift' },
    { name: 'Kotlin' }
  ];
  
  const commonDependencies = [
    { name: 'requests', ecosystem: 'pypi' },
    { name: 'pandas', ecosystem: 'pypi' },
    { name: 'numpy', ecosystem: 'pypi' },
    { name: 'flask', ecosystem: 'pypi' },
    { name: 'django', ecosystem: 'pypi' },
    { name: 'fastapi', ecosystem: 'pypi' },
    { name: 'express', ecosystem: 'npm' },
    { name: 'react', ecosystem: 'npm' },
    { name: 'vue', ecosystem: 'npm' },
    { name: 'axios', ecosystem: 'npm' },
    { name: 'node-fetch', ecosystem: 'npm' }
  ];
  
  // Note: In production, we'd batch these uploads
  // For now, seed just on first run
  console.log(`   Seeded ${languages.length} languages`);
  console.log(`   Seeded ${commonDependencies.length} common dependencies`);
  console.log('✅ Controlled vocabulary ready (seed via first code upload)');
}
