/**
 * ExploringCard Component - Displays tool calls/actions
 * Matches ThinkingCard style - collapsible, minimal design
 * Shows detailed tool info like V1 (especially bash commands)
 */

import React, { useState, useEffect, useRef } from "react";
import type { ToolCall } from "../../types/core";
import "./ExploringCard.css";

interface ExploringCardProps {
  toolCalls: ToolCall[];
  isStreaming?: boolean;
}

/**
 * Extract filename from path for display (from V1)
 */
function getDisplayFilename(path: string): string {
  if (!path) return '';
  
  // Remove backslashes first (from escaped spaces)
  const cleanPath = path.replace(/\\/g, '');
  
  // Extract just the filename from the path
  const parts = cleanPath.split('/');
  let filename = parts[parts.length - 1];
  
  // If it looks like a document ID (UUID pattern), use generic name
  if (filename.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)) {
    return 'document';
  }
  
  // Remove common extensions for cleaner display
  filename = filename.replace(/-content\.md$/, '');
  filename = filename.replace(/\.md$/, '');
  
  // Truncate if too long
  if (filename.length > 30) {
    filename = filename.substring(0, 27) + '...';
  }
  
  return filename;
}

/**
 * Convert bash commands to customer-friendly descriptions (from V1)
 */
function getBashCommandDescription(command: string, isRunning: boolean = true): string {
  const cmd = command.trim();
  const prefix = isRunning ? 'Running' : 'Ran';
  
  // curl - fetching web content
  if (cmd.startsWith('curl')) {
    const urlMatch = cmd.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const domain = urlMatch[0].replace(/^https?:\/\//, '').split('/')[0];
      return isRunning ? `Getting info from ${domain}` : `Got info from ${domain}`;
    }
    return isRunning ? 'Fetching web content' : 'Fetched web content';
  }
  
  // cat with heredoc (>) - writing/updating files
  if (cmd.includes('cat >') && cmd.includes('<<')) {
    const pathMatch = cmd.match(/cat\s+>\s+((?:[^\s<]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ''));
      if (filename) {
        return isRunning ? `Updating ${filename}` : `Updated ${filename}`;
      }
    }
    return isRunning ? 'Updating document' : 'Updated document';
  }
  
  // cat (reading files)
  if (cmd.startsWith('cat ') && !cmd.includes('>')) {
    const pathMatch = cmd.match(/cat\s+((?:[^\s|;&]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ''));
      if (filename) {
        return isRunning ? `Reading ${filename}` : `Read ${filename}`;
      }
    }
    return isRunning ? 'Reading file' : 'Read file';
  }
  
  // grep - searching
  if (cmd.startsWith('grep')) {
    const searchMatch = cmd.match(/grep.*["']([^"']+)["']/);
    if (searchMatch) {
      const searchTerm = searchMatch[1].substring(0, 20);
      return isRunning ? `Searching for "${searchTerm}"` : `Searched for "${searchTerm}"`;
    }
    if (cmd.includes('documents/')) {
      return isRunning ? 'Searching documents' : 'Searched documents';
    }
    return isRunning ? 'Searching files' : 'Searched files';
  }
  
  // ls - listing
  if (cmd.startsWith('ls')) {
    const pathMatch = cmd.match(/ls\s+[^\s]*\s+([^\s]+)/);
    if (pathMatch) {
      const dirname = getDisplayFilename(pathMatch[1]);
      if (dirname) {
        return isRunning ? `Listing ${dirname}` : `Listed ${dirname}`;
      }
    }
    return isRunning ? 'Listing files' : 'Listed files';
  }
  
  // npm/yarn - package management
  if (cmd.includes('npm install') || cmd.includes('yarn add')) {
    const pkgMatch = cmd.match(/(?:npm install|yarn add)\s+([^\s]+)/);
    if (pkgMatch) {
      return isRunning ? `Installing ${pkgMatch[1]}` : `Installed ${pkgMatch[1]}`;
    }
    return isRunning ? 'Installing packages' : 'Installed packages';
  }
  if (cmd.includes('npm run') || cmd.includes('yarn')) {
    return isRunning ? 'Running build' : 'Ran build';
  }
  
  // git operations
  if (cmd.startsWith('git clone')) {
    const urlMatch = cmd.match(/git clone\s+[^\s]*\/([^\s/]+?)(?:\.git)?(?:\s|$)/);
    if (urlMatch) {
      return isRunning ? `Cloning ${urlMatch[1]}` : `Cloned ${urlMatch[1]}`;
    }
    return isRunning ? 'Cloning repository' : 'Cloned repository';
  }
  if (cmd.startsWith('git pull')) {
    return isRunning ? 'Updating repository' : 'Updated repository';
  }
  
  // mkdir - creating directories
  if (cmd.startsWith('mkdir')) {
    const pathMatch = cmd.match(/mkdir\s+(?:-p\s+)?([^\s]+)/);
    if (pathMatch) {
      const dirname = getDisplayFilename(pathMatch[1]);
      if (dirname) {
        return isRunning ? `Creating ${dirname}` : `Created ${dirname}`;
      }
    }
    return isRunning ? 'Creating folder' : 'Created folder';
  }
  
  // rm - deleting
  if (cmd.startsWith('rm')) {
    const pathMatch = cmd.match(/rm\s+(?:-[rf]+\s+)?((?:[^\s]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ''));
      if (filename) {
        return isRunning ? `Deleting ${filename}` : `Deleted ${filename}`;
      }
    }
    return isRunning ? 'Deleting files' : 'Deleted files';
  }
  
  // cp - copying
  if (cmd.startsWith('cp ')) {
    const pathMatch = cmd.match(/cp\s+(?:-[rf]+\s+)?((?:[^\s]|\\.)+)\s+((?:[^\s]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[2].replace(/\\/g, ''));
      if (filename) {
        return isRunning ? `Copying to ${filename}` : `Copied to ${filename}`;
      }
    }
    return isRunning ? 'Copying files' : 'Copied files';
  }
  
  // mv - moving
  if (cmd.startsWith('mv ')) {
    const pathMatch = cmd.match(/mv\s+((?:[^\s]|\\.)+)\s+((?:[^\s]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[2].replace(/\\/g, ''));
      if (filename) {
        return isRunning ? `Moving to ${filename}` : `Moved to ${filename}`;
      }
    }
    return isRunning ? 'Moving files' : 'Moved files';
  }
  
  // Default: show abbreviated command
  const shortCmd = cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
  return `${prefix}: ${shortCmd}`;
}

/**
 * Get display text for tool call (matches V1 behavior)
 */
function getToolCallDisplayText(toolCall: ToolCall): string {
  const isRunning = toolCall.status === "calling";
  
  // Handle bash commands specially - translate to customer-friendly descriptions
  if (toolCall.toolName === 'bash' && toolCall.args?.command) {
    return getBashCommandDescription(toolCall.args.command as string, isRunning);
  }
  
  // Map tool names to friendly descriptions
  const toolDescriptions: Record<string, { running: string; complete: string }> = {
    'create_document': { running: 'Creating document', complete: 'Document created' },
    'read_document': { running: 'Reading document', complete: 'Document read' },
    'update_document': { running: 'Updating document', complete: 'Document updated' },
    'list_documents': { running: 'Listing documents', complete: 'Documents listed' },
    'create_app': { running: 'Creating app', complete: 'App created' },
    'read_app': { running: 'Reading app', complete: 'App read' },
    'update_app': { running: 'Updating app', complete: 'App updated' },
    'list_apps': { running: 'Listing apps', complete: 'Apps listed' },
    'bash': { running: 'Running command', complete: 'Command completed' },
  };
  
  const desc = toolDescriptions[toolCall.toolName];
  if (desc) {
    return isRunning ? desc.running : desc.complete;
  }
  
  // Fallback: convert snake_case to Title Case
  const friendlyName = toolCall.toolName.replace(/_/g, ' ');
  return isRunning 
    ? `${friendlyName}...`
    : friendlyName;
}

export const ExploringCard: React.FC<ExploringCardProps> = ({
  toolCalls,
  isStreaming = false,
}) => {
  // Start collapsed (can be manually expanded by user)
  // V1 behavior: Keep card open showing completed tool calls, with assistant text below
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Don't show if there are no tool calls
  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="exploring-card">
      <div className="exploring-card-header" onClick={() => setIsCollapsed(!isCollapsed)}>
        <span className={`exploring-chevron ${isCollapsed ? "exploring-chevron-collapsed" : ""}`}>
          ▼
        </span>
        <span className="exploring-label-text">
          Exploring
        </span>
      </div>
      <div 
        className="exploring-card-content"
        style={{
          maxHeight: isCollapsed ? '0px' : '200px',
          opacity: isCollapsed ? '0' : '1',
        }}
      >
        {toolCalls.map((toolCall, index) => {
          const displayText = getToolCallDisplayText(toolCall);
          
          // Determine status indicator
          let statusIndicator = null;
          if (toolCall.status === 'calling') {
            // Loading indicator - liquid glass style pulsing dot
            statusIndicator = (
              <span className="exploring-tool-loading">
                <span className="exploring-tool-dot"></span>
              </span>
            );
          } else if (toolCall.status === 'success') {
            // Success checkmark
            statusIndicator = <span className="exploring-tool-success">✓</span>;
          } else if (toolCall.status === 'error') {
            // Error X
            statusIndicator = <span className="exploring-tool-error">✗</span>;
          }
          
          return (
            <div key={toolCall.id || index} className="exploring-tool-item">
              <span className="exploring-tool-arrow">→</span>
              <span className="exploring-tool-name">{displayText}</span>
              {statusIndicator}
            </div>
          );
        })}
      </div>
    </div>
  );
};
