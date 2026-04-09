#!/usr/bin/env node
import { execSync } from 'child_process';

console.log('Checking Python dependencies for browser_parse_html...');

try {
  // Check if Python 3 is available
  execSync('python3 --version', { stdio: 'ignore' });
  
  // Check if BeautifulSoup is installed
  try {
    execSync('python3 -c "import bs4"', { stdio: 'ignore' });
    console.log('✓ BeautifulSoup4 installed');
  } catch {
    console.log('⚠ BeautifulSoup4 not found. Install with: pip3 install beautifulsoup4');
  }
  
  // Check if lxml is installed
  try {
    execSync('python3 -c "import lxml"', { stdio: 'ignore' });
    console.log('✓ lxml installed');
  } catch {
    console.log('⚠ lxml not found. Install with: pip3 install lxml');
  }
} catch {
  console.log('⚠ Python 3 not found. browser_parse_html tool will not work.');
  console.log('  Install Python 3: https://www.python.org/downloads/');
}
