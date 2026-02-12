#!/usr/bin/env tsx
/**
 * Check TypeScript files for max lines of code
 * Inspired by OpenClaw's check-ts-max-loc.ts
 * 
 * Usage:
 *   npm run check:loc
 *   npm run check:loc -- --max 300
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

interface Options {
  maxLines: number;
  exclude: string[];
  verbose: boolean;
}

const DEFAULT_OPTIONS: Options = {
  maxLines: 500,
  exclude: [
    'node_modules',
    'dist',
    'release',
    'coverage',
    '.git',
    'build',
  ],
  verbose: false,
};

/**
 * Count lines in a file (excluding empty lines and comments)
 */
function countSignificantLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  let count = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines
    if (!trimmed) continue;
    
    // Handle block comments
    if (trimmed.startsWith('/*')) {
      inBlockComment = true;
    }
    if (inBlockComment) {
      if (trimmed.endsWith('*/')) {
        inBlockComment = false;
      }
      continue;
    }
    
    // Skip single-line comments
    if (trimmed.startsWith('//')) continue;
    
    count++;
  }
  
  return count;
}

/**
 * Recursively find all TypeScript files
 */
function findTypeScriptFiles(dir: string, options: Options): string[] {
  const files: string[] = [];
  
  try {
    const entries = readdirSync(dir);
    
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      
      // Skip excluded directories
      if (options.exclude.some(exc => fullPath.includes(exc))) {
        continue;
      }
      
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        files.push(...findTypeScriptFiles(fullPath, options));
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        // Skip .d.ts files (type definitions)
        if (!entry.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Ignore permission errors
  }
  
  return files;
}

/**
 * Check all TypeScript files for max LOC
 */
function checkMaxLines(rootDir: string, options: Options): void {
  const files = findTypeScriptFiles(rootDir, options);
  const violations: Array<{ file: string; lines: number }> = [];
  
  console.log(`Checking ${files.length} TypeScript files for max ${options.maxLines} lines...\n`);
  
  for (const file of files) {
    const lines = countSignificantLines(file);
    const relativePath = relative(rootDir, file);
    
    if (lines > options.maxLines) {
      violations.push({ file: relativePath, lines });
    } else if (options.verbose) {
      console.log(`✓ ${relativePath}: ${lines} lines`);
    }
  }
  
  if (violations.length > 0) {
    console.error(`\n❌ Found ${violations.length} file(s) exceeding ${options.maxLines} lines:\n`);
    
    // Sort by lines descending
    violations.sort((a, b) => b.lines - a.lines);
    
    for (const violation of violations) {
      const excess = violation.lines - options.maxLines;
      console.error(`  ${violation.file}: ${violation.lines} lines (+${excess})`);
    }
    
    console.error(`\n💡 Tip: Break large files into smaller, focused modules.\n`);
    process.exit(1);
  } else {
    console.log(`✅ All ${files.length} files are within ${options.maxLines} lines limit!\n`);
  }
}

// Parse command line arguments
function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options = { ...DEFAULT_OPTIONS };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max' && args[i + 1]) {
      options.maxLines = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      options.verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npm run check:loc [options]

Options:
  --max <number>    Maximum lines per file (default: 500)
  --verbose, -v     Show all files checked
  --help, -h        Show this help message

Examples:
  npm run check:loc
  npm run check:loc -- --max 300
  npm run check:loc -- --verbose
      `);
      process.exit(0);
    }
  }
  
  return options;
}

// Main execution
const options = parseArgs();
const rootDir = process.cwd();

try {
  checkMaxLines(rootDir, options);
} catch (error) {
  console.error('Error:', (error as Error).message);
  process.exit(1);
}
