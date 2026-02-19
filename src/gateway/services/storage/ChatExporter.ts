/**
 * Chat Export Utility
 * 
 * Exports chat history to human-readable text files in ~/PAPR/Chats/
 * Allows agents to search full history using bash/grep tools
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import type { StoredMessage } from './IStorageProvider.js';

export class ChatExporter {
  private paprPath: string;
  private chatsPath: string;
  private artifactsPath: string;
  private jobsPath: string;

  constructor() {
    this.paprPath = path.join(os.homedir(), 'Papr');
    this.chatsPath = path.join(this.paprPath, 'Chats');
    this.artifactsPath = path.join(this.paprPath, 'Artifacts');
    this.jobsPath = path.join(this.paprPath, 'Jobs');
  }

  /**
   * Initialize Papr folder structure and add to Finder sidebar
   */
  async initialize(): Promise<void> {
    // Create folder structure
    await fs.ensureDir(this.chatsPath);
    await fs.ensureDir(this.artifactsPath);
    await fs.ensureDir(this.jobsPath);
    await fs.ensureDir(path.join(this.paprPath, '.sync')); // Hidden sync metadata

    // Add to Finder sidebar (macOS only)
    if (process.platform === 'darwin') {
      await this.addToFinderSidebar();
    }
  }

  /**
   * Export chat to readable text file
   * @param chatId - Chat session ID
   * @param title - Chat title
   * @param messages - All messages in chat
   * @returns Path to exported file
   */
  async exportChat(
    chatId: string,
    title: string | null,
    messages: StoredMessage[]
  ): Promise<string> {
    await this.initialize();

    // Generate filename (sanitize title)
    const safeTitle = title 
      ? this.sanitizeFilename(title)
      : chatId;
    const fileName = `${safeTitle}.txt`;
    const filePath = path.join(this.chatsPath, fileName);

    // Check if already exported recently (within last 5 minutes)
    try {
      const stats = await fs.stat(filePath);
      const age = Date.now() - stats.mtimeMs;
      if (age < 5 * 60 * 1000) {
        return filePath; // Already exported recently
      }
    } catch {
      // File doesn't exist, continue with export
    }

    // Format chat content
    const content = this.formatChatForExport(chatId, title, messages);

    // Write to file (fs-extra supports both callbacks and promises)
    await fs.outputFile(filePath, content, 'utf8');

    return filePath;
  }

  /**
   * Format chat messages as human-readable text
   */
  private formatChatForExport(
    chatId: string,
    title: string | null,
    messages: StoredMessage[]
  ): string {
    const header = `${title || chatId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Chat ID: ${chatId}
Created: ${messages[0]?.timestamp ? new Date(messages[0].timestamp).toLocaleString() : 'N/A'}
Messages: ${messages.length}
Models Used: ${this.getUniqueModels(messages).join(', ') || 'N/A'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

    const body = messages.map(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const parts: string[] = [];
      
      // Add main content
      if (msg.content) {
        parts.push(msg.content);
      }
      
      // Add thinking if present
      if (msg.thinking) {
        parts.push(`\n[Thinking]\n${msg.thinking}`);
      }
      
      // Add tool calls if present
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        parts.push('\n[Tool Calls]');
        for (const tool of msg.toolCalls) {
          parts.push(`\n• ${tool.name}(${JSON.stringify(tool.args, null, 2)})`);
          if (tool.result) {
            const resultStr = typeof tool.result === 'string' 
              ? tool.result 
              : JSON.stringify(tool.result, null, 2);
            // Truncate long results in export
            const truncated = resultStr.length > 500 
              ? resultStr.substring(0, 500) + `\n  ... (${resultStr.length - 500} more chars)` 
              : resultStr;
            parts.push(`  Result: ${truncated}`);
          }
        }
      }
      
      const content = parts.join('\n');

      return `[${role} - ${time}]
${content}
`;
    }).join('\n');

    const footer = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Sync Status: ${this.getSyncStatus(messages)}
Last Updated: ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return header + body + footer;
  }

  /**
   * Sanitize filename for file system
   */
  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, '-') // Replace invalid chars
      .replace(/\s+/g, ' ')            // Collapse multiple spaces
      .trim()
      .substring(0, 200);              // Limit length
  }

  /**
   * Get unique models used in conversation
   */
  private getUniqueModels(messages: StoredMessage[]): string[] {
    const models = messages
      .map(m => m.model)
      .filter((m): m is string => !!m);
    return [...new Set(models)];
  }

  /**
   * Get sync status summary
   */
  private getSyncStatus(messages: StoredMessage[]): string {
    const synced = messages.filter(m => m.sync_status === 'synced').length;
    const total = messages.length;

    if (synced === total) {
      return `Synced to PAPR Memory ✓`;
    } else if (synced === 0) {
      return 'Local only';
    } else {
      return `Partially synced (${synced}/${total} messages)`;
    }
  }

  /**
   * Get PAPR folder path
   */
  getPaprPath(): string {
    return this.paprPath;
  }

  /**
   * Get Chats folder path
   */
  getChatsPath(): string {
    return this.chatsPath;
  }

  /**
   * Add Papr folder to Finder sidebar (macOS only)
   * 
   * Note: Folders appear in the "Favorites" section of Finder sidebar.
   * The "Locations" section is reserved for volumes (drives, network shares, cloud providers).
   * Papr will appear in Favorites, similar to Desktop, Documents, Downloads, etc.
   */
  private async addToFinderSidebar(): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Add to Finder Favorites using sfltool
      // This is the official way to add folders to the sidebar
      const command = `sfltool add-item com.apple.LSSharedFileList.FavoriteItems file://${this.paprPath}`;
      
      try {
        await execAsync(command);
        console.log(`✓ Added ~/Papr/ to Finder sidebar (Favorites section)`);
      } catch (error: any) {
        // Silently ignore if it already exists
        if (!error.contentincludes('already exists') && !error.contentincludes('not found')) {
          console.warn('Note: Could not automatically add to Finder sidebar.');
          console.warn('You can manually add it by dragging ~/Papr to the Finder sidebar.');
        }
      }

      // Note: To appear in "Locations" like Dropbox, the folder would need to be:
      // - A mounted volume (diskutil)
      // - A network share (SMB/AFP)  
      // - A cloud storage provider (using File Provider extension)
      // Regular folders always go in "Favorites", not "Locations"
      
    } catch (error) {
      // Fail silently - users can manually add the folder if needed
    }
  }
}
