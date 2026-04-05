#!/usr/bin/env tsx
/**
 * Test ChatExporter and ~/Papr/ folder creation
 * Tests folder structure, file exports, and Finder integration
 */
import { ChatExporter } from '../src/gateway/services/storage/ChatExporter';
import type { StoredMessage } from '../src/gateway/services/storage/IStorageProvider';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testChatExporter() {
  console.log('🧪 Testing ChatExporter and ~/Papr/ Folder\n');

  const exporter = new ChatExporter();
  const paprPath = path.join(os.homedir(), 'Papr');

  try {
    // Test 1: Initialize Papr folder structure
    console.log('📝 Test 1: Initializing ~/Papr/ folder structure...');
    await exporter.initialize();
    console.log(`✓ Papr folder initialized at: ${paprPath}\n`);

    //Test 2: Verify folder structure
    console.log('📝 Test 2: Verifying folder structure...');
    const folders = ['Chats', 'Artifacts', 'Jobs'];
    
    for (const folder of folders) {
      const folderPath = path.join(paprPath, folder);
      const exists = existsSync(folderPath);
      if (!exists) {
        throw new Error(`Folder not created: ${folder}`);
      }
      console.log(`✓ ${folder}/ exists`);
    }
    console.log('');

    // Test 3: Check if folder is in Finder sidebar (macOS only)
    if (process.platform === 'darwin') {
      console.log('📝 Test 3: Checking Finder sidebar integration...');
      try {
        const { stdout } = await execAsync('sfltool dump-lists');
        if (stdout.includes('Papr') || stdout.includes(paprPath)) {
          console.log('✓ Papr folder found in Finder favorites\n');
        } else {
          console.log('⚠️  Papr folder not in Finder sidebar yet (may take a moment)\n');
        }
      } catch (error) {
        console.log('⚠️  Could not check Finder sidebar (sfltool requires Full Disk Access)\n');
      }
    } else {
      console.log('ℹ️  Skipping Finder test (not macOS)\n');
    }

    // Test 4: Export a chat
    console.log('📝 Test 4: Exporting a chat...');
    const testChatId = `test-export-${Date.now()}`;
    const testMessages: StoredMessage[] = [
      {
        id: 'msg-1',
        chat_id: testChatId,
        message: 'How do I create a React component?',
        message_role: 'user',
        timestamp: new Date().toISOString(),
        sync_status: 'local',
      },
      {
        id: 'msg-2',
        chat_id: testChatId,
        message: 'Here\'s a simple React component:\n\n```tsx\nfunction MyComponent() {\n  return <div>Hello World</div>;\n}\n```',
        message_role: 'assistant',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        sync_status: 'local',
      },
      {
        id: 'msg-3',
        chat_id: testChatId,
        message: 'Can you add state to it?',
        message_role: 'user',
        timestamp: new Date(Date.now() + 2000).toISOString(),
        sync_status: 'local',
      },
      {
        id: 'msg-4',
        chat_id: testChatId,
        message: 'Sure! Here\'s the component with state:\n\n```tsx\nimport { useState } from \'react\';\n\nfunction MyComponent() {\n  const [count, setCount] = useState(0);\n  return (\n    <div>\n      <p>Count: {count}</p>\n      <button onClick={() => setCount(count + 1)}>Increment</button>\n    </div>\n  );\n}\n```',
        message_role: 'assistant',
        timestamp: new Date(Date.now() + 3000).toISOString(),
        sync_status: 'local',
      },
    ];

    await exporter.exportChat(testChatId, 'React Component Tutorial', testMessages);
    console.log(`✓ Chat exported to ~/Papr/Chats/\n`);

    // Test 5: Verify exported file
    console.log('📝 Test 5: Verifying exported file...');
    const chatFiles = await fs.readdir(path.join(paprPath, 'Chats'));
    const exportedFile = chatFiles.find(f => f.includes('React Component Tutorial'));
    
    if (!exportedFile) {
      throw new Error('Exported chat file not found!');
    }
    
    const exportedFilePath = path.join(paprPath, 'Chats', exportedFile);
    console.log(`✓ File found: ${exportedFile}`);
    
    const content = await fs.readFile(exportedFilePath, 'utf-8');
    console.log(`✓ File size: ${content.length} bytes`);
    
    // Verify content
    if (!content.includes('React Component Tutorial')) {
      throw new Error('Title not found in exported file!');
    }
    if (!content.includes('How do I create a React component?')) {
      throw new Error('User message not found in exported file!');
    }
    if (!content.includes('```tsx')) {
      throw new Error('Code block not found in exported file!');
    }
    console.log('✓ Content verified (title, messages, code blocks)\n');

    // Test 6: Show file preview
    console.log('📝 Test 6: File content preview...');
    const lines = content.split('\n');
    console.log('First 20 lines:');
    console.log('─'.repeat(60));
    lines.slice(0, 20).forEach(line => console.log(line));
    console.log('─'.repeat(60));
    console.log(`... (${lines.length} total lines)\n`);

    // Test 7: List all exported chats
    console.log('📝 Test 7: Listing all exported chats...');
    const allChatFiles = await fs.readdir(path.join(paprPath, 'Chats'));
    console.log(`✓ Found ${allChatFiles.length} exported chat(s):`);
    allChatFiles.forEach((file, idx) => {
      console.log(`   ${idx + 1}. ${file}`);
    });
    console.log('');

    // Test 8: Clean up test file
    console.log('📝 Test 8: Cleaning up test export...');
    await fs.unlink(exportedFilePath);
    console.log('✓ Test file removed\n');

    console.log('✅ All ChatExporter tests passed!\n');
    
    console.log('🎉 Summary:');
    console.log(`   - Papr folder: ${paprPath}`);
    console.log(`   - Chats folder: ${path.join(paprPath, 'Chats')}`);
    console.log(`   - Artifacts folder: ${path.join(paprPath, 'Artifacts')}`);
    console.log(`   - Jobs folder: ${path.join(paprPath, 'Jobs')}`);
    console.log('\n💡 You can now open Finder and navigate to ~/Papr/ to see the folder!');
    console.log('   The folder should appear in your Finder sidebar under Favorites.');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

testChatExporter().catch(console.error);
