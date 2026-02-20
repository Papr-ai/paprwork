# Auto-Focus Input on Tab Switch

## Implementation

Added automatic focus to the chat input when:
1. Opening a new chat tab
2. Switching to an existing chat tab

## Changes

### 1. InputBar - Added forwardRef and focus method

```typescript
// ui/components/Chat/InputBar.tsx

export interface InputBarRef {
  focus: () => void;
}

export const InputBar = forwardRef<InputBarRef, InputBarProps>(({...}, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expose focus method to parent
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // ... rest of component
});
```

### 2. ChatContainer - Focus on tab change

```typescript
// ui/components/Chat/ChatContainer.tsx

export const ChatContainer: React.FC = () => {
  const { activeTabId } = useTabStore();
  const inputBarRef = useRef<InputBarRef>(null);

  // Focus input when active tab changes (user switches chats)
  useEffect(() => {
    if (activeTabId) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        inputBarRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [activeTabId]);

  return (
    <div className="chat-container">
      <MessageList messages={messages} isLoading={isLoading} />
      <InputBar
        ref={inputBarRef}
        onSend={handleSendMessage}
        // ...
      />
    </div>
  );
};
```

## Behavior

- **New chat tab:** Input is focused immediately, user can start typing
- **Switch tabs:** Input is focused after 50ms (ensures DOM is ready)
- **After sending message:** Input stays focused for next message
- **Model picker:** Focus returns to input after selecting a model

## Testing

1. Open app → Input should be focused
2. Create new chat → Input should be focused
3. Switch between chat tabs → Input should be focused on each switch
4. Send a message → Input should stay focused
5. Open model picker → Focus should return after selection
