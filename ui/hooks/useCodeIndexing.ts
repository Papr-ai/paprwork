/**
 * useCodeIndexing Hook
 * 
 * Fetches code indexing status from Gateway via WebSocket.
 * Polls every 5 seconds for real-time updates.
 */

import { useState, useEffect } from 'react';
import { gateway } from '../src/lib/gateway';
import type { CodeIndexingStatus } from '../types/settings';

export function useCodeIndexing() {
  const [status, setStatus] = useState<CodeIndexingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const fetchStatus = async () => {
      try {
        // Fetch both code indexing status and chat stats in parallel
        const [codeResponse, chatResponse] = await Promise.all([
          gateway.send('code-indexing:status', {}),
          gateway.send('memory:chat-stats', {})
        ]);
        
        if (!isMounted) return;

        if (codeResponse.success && codeResponse.data) {
          const codeStatus = codeResponse.data as CodeIndexingStatus;
          
          // Merge chat stats if available
          if (chatResponse.success && chatResponse.data) {
            const chatData = chatResponse.data as {
              total_conversations: number;
              total_messages: number;
              last_indexed_at: string | null;
            };
            
            codeStatus.chat_stats = {
              total_chats: chatData.total_conversations,
              total_messages: chatData.total_messages,
              last_indexed: chatData.last_indexed_at
            };
          }
          
          setStatus(codeStatus);
          setError(null);
        } else {
          setError(codeResponse.error || 'Failed to fetch status');
        }
      } catch (err) {
        if (!isMounted) return;
        setError((err as Error).message);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    // Initial fetch
    fetchStatus();

    // Poll every 5 seconds
    const interval = setInterval(fetchStatus, 5000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return { status, loading, error };
}
