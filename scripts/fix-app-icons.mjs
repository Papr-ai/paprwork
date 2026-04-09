#!/usr/bin/env node
/**
 * Fix app icons that have plain text instead of SVG/emoji
 * Replaces invalid icons with proper SVG equivalents
 */

import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const APPS_FILE = join(homedir(), 'Papr/data/apps.json');

// Map of invalid text icons to proper SVG replacements
const ICON_REPLACEMENTS = {
  'chart': '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3v16a2 2 0 002 2h16" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="7 14 12 9 16 13 21 8" stroke="currentColor" stroke-width="2"/></svg>',
  'shield': '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  'grid': '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="14" y="3" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="3" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="14" y="14" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  'search': '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" fill="none"/><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/></svg>',
  'calendar': '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" stroke-width="1.5"/></svg>',
  'home': '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" fill="none"/><polyline points="9 22 9 12 15 12 15 22" stroke="currentColor" stroke-width="2"/></svg>',
  'settings': '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 1v3m0 16v3M4.22 4.22l2.12 2.12m11.32 11.32l2.12 2.12M1 12h3m16 0h3M4.22 19.78l2.12-2.12m11.32-11.32l2.12-2.12" stroke="currentColor" stroke-width="1.5"/></svg>',
  'file': '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" stroke-width="1.5"/></svg>',
  'user': '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" stroke="currentColor" stroke-width="1.5"/></svg>',
};

function isValidIcon(icon) {
  if (!icon) return false;
  const trimmed = icon.trim();
  
  // Check if it's SVG
  if (trimmed.startsWith('<')) return true;
  
  // Check if it's a valid emoji (Unicode character, not plain ASCII text)
  if (trimmed.length <= 4 && /[\p{Emoji}]/u.test(trimmed)) return true;
  
  return false;
}

function fixAppIcons() {
  console.log('Reading apps file:', APPS_FILE);
  
  let apps;
  try {
    apps = JSON.parse(readFileSync(APPS_FILE, 'utf8'));
  } catch (error) {
    console.error('Failed to read apps file:', error.message);
    process.exit(1);
  }
  
  let fixedCount = 0;
  let removedCount = 0;
  
  for (const app of apps) {
    if (!app.icon) continue;
    
    if (!isValidIcon(app.icon)) {
      const trimmed = app.icon.trim().toLowerCase();
      
      // Try to find a replacement
      if (ICON_REPLACEMENTS[trimmed]) {
        console.log(`✓ Fixing "${app.title}": "${app.icon}" → SVG icon`);
        app.icon = ICON_REPLACEMENTS[trimmed];
        fixedCount++;
      } else {
        console.log(`✗ Removing invalid icon from "${app.title}": "${app.icon}"`);
        delete app.icon;
        removedCount++;
      }
    }
  }
  
  if (fixedCount === 0 && removedCount === 0) {
    console.log('✓ All app icons are valid!');
    return;
  }
  
  // Write back to file
  writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
  
  console.log(`\n✓ Fixed ${fixedCount} app(s) with proper SVG icons`);
  console.log(`✓ Removed ${removedCount} invalid icon(s)`);
  console.log('✓ Apps file updated successfully');
  console.log('\nRestart the app to see the changes.');
}

fixAppIcons();
