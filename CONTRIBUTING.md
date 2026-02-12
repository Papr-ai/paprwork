# Contributing to Paprwork V2

## Code Quality Standards

### 1. TypeScript Safety (CRITICAL)

**Rule: NEVER use `any` type**

```typescript
// ❌ BAD - Using any
function process(data: any) {
  return data.value;
}

// ✅ GOOD - Proper typing
interface ProcessData {
  value: string;
}

function process(data: ProcessData): string {
  return data.value;
}

// ✅ GOOD - Unknown with type guards
function process(data: unknown): string {
  if (isProcessData(data)) {
    return data.value;
  }
  throw new Error('Invalid data');
}

function isProcessData(obj: unknown): obj is ProcessData {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'value' in obj &&
    typeof (obj as ProcessData).value === 'string'
  );
}
```

**ESLint enforces this:**
- `@typescript-eslint/no-explicit-any`: error
- Code will not pass linting with `any` types

### 2. Small Modular Components

**Rule: Keep files under 300 lines**

Each file should have a single responsibility:

```
✅ GOOD structure:
src/core/agents/
├── MastraAgent.ts (250 lines)
├── SessionManager.ts (180 lines)
├── ToolRegistry.ts (120 lines)
└── ModelFallback.ts (160 lines)

❌ BAD structure:
src/core/
└── agent.ts (2000 lines - everything in one file)
```

**Benefits:**
- Easy to understand
- Easy to test
- Easy to maintain
- Easy to review in PRs

### 3. Proper Type Imports

Always use `type` imports for types:

```typescript
// ✅ GOOD
import type { CoreMessage, AgentConfig } from '../types';
import { MastraAgent } from './MastraAgent';

// ❌ BAD
import { CoreMessage, AgentConfig } from '../types';
```

### 4. Never Use Type Assertions

Avoid `as` assertions unless absolutely necessary:

```typescript
// ❌ BAD
const data = JSON.parse(str) as MyType;

// ✅ GOOD
function parseData(str: string): MyType {
  const data: unknown = JSON.parse(str);
  
  if (!isMyType(data)) {
    throw new Error('Invalid data format');
  }
  
  return data;
}
```

### 5. Exhaustive Switch Statements

Use TypeScript's exhaustiveness checking:

```typescript
function getModel(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-sonnet-4';
    case 'openai':
      return 'gpt-4o';
    case 'google':
      return 'gemini-2.0-flash';
    default: {
      // This ensures we handle all Provider types
      const exhaustiveCheck: never = provider;
      throw new Error(`Unknown provider: ${exhaustiveCheck}`);
    }
  }
}
```

## File Organization

### Directory Structure

```
src/
├── core/               # Shared library (main + gateway)
│   ├── types/         # All TypeScript types
│   ├── agents/        # Agent logic
│   ├── storage/       # Persistence
│   └── tools/         # Tool implementations
├── main/              # Electron main process
│   ├── services/      # Business logic
│   ├── ipc/           # IPC handlers
│   └── index.ts       # Entry point
├── renderer/          # React UI
│   ├── components/    # UI components
│   ├── hooks/         # Custom hooks
│   ├── services/      # API calls
│   └── stores/        # State management
└── gateway/           # Sub-agent process
    ├── services/      # Gateway logic
    └── handlers/      # Request handlers
```

### File Naming

- Components: `PascalCase.tsx` (e.g., `ChatContainer.tsx`)
- Utilities: `camelCase.ts` (e.g., `formatMessage.ts`)
- Types: `camelCase.ts` in `types/` folder
- Tests: `*.test.ts` alongside source files

## Testing Requirements

### Unit Tests

Every module must have unit tests:

```typescript
// SessionManager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from './SessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager('/tmp/test');
  });

  it('should load empty session for new chat', async () => {
    const messages = await manager.loadSession('new-chat');
    expect(messages).toEqual([]);
  });

  // More tests...
});
```

### Coverage Requirements

- Core library: 80%+ coverage
- Main process services: 70%+ coverage
- Renderer hooks: 60%+ coverage

## Electron Best Practices

### 1. IPC Type Safety

Define clear interfaces for IPC:

```typescript
// types/ipc.ts
export interface AgentStreamParams {
  chatId: string;
  message: string;
  config: AgentConfig;
}

export interface AgentStreamResult {
  success: boolean;
  error?: string;
}

// main/ipc/agent.ts
ipcMain.handle(
  'agent:stream',
  async (_event, params: AgentStreamParams): Promise<AgentStreamResult> => {
    // Implementation
  }
);
```

### 2. Memory Management

Always clean up resources:

```typescript
export class ChatService {
  private sessions: Map<string, SessionState> = new Map();

  dispose(): void {
    this.sessions.clear();
  }
}
```

### 3. Error Handling

Always handle errors gracefully:

```typescript
try {
  await riskyOperation();
} catch (error) {
  if (error instanceof SpecificError) {
    // Handle specific error
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

## macOS-Specific Considerations

### 1. File Paths

Use `app.getPath()` for user data:

```typescript
import { app } from 'electron';

const userDataPath = app.getPath('userData');
const chatsPath = path.join(userDataPath, 'chats');
```

### 2. Entitlements

Update `build/entitlements.mac.plist` for permissions:
- Microphone: `com.apple.security.device.audio-input`
- Camera: `com.apple.security.device.camera`
- Calendar: `com.apple.security.personal-information.calendars`

### 3. Code Signing

Production builds must be signed:

```bash
# Handled by electron-builder
npm run build
```

## Pull Request Checklist

Before submitting a PR:

- [ ] All files are TypeScript (no `.js` files)
- [ ] No `any` types used (lint passes)
- [ ] All files under 300 lines
- [ ] Added unit tests (if applicable)
- [ ] Tests pass (`npm test`)
- [ ] Type checking passes (`npm run type-check`)
- [ ] Linting passes (`npm run lint`)
- [ ] PR description explains what and why

## Common Patterns

### 1. Async Generators for Streaming

```typescript
async *streamData(): AsyncGenerator<DataChunk, void, undefined> {
  for await (const chunk of source) {
    yield processChunk(chunk);
  }
}
```

### 2. Service Classes

```typescript
export class MyService {
  private dependency: Dependency;

  constructor(config: MyServiceConfig) {
    this.dependency = new Dependency(config);
  }

  async performAction(input: Input): Promise<Output> {
    // Implementation
  }

  dispose(): void {
    // Cleanup
  }
}
```

### 3. React Hooks

```typescript
export function useCustomHook(param: string): HookResult {
  const [state, setState] = useState<StateType>(initialValue);

  useEffect(() => {
    // Side effects
    return () => {
      // Cleanup
    };
  }, [param]);

  return { state, setState };
}
```

## Getting Help

If you have questions:
1. Check existing code for patterns
2. Review this contributing guide
3. Ask in PR comments
4. Reference V1 code for feature behavior (but NOT implementation)

## Resources

- [TypeScript Deep Dive](https://basarat.gitbook.io/typescript/)
- [Electron Documentation](https://www.electronjs.org/docs/latest/)
- [Mastra Framework](https://mastra.ai/docs)
- [React TypeScript Cheatsheet](https://react-typescript-cheatsheet.netlify.app/)
