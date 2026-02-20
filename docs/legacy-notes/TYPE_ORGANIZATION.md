# Type Organization - Centralized Type System

## Overview

Implemented centralized type organization following best practices for large TypeScript applications. All shared types are now in dedicated type files for consistency and reusability.

## Structure

```
ui/types/
├── index.ts          # Central export (import all types from here)
├── chat.ts           # Chat-related types
├── tabs.ts           # Tab system types
├── settings.ts       # Settings types
└── electron.d.ts     # Electron IPC types
```

## Type Files

### 1. `ui/types/chat.ts`

**Purpose**: All chat-related types

**Exports**:
```typescript
interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isStreaming?: boolean;
  hasUnread?: boolean;
}

interface ChatMessage extends CoreMessage {
  id: string;
  isStreaming?: boolean;
  streamingContent?: string;
}

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isSending: boolean;
  isStreaming: boolean;
  hasUnread: boolean;
}

interface CreateChatPayload { ... }
interface UpdateChatPayload { ... }
interface DeleteChatPayload { ... }
```

### 2. `ui/types/tabs.ts`

**Purpose**: Tab system types

**Exports**:
```typescript
type TabType = "chat" | "document" | "app" | ...;
type DisplayMode = "standalone" | "parent" | "child";
type DragPosition = "before" | "after" | "on-top" | null;

interface Tab {
  id: string;
  type: TabType;
  entityId: string;
  title: string;
  icon?: string;
  parentTabId: string | null;
  childTabIds: string[];
  displayMode: DisplayMode;
  position?: "left" | "right";
  metadata?: Record<string, unknown>;
}

interface TabDragData {
  tabId: string;
  tabIndex: number;
}
```

### 3. `ui/types/settings.ts`

**Purpose**: Settings and configuration types

**Exports**:
```typescript
interface CustomKey { ... }
interface CustomKeyInput { ... }
interface ProviderConfig { ... }
interface AppPreferences { ... }
interface UserProfile { ... }
type PermissionLevel = "open" | "moderate" | "strict";
type SettingsTab = "keys" | "profile" | "permissions";
```

### 4. `ui/types/index.ts`

**Purpose**: Central export point for all types

**Usage**:
```typescript
// Preferred: Import from central location
import type { ChatMessage, Tab, CustomKey } from "../types";

// Also works: Import from specific file
import type { ChatMessage } from "../types/chat";
```

## Migration Strategy

### Before (Types scattered in components):
```typescript
// In chatStore.ts
export interface ChatMessage { ... }

// In Tab.tsx
import type { ChatMessage } from "../../stores/chatStore";

// In ChatContainer.tsx
import type { ChatMessage } from "../../stores/chatStore";
```

**Problems**:
- Types defined in stores, not reusable
- Circular dependency risk
- Hard to find type definitions
- Components coupled to stores

### After (Centralized types):
```typescript
// In ui/types/chat.ts
export interface ChatMessage { ... }

// In chatStore.ts
import type { ChatMessage } from "../types/chat";
export type { ChatMessage }; // Re-export for compatibility

// In Tab.tsx
import type { ChatMessage } from "../../types";

// In ChatContainer.tsx
import type { ChatMessage } from "../../types";
```

**Benefits**:
- ✅ Single source of truth
- ✅ Easy to find types
- ✅ No circular dependencies
- ✅ Components decoupled from stores
- ✅ Better IDE autocomplete
- ✅ Easier refactoring

## Usage Guidelines

### ✅ DO:
```typescript
// Import from central index
import type { ChatMessage, Tab, CustomKey } from "../types";

// Import from specific file if needed
import type { ChatMessage } from "../types/chat";

// Define component-specific props in component file
interface MyComponentProps {
  chat: ChatMessage;
  onSelect: (id: string) => void;
}
```

### ❌ DON'T:
```typescript
// Don't define shared types in components
export interface ChatMessage { ... } // Should be in types/chat.ts

// Don't define shared types in stores
export interface Tab { ... } // Should be in types/tabs.ts

// Don't skip type imports
const messages = []; // Should be: ChatMessage[]
```

## Type Categories

### Domain Types (in `types/`)
- Represent domain entities (Chat, Tab, CustomKey)
- Shared across multiple components
- Should be in dedicated type files

### Component Props (in component files)
- Specific to single component
- Not reused elsewhere
- Can stay in component file:
  ```typescript
  // In MyComponent.tsx
  interface MyComponentProps {
    title: string;
    onClick: () => void;
  }
  ```

### Store Types (in stores/)
- Internal store implementation details
- Not exported, used only by that store
- Example: Helper types, internal state structure

## Files Updated

### Type Files Created:
1. `ui/types/chat.ts` - Chat types
2. `ui/types/tabs.ts` - Tab types
3. `ui/types/settings.ts` - Settings types
4. `ui/types/index.ts` - Central export

### Files Updated to Use Central Types:
1. `ui/stores/chatStore.ts` - Import from `types/chat`
2. `ui/stores/tabStore.ts` - Import from `types/tabs`
3. `ui/hooks/useCustomKeys.ts` - Import from `types/settings`
4. `ui/components/Settings/SettingsView.tsx` - Import from `types/settings`

### Backward Compatibility:
All stores re-export types they previously defined:
```typescript
// In chatStore.ts
export type { ChatMetadata, ChatMessage, ChatState };

// Old imports still work:
import type { ChatMessage } from "../stores/chatStore";
```

## Import Errors Fixed

### Error 1: Cannot find module './ChatList'
**Cause**: Missing `.tsx` extension in import
**Fix**: Added explicit extension: `import { ChatList } from "./ChatList.tsx"`

### Error 2: Cannot find module './NewChatButton'
**Cause**: Missing `.tsx` extension in import
**Fix**: Added explicit extension: `import { NewChatButton } from "./NewChatButton.tsx"`

## Best Practices

1. **Always use `type` imports**: `import type { ... }` not `import { ... }`
2. **Group imports by category**:
   ```typescript
   import React, { useState } from "react";           // External
   import type { ChatMessage } from "../../types";    // Types
   import { useChat } from "../../hooks/useChat";     // Hooks
   import "./Component.css";                          // Styles
   ```

3. **Keep types close to usage**: Only move to `types/` if used in 2+ places
4. **Document complex types**: Add JSDoc comments for non-obvious types
5. **Use strict types**: Never use `any`, always proper types (per user rule)

## IDE Benefits

### Better Autocomplete:
- Import suggestions show all available types
- Jump to definition goes to type file (not store)
- Find references shows all usage

### Better Refactoring:
- Rename type updates all imports
- Move type to different file easier
- No circular dependency warnings

### Better Documentation:
- Types grouped by domain
- Clear ownership (chat types in chat.ts)
- Easy to generate type docs

## Future Enhancements

1. **Add JSDoc to all exported types**
2. **Create `types/artifacts.ts`** when building artifacts feature
3. **Create `types/jobs.ts`** for jobs system
4. **Add validation schemas** (Zod) alongside types
5. **Generate type docs** from TSDoc comments

## Testing

- ✅ TypeScript compilation: **0 errors**
- ✅ ESLint: **0 warnings**
- ✅ Build: **Success**
- ✅ All imports resolved correctly
- ✅ No circular dependencies
- ✅ Backward compatibility maintained

---

**Status**: ✅ **COMPLETE**  
**Type Files**: 4 files created  
**Components Updated**: 5 files  
**Build**: ✅ **Successful**  
