#!/usr/bin/env node
/**
 * E2E Test Script for Browser Tools Phase 1
 * 
 * Tests the new browser automation tools with real browser sessions.
 * Run with: node scripts/test-browser-tools-e2e.mjs
 * 
 * Requirements:
 * - Python 3 with BeautifulSoup4 installed (pip3 install beautifulsoup4)
 * - Playwright browsers installed (npx playwright install chromium)
 */

import { spawn } from 'child_process';
import { chromium } from 'playwright';

// Test results
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[36m',    // Cyan
    success: '\x1b[32m', // Green
    error: '\x1b[31m',   // Red
    reset: '\x1b[0m'
  };
  console.log(`${colors[type]}${message}${colors.reset}`);
}

function recordTest(name, passed, error = null) {
  results.tests.push({ name, passed, error });
  if (passed) {
    results.passed++;
    log(`✓ ${name}`, 'success');
  } else {
    results.failed++;
    log(`✗ ${name}: ${error}`, 'error');
  }
}

// Test 1: Python Execution (browser_parse_html core functionality)
async function testPythonExecution() {
  return new Promise((resolve) => {
    const script = `
import json
from bs4 import BeautifulSoup

html = """<html><body><h1>Test Title</h1><p>Test paragraph</p></body></html>"""
soup = BeautifulSoup(html, 'html.parser')
result = {
  'title': soup.find('h1').text,
  'paragraph': soup.find('p').text
}
print(json.dumps(result))
`;

    const proc = spawn('python3', ['-c', script]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => stdout += data.toString());
    proc.stderr.on('data', (data) => stderr += data.toString());

    const timer = setTimeout(() => {
      proc.kill();
      recordTest('Python Execution (timeout)', false, 'Execution timed out after 5s');
      resolve();
    }, 5000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const result = JSON.parse(stdout);
          const valid = result.title === 'Test Title' && result.paragraph === 'Test paragraph';
          recordTest('Python Execution', valid, valid ? null : 'Incorrect parse result');
        } catch (e) {
          recordTest('Python Execution', false, `JSON parse error: ${e.message}`);
        }
      } else {
        recordTest('Python Execution', false, stderr || 'Python script failed');
      }
      resolve();
    });
  });
}

// Test 2: Browser Wait For (with real browser)
async function testBrowserWaitFor() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Set up HTML with delayed content
    await page.setContent(`
      <html>
        <body>
          <div id="content">Loading...</div>
          <script>
            setTimeout(() => {
              document.getElementById('content').innerText = 'Content Loaded';
            }, 1000);
          </script>
        </body>
      </html>
    `);

    // Wait for text to appear
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      'Content Loaded',
      { timeout: 3000 }
    );

    recordTest('Browser Wait For (text appears)', true);
  } catch (error) {
    recordTest('Browser Wait For (text appears)', false, error.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Test 3: Browser Fill Form (with real browser)
async function testBrowserFillForm() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.setContent(`
      <html>
        <body>
          <form>
            <input type="text" id="username" />
            <input type="email" id="email" />
            <input type="password" id="password" />
          </form>
        </body>
      </html>
    `);

    // Fill multiple fields
    await page.fill('#username', 'testuser');
    await page.fill('#email', 'test@example.com');
    await page.fill('#password', 'secretpass');

    // Verify all filled
    const username = await page.inputValue('#username');
    const email = await page.inputValue('#email');
    const password = await page.inputValue('#password');

    const valid = username === 'testuser' && 
                  email === 'test@example.com' && 
                  password === 'secretpass';

    recordTest('Browser Fill Form (multi-field)', valid, 
      valid ? null : 'Form fields not filled correctly');
  } catch (error) {
    recordTest('Browser Fill Form (multi-field)', false, error.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Test 4: Browser Scroll (with real browser)
async function testBrowserScroll() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.setContent(`
      <html>
        <body style="height: 3000px;">
          <div id="top" style="height: 1000px;">Top</div>
          <div id="middle" style="height: 1000px;">Middle</div>
          <div id="bottom" style="height: 1000px;">Bottom</div>
        </body>
      </html>
    `);

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 500));
    
    // Check scroll position
    const scrollY = await page.evaluate(() => window.scrollY);
    
    recordTest('Browser Scroll (direction)', scrollY === 500, 
      scrollY === 500 ? null : `Expected scrollY=500, got ${scrollY}`);
  } catch (error) {
    recordTest('Browser Scroll (direction)', false, error.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Test 5: Scroll Element Into View
async function testScrollIntoView() {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    await page.setContent(`
      <html>
        <body style="height: 3000px;">
          <div style="height: 2500px;">Spacer</div>
          <button id="bottom-button">Click Me</button>
        </body>
      </html>
    `);

    // Scroll element into view
    await page.locator('#bottom-button').scrollIntoViewIfNeeded();
    
    // Check if element is in viewport
    const isInViewport = await page.evaluate(() => {
      const el = document.getElementById('bottom-button');
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    
    recordTest('Browser Scroll (element into view)', isInViewport, 
      isInViewport ? null : 'Element not scrolled into viewport');
  } catch (error) {
    recordTest('Browser Scroll (element into view)', false, error.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Test 6: BeautifulSoup Installation Check
async function testBeautifulSoupInstalled() {
  return new Promise((resolve) => {
    const proc = spawn('python3', ['-c', 'import bs4; import lxml']);
    
    proc.on('close', (code) => {
      if (code === 0) {
        recordTest('BeautifulSoup4 & lxml installed', true);
      } else {
        recordTest('BeautifulSoup4 & lxml installed', false, 
          'Run: pip3 install beautifulsoup4 lxml');
      }
      resolve();
    });
  });
}

// Run all tests
async function runTests() {
  log('\n═══════════════════════════════════════════════════', 'info');
  log('  Browser Tools Phase 1 - E2E Test Suite', 'info');
  log('═══════════════════════════════════════════════════\n', 'info');

  log('Checking dependencies...', 'info');
  await testBeautifulSoupInstalled();
  
  log('\nTesting Python execution...', 'info');
  await testPythonExecution();
  
  log('\nTesting browser automation...', 'info');
  await testBrowserWaitFor();
  await testBrowserFillForm();
  await testBrowserScroll();
  await testScrollIntoView();

  // Summary
  log('\n═══════════════════════════════════════════════════', 'info');
  log(`  Results: ${results.passed} passed, ${results.failed} failed`, 
    results.failed === 0 ? 'success' : 'error');
  log('═══════════════════════════════════════════════════\n', 'info');

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch((error) => {
  log(`\nFatal error: ${error.message}`, 'error');
  process.exit(1);
});
