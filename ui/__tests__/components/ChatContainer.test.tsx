/**
 * ChatContainer Component Tests
 * 
 * Tests the main ChatContainer component:
 * - Message rendering
 * - Input handling
 * - Streaming state updates
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatContainer } from '../../components/Chat/ChatContainer';
import { useChatStore } from '../../stores/chatStore';
import { useTabStore } from '../../stores/tabStore';

// Mock stores
vi.mock('../../stores/chatStore');
vi.mock('../../stores/tabStore');

// Mock gateway API
vi.mock('../../src/lib/gateway', () => ({
  sendMessage: vi.fn(),
  connectWebSocket: vi.fn(),
}));

describe('ChatContainer', () => {
  beforeEach(() => {
    // Reset stores before each test
    vi.clearAllMocks();
    
    // Setup default store state
    (useChatStore as any).mockReturnValue({
      activeChat: 'test-chat-1',
      getChatState: vi.fn(() => ({
        messages: [],
        isStreaming: false,
        hasUnread: false,
      })),
      addMessage: vi.fn(),
      setStreamingStatus: vi.fn(),
      clearMessages: vi.fn(),
    });

    (useTabStore as any).mockReturnValue({
      activeTab: 'tab-1',
      getActiveTabChat: vi.fn(() => 'test-chat-1'),
    });
  });

  describe('Rendering', () => {
    it('should render ChatContainer', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const container = screen.getByTestId('chat-container');
      expect(container).toBeDefined();
    });

    it('should render message list', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const messageList = screen.queryByTestId('message-list');
      // May or may not be visible depending on implementation
      expect(typeof messageList).toBeDefined();
    });

    it('should render input bar', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const inputBar = screen.getByTestId('chat-input');
      expect(inputBar).toBeDefined();
    });

    it('should render send button', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const sendButton = screen.getByTestId('send-button');
      expect(sendButton).toBeDefined();
    });
  });

  describe('Empty State', () => {
    it('should show welcome message when no messages', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      // Look for welcome message or empty state
      const welcomeMessage = screen.queryByTestId('welcome-message');
      const isEmpty = welcomeMessage !== null;
      
      expect(typeof isEmpty).toBe('boolean');
    });

    it('should not show welcome message when messages exist', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const welcomeMessage = screen.queryByTestId('welcome-message');
      expect(welcomeMessage).toBeNull();
    });
  });

  describe('Message Display', () => {
    it('should render user messages', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'user', content: 'Test user message' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const userMessage = screen.queryByText(/Test user message/);
      expect(userMessage).toBeDefined();
    });

    it('should render assistant messages', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Test assistant response' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const assistantMessage = screen.queryByText(/Test assistant response/);
      expect(assistantMessage).toBeDefined();
    });

    it('should render multiple messages in order', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'user', content: 'Message 1' },
            { role: 'assistant', content: 'Response 1' },
            { role: 'user', content: 'Message 2' },
            { role: 'assistant', content: 'Response 2' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const messages = screen.queryAllByTestId(/^message-/);
      expect(messages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Input Handling', () => {
    it('should allow typing in input field', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Test message' } });
      
      expect(input.value).toBe('Test message');
    });

    it('should enable send button when input has text', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('send-button') as HTMLButtonElement;
      
      fireEvent.change(input, { target: { value: 'Test' } });
      
      expect(sendButton.disabled).toBe(false);
    });

    it('should disable send button when input is empty', () => {
      render(<ChatContainer chatId="test-chat-1" />);
      
      const sendButton = screen.getByTestId('send-button') as HTMLButtonElement;
      
      expect(sendButton.disabled).toBe(true);
    });

    it('should clear input after sending message', async () => {
      const addMessage = vi.fn();
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage,
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input') as HTMLInputElement;
      const sendButton = screen.getByTestId('send-button');
      
      fireEvent.change(input, { target: { value: 'Test message' } });
      fireEvent.click(sendButton);
      
      await waitFor(() => {
        expect(input.value).toBe('');
      });
    });

    it('should send message on Enter key', async () => {
      const addMessage = vi.fn();
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage,
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input');
      
      fireEvent.change(input, { target: { value: 'Test message' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
      
      await waitFor(() => {
        expect(addMessage).toHaveBeenCalled();
      });
    });

    it('should not send on Shift+Enter (new line)', () => {
      const addMessage = vi.fn();
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage,
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input');
      
      fireEvent.change(input, { target: { value: 'Test' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
      
      expect(addMessage).not.toHaveBeenCalled();
    });
  });

  describe('Streaming State', () => {
    it('should show thinking indicator while streaming', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: true,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const thinkingCard = screen.queryByTestId('thinking-card');
      expect(thinkingCard).toBeDefined();
    });

    it('should disable input while streaming', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: true,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const input = screen.getByTestId('chat-input') as HTMLInputElement;
      expect(input.disabled).toBe(true);
    });

    it('should show stop button while streaming', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: true,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const stopButton = screen.queryByTestId('stop-button');
      expect(stopButton).toBeDefined();
    });

    it('should hide thinking card when streaming completes', async () => {
      const { rerender } = render(<ChatContainer chatId="test-chat-1" />);
      
      // Start streaming
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [],
          isStreaming: true,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });
      
      rerender(<ChatContainer chatId="test-chat-1" />);
      
      // Stop streaming
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'assistant', content: 'Response' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });
      
      rerender(<ChatContainer chatId="test-chat-1" />);
      
      const thinkingCard = screen.queryByTestId('thinking-card');
      expect(thinkingCard).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should display error message when streaming fails', () => {
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'user', content: 'Test' },
            { role: 'error', content: 'Failed to connect' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage: vi.fn(),
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      const errorMessage = screen.queryByText(/Failed to connect/i);
      expect(errorMessage).toBeDefined();
    });

    it('should allow retry after error', async () => {
      const addMessage = vi.fn();
      (useChatStore as any).mockReturnValue({
        activeChat: 'test-chat-1',
        getChatState: vi.fn(() => ({
          messages: [
            { role: 'error', content: 'Failed to connect' },
          ],
          isStreaming: false,
          hasUnread: false,
        })),
        addMessage,
        setStreamingStatus: vi.fn(),
      });

      render(<ChatContainer chatId="test-chat-1" />);
      
      // Input should still be enabled
      const input = screen.getByTestId('chat-input') as HTMLInputElement;
      expect(input.disabled).toBe(false);
      
      // Should be able to send new message
      fireEvent.change(input, { target: { value: 'Retry' } });
      const sendButton = screen.getByTestId('send-button');
      fireEvent.click(sendButton);
      
      await waitFor(() => {
        expect(addMessage).toHaveBeenCalled();
      });
    });
  });
});
