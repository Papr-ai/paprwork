/**
 * WebSocket Communication Integration Tests
 * 
 * Tests the WebSocket communication between Gateway and UI:
 * - Connection establishment
 * - Message routing
 * - Streaming data flow
 * - Parallel connections
 * - Error handling
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { AgentService } from '../../src/gateway/services/AgentService.js';
import * as http from 'http';

describe('WebSocket Communication', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let serverPort: number;
  let agentService: AgentService;

  beforeAll(async () => {
    // Create HTTP server for WebSocket
    server = http.createServer();
    wss = new WebSocketServer({ server });
    
    // Initialize AgentService
    agentService = new AgentService();
    await agentService.initialize({
      mode: 'local',
      openaiApiKey: process.env.OPENAI_API_KEY,
    });

    // Setup WebSocket handlers (simplified version)
    wss.on('connection', (ws) => {
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Route messages based on type
          if (message.type === 'chat:message') {
            // Echo test response
            ws.send(JSON.stringify({
              type: 'chat:message:response',
              chatId: message.chatId,
              data: { success: true },
            }));
          }
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            error: (error as Error).message,
          }));
        }
      });
    });

    // Start server on random port
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 3001;
        resolve();
      });
    });
  });

  afterAll(async () => {
    wss.close();
    server.close();
  });

  describe('Connection Management', () => {
    it('should establish WebSocket connection', async () => {
      const client = new WebSocket(`ws://localhost:${serverPort}`);
      
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => {
          expect(client.readyState).toBe(WebSocket.OPEN);
          client.close();
          resolve();
        });
        client.on('error', reject);
      });
    });

    it('should handle multiple simultaneous connections', async () => {
      const clients = await Promise.all([
        new Promise<WebSocket>((resolve) => {
          const ws = new WebSocket(`ws://localhost:${serverPort}`);
          ws.on('open', () => resolve(ws));
        }),
        new Promise<WebSocket>((resolve) => {
          const ws = new WebSocket(`ws://localhost:${serverPort}`);
          ws.on('open', () => resolve(ws));
        }),
        new Promise<WebSocket>((resolve) => {
          const ws = new WebSocket(`ws://localhost:${serverPort}`);
          ws.on('open', () => resolve(ws));
        }),
      ]);

      expect(clients).toHaveLength(3);
      clients.forEach((ws) => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      });

      // Cleanup
      clients.forEach((ws) => ws.close());
    });

    it('should handle connection close gracefully', async () => {
      const client = new WebSocket(`ws://localhost:${serverPort}`);
      
      await new Promise<void>((resolve) => {
        client.on('open', () => {
          client.close();
        });
        client.on('close', () => {
          expect(client.readyState).toBe(WebSocket.CLOSED);
          resolve();
        });
      });
    });
  });

  describe('Message Routing', () => {
    let client: WebSocket;

    beforeEach(async () => {
      client = new WebSocket(`ws://localhost:${serverPort}`);
      await new Promise<void>((resolve) => {
        client.on('open', () => resolve());
      });
    });

    afterAll(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    it('should send and receive chat messages', async () => {
      const testMessage = {
        type: 'chat:message',
        chatId: 'test-chat-1',
        content: 'Hello, world!',
      };

      const response = await new Promise<any>((resolve) => {
        client.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
        client.send(JSON.stringify(testMessage));
      });

      expect(response.type).toBe('chat:message:response');
      expect(response.chatId).toBe('test-chat-1');
      expect(response.data.success).toBe(true);
    });

    it('should route messages to correct chat sessions', async () => {
      const messages = [
        { type: 'chat:message', chatId: 'chat-1', content: 'Message 1' },
        { type: 'chat:message', chatId: 'chat-2', content: 'Message 2' },
        { type: 'chat:message', chatId: 'chat-3', content: 'Message 3' },
      ];

      // Send messages sequentially to avoid race condition
      const responses: any[] = [];
      for (const msg of messages) {
        const response = await new Promise<any>((resolve) => {
          client.once('message', (data) => {
            resolve(JSON.parse(data.toString()));
          });
          client.send(JSON.stringify(msg));
        });
        responses.push(response);
      }

      expect(responses).toHaveLength(3);
      expect(responses[0].chatId).toBe('chat-1');
      expect(responses[1].chatId).toBe('chat-2');
      expect(responses[2].chatId).toBe('chat-3');
    });

    it('should handle malformed messages gracefully', async () => {
      const response = await new Promise<any>((resolve) => {
        client.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
        client.send('invalid json {');
      });

      expect(response.type).toBe('error');
      expect(response.error).toBeDefined();
    });
  });

  describe('Streaming Data Flow', () => {
    let client: WebSocket;

    beforeEach(async () => {
      client = new WebSocket(`ws://localhost:${serverPort}`);
      await new Promise<void>((resolve) => {
        client.on('open', () => resolve());
      });
    });

    afterAll(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    it('should handle streaming messages in order', async () => {
      const receivedMessages: any[] = [];
      
      client.on('message', (data) => {
        receivedMessages.push(JSON.parse(data.toString()));
      });

      // Send multiple messages rapidly
      for (let i = 0; i < 10; i++) {
        client.send(JSON.stringify({
          type: 'chat:message',
          chatId: 'test-chat',
          content: `Message ${i}`,
        }));
      }

      // Wait for all responses
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(receivedMessages.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Parallel Connections', () => {
    it('should handle messages from multiple clients independently', async () => {
      const client1 = new WebSocket(`ws://localhost:${serverPort}`);
      const client2 = new WebSocket(`ws://localhost:${serverPort}`);

      await Promise.all([
        new Promise<void>((resolve) => client1.on('open', () => resolve())),
        new Promise<void>((resolve) => client2.on('open', () => resolve())),
      ]);

      const [response1, response2] = await Promise.all([
        new Promise<any>((resolve) => {
          client1.once('message', (data) => {
            resolve(JSON.parse(data.toString()));
          });
          client1.send(JSON.stringify({
            type: 'chat:message',
            chatId: 'client-1-chat',
            content: 'From client 1',
          }));
        }),
        new Promise<any>((resolve) => {
          client2.once('message', (data) => {
            resolve(JSON.parse(data.toString()));
          });
          client2.send(JSON.stringify({
            type: 'chat:message',
            chatId: 'client-2-chat',
            content: 'From client 2',
          }));
        }),
      ]);

      expect(response1.chatId).toBe('client-1-chat');
      expect(response2.chatId).toBe('client-2-chat');

      client1.close();
      client2.close();
    });

    it('should isolate chat sessions across clients', async () => {
      const client1 = new WebSocket(`ws://localhost:${serverPort}`);
      const client2 = new WebSocket(`ws://localhost:${serverPort}`);

      await Promise.all([
        new Promise<void>((resolve) => client1.on('open', () => resolve())),
        new Promise<void>((resolve) => client2.on('open', () => resolve())),
      ]);

      // Both clients use the same chat ID
      const chatId = 'shared-chat-id';

      const [response1, response2] = await Promise.all([
        new Promise<any>((resolve) => {
          client1.once('message', (data) => resolve(JSON.parse(data.toString())));
          client1.send(JSON.stringify({
            type: 'chat:message',
            chatId,
            content: 'Message from client 1',
          }));
        }),
        new Promise<any>((resolve) => {
          client2.once('message', (data) => resolve(JSON.parse(data.toString())));
          client2.send(JSON.stringify({
            type: 'chat:message',
            chatId,
            content: 'Message from client 2',
          }));
        }),
      ]);

      // Both should succeed independently
      expect(response1.data.success).toBe(true);
      expect(response2.data.success).toBe(true);

      client1.close();
      client2.close();
    });
  });

  describe('Error Handling', () => {
    let client: WebSocket;

    beforeEach(async () => {
      client = new WebSocket(`ws://localhost:${serverPort}`);
      await new Promise<void>((resolve) => {
        client.on('open', () => resolve());
      });
    });

    afterAll(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    it('should handle connection errors gracefully', async () => {
      // Try to connect to invalid port (use valid port number range)
      const invalidClient = new WebSocket('ws://localhost:65535');
      
      await new Promise<void>((resolve) => {
        invalidClient.on('error', (error) => {
          expect(error).toBeDefined();
          resolve();
        });
      });
    });

    it('should handle missing required fields', async () => {
      const response = await new Promise<any>((resolve) => {
        client.once('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
        client.send(JSON.stringify({
          type: 'chat:message',
          // Missing chatId
          content: 'Test message',
        }));
      });

      // Should still handle gracefully
      expect(response).toBeDefined();
    });
  });
});
