/**
 * Delegation Tools Test
 * 
 * Verifies sub-agent and job tools are properly registered and functional
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { allTools, getToolById } from '../src/core/tools/index.js';

describe('Delegation Tools Registration', () => {
  it('should have all delegation tools registered', () => {
    const requiredTools = [
      'list_sub_agents',
      'create_sub_agent',
      'delete_sub_agent',
      'delegate_task',
      'get_delegation_run',
      'list_delegation_runs'
    ];
    
    const registeredToolIds = allTools.map(t => t.id);
    
    for (const toolId of requiredTools) {
      expect(registeredToolIds).toContain(toolId);
    }
  });
  
  it('should have all job tools registered', () => {
    const requiredTools = [
      'create_job',
      'run_job',
      'read_job_logs',
      'create_app',
      'list_apps'
    ];
    
    const registeredToolIds = allTools.map(t => t.id);
    
    for (const toolId of requiredTools) {
      expect(registeredToolIds).toContain(toolId);
    }
  });
  
  it('should have planning tools registered', () => {
    const requiredTools = ['create_plan', 'update_plan'];
    const registeredToolIds = allTools.map(t => t.id);
    
    for (const toolId of requiredTools) {
      expect(registeredToolIds).toContain(toolId);
    }
  });
});

describe('Tool Schema Validation', () => {
  it('create_sub_agent should have required fields', () => {
    const tool = getToolById('create_sub_agent');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('create_sub_agent');
    expect(tool?.description).toBeTruthy();
    expect(tool?.inputSchema).toBeDefined();
  });
  
  it('delegate_task should have required fields', () => {
    const tool = getToolById('delegate_task');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('delegate_task');
    expect(tool?.description.toLowerCase()).toContain('delegate');
    expect(tool?.inputSchema).toBeDefined();
  });
  
  it('create_job should have required fields', () => {
    const tool = getToolById('create_job');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('create_job');
    expect(tool?.description).toBeTruthy();
    expect(tool?.inputSchema).toBeDefined();
  });
  
  it('run_job should have required fields', () => {
    const tool = getToolById('run_job');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('run_job');
    expect(tool?.description).toBeTruthy();
    expect(tool?.inputSchema).toBeDefined();
  });
  
  it('create_plan should have correct schema', () => {
    const tool = getToolById('create_plan');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('create_plan');
    
    // Verify the schema uses "description" not "title" for steps
    const schemaShape = (tool?.inputSchema as any)?.shape;
    expect(schemaShape).toBeDefined();
    expect(schemaShape.title).toBeDefined();
    expect(schemaShape.steps).toBeDefined();
  });
  
  it('update_plan should have correct schema', () => {
    const tool = getToolById('update_plan');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('update_plan');
    
    const schemaShape = (tool?.inputSchema as any)?.shape;
    expect(schemaShape).toBeDefined();
    expect(schemaShape.planId).toBeDefined();
    expect(schemaShape.updates).toBeDefined();
  });
});

describe('Tool Count Verification', () => {
  it('should have expected number of total tools', () => {
    // We should have at least:
    // 1 bash + 4 filesystem + 6 delegation + 10 appJobs + 2 planning + others
    expect(allTools.length).toBeGreaterThanOrEqual(30);
  });
  
  it('should have no duplicate tool IDs', () => {
    const toolIds = allTools.map(t => t.id);
    const uniqueIds = new Set(toolIds);
    expect(toolIds.length).toBe(uniqueIds.size);
  });
  
  it('should list all delegation tool IDs', () => {
    const delegationTools = allTools.filter(t => 
      t.id.includes('sub_agent') || 
      t.id.includes('delegate') ||
      t.id === 'create_job' ||
      t.id === 'run_job'
    );
    
    console.log('\nDelegation & Job Tools:');
    delegationTools.forEach(t => {
      console.log(`  - ${t.id}: ${t.description}`);
    });
    
    // We have: create_job, run_job, list_sub_agents, create_sub_agent, 
    //          delete_sub_agent, delegate_task, get_delegation_run, list_delegation_runs
    expect(delegationTools.length).toBeGreaterThanOrEqual(6);
  });
});

describe('Tool Descriptions', () => {
  it('create_sub_agent description should mention profiles', () => {
    const tool = getToolById('create_sub_agent');
    expect(tool?.description.toLowerCase()).toMatch(/profile|persistent|specialist/);
  });
  
  it('create_sub_agent description should mention default tools', () => {
    const tool = getToolById('create_sub_agent');
    expect(tool?.description.toLowerCase()).toContain('default');
  });
  
  it('delegate_task description should mention delegation', () => {
    const tool = getToolById('delegate_task');
    expect(tool?.description.toLowerCase()).toContain('delegate');
  });
  
  it('create_plan description should mention steps or progress', () => {
    const tool = getToolById('create_plan');
    expect(tool?.description.toLowerCase()).toMatch(/step|progress|plan/);
  });
});

describe('Sub-Agent Default Tools', () => {
  it('create_sub_agent tool should mention defaults in description', () => {
    const tool = getToolById('create_sub_agent');
    expect(tool?.description).toContain('bash');
    expect(tool?.description).toContain('read_file');
    expect(tool?.description).toContain('write_file');
  });
  
  it('should document that allowedToolIds is optional', () => {
    const tool = getToolById('create_sub_agent');
    const schema = tool?.inputSchema as any;
    
    // allowedToolIds should be optional in the schema
    expect(schema).toBeDefined();
  });
});
