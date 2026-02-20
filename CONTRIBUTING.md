# Contributing to Paprwork V2

Thank you for your interest in contributing to Paprwork V2! This document provides guidelines and best practices for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Project Structure](#project-structure)

---

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please be respectful and professional in all interactions.

---

## Getting Started

### Prerequisites

- **Node.js v24+** (required for Electron 40)
- npm v10+
- Git
- Basic understanding of TypeScript, React, and Electron

### Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/paprwork-v2.git
cd paprwork-v2

# 2. Use Node v24
nvm use 24

# 3. Install dependencies
npm install

# 4. Configure environment
cp .env.example .env.local
# Add your API keys to .env.local

# 5. Run in development mode
npm run dev
```

---

## Development Workflow

### Branch Strategy

- `master` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `fix/*` - Bug fixes
- `docs/*` - Documentation updates

### Creating a Feature Branch

```bash
git checkout -b feature/your-feature-name
```

### Making Changes

1. Write code following our [Code Standards](#code-standards)
2. Add tests for new functionality
3. Run quality checks: `npm run check`
4. Commit with clear messages

### Development Commands

```bash
# Run all quality checks (required before commit)
npm run check

# Format code
npm run format

# Lint code
npm run lint

# Type checking
npm run type-check

# Run tests
npm run test

# Run in development mode
npm run dev
```

---

## Code Standards

### TypeScript Guidelines

1. **Never use `any` type**
   ```typescript
   // ❌ BAD
   function process(data: any) { ... }
   
   // ✅ GOOD
   function process(data: CoreMessage | CompactionEntry): void {
     if ('role' in data) {
       // TypeScript knows it's CoreMessage
     }
   }
   ```

2. **Use proper imports**
   ```typescript
   // ❌ BAD
   import { X } from './X';
   
   // ✅ GOOD (ES modules need .js extension)
   import { X } from './X.js';
   ```

3. **Type all function parameters and return values**
   ```typescript
   // ✅ GOOD
   async function loadData(id: string): Promise<UserData> {
     // ...
   }
   ```

### File Size Limits

- **Maximum 500 lines per file** (enforced by `npm run check:loc`)
- If a file exceeds the limit, break it into smaller modules
- Focus on single responsibility principle

### Code Organization

```
src/core/
├── agents/           # Agent implementations
├── tools/            # Tool implementations
├── types/            # Type definitions
└── services/         # Business logic services
```

### Tool Implementation Pattern

```typescript
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export const myTool = createTool({
  id: 'my_tool',
  description: 'Clear description of what tool does',
  inputSchema: z.object({
    param: z.string().describe('Parameter description')
  }),
  execute: async (inputData): Promise<ToolResult> => {
    const args = inputData.context || inputData;
    const startTime = performance.now();

    try {
      const result = await doWork(args.param);
      return {
        success: true,
        data: result,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(JSON.stringify({
        success: false,
        error: (error as Error).message,
        duration: performance.now() - startTime,
        timestamp: new Date().toISOString()
      }));
    }
  }
});
```

### React Component Pattern

```typescript
interface MyComponentProps {
  id: string;
  onUpdate: (data: MyData) => void;
}

export const MyComponent: React.FC<MyComponentProps> = ({ id, onUpdate }) => {
  const [data, setData] = useState<MyData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    try {
      const result = await MyAPI.load(id);
      setData(result);
    } catch (error) {
      console.error('Failed to load:', error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (!data) return <ErrorMessage />;

  return <div>{/* Component content */}</div>;
};
```

---

## Testing

### Test Strategy

- **Unit Tests** - Test individual functions/components in isolation
- **Integration Tests** - Test IPC communication and service interactions
- **E2E Tests** - Test full user workflows with Playwright

### Writing Tests

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService();
  });

  afterEach(() => {
    service.cleanup();
  });

  it('should process data correctly', async () => {
    const result = await service.process({ id: '123' });
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});
```

### Running Tests

```bash
# Run all tests
npm run test

# Run specific test suites
npm run test:unit        # Backend unit tests
npm run test:ui          # UI unit tests
npm run test:integration # Integration tests
npm run test:e2e         # End-to-end tests

# Watch mode for development
npm run test:watch

# Coverage report
npm run test:coverage
```

### Test Coverage Requirements

- Aim for 80%+ coverage on new code
- All critical paths must be tested
- Edge cases and error handling must be covered

---

## Submitting Changes

### Before Submitting

1. **Run quality checks**
   ```bash
   npm run check
   ```

2. **Run tests**
   ```bash
   npm run test
   ```

3. **Test manually** in development mode
   ```bash
   npm run dev
   ```

### Commit Messages

Follow conventional commits format:

```
type(scope): brief description

Detailed explanation of changes (if needed)

Closes #issue-number
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation changes
- `style` - Code style changes (formatting, etc.)
- `refactor` - Code refactoring
- `test` - Adding or updating tests
- `chore` - Maintenance tasks

**Examples:**
```
feat(tools): add new document processing tool

Implements PDF and DOCX parsing with Mammoth and custom handlers.
Includes comprehensive tests and error handling.

Closes #123
```

```
fix(agent): resolve context length exceeded error

Truncate tool results to 2000 chars max when loading into LLM context.
Full results preserved in storage for UI/debugging.

Closes #456
```

### Pull Request Process

1. **Create a pull request** against the `develop` branch
2. **Fill out the PR template** completely
3. **Link related issues** using `Closes #123` or `Fixes #456`
4. **Wait for review** - Address feedback promptly
5. **Ensure CI passes** - All checks must be green

### Pull Request Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed
- [ ] All tests passing

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings
- [ ] Files under 500 lines
```

---

## Project Structure

### Core Architecture

```
src/
├── core/                 # Shared library (used by both main & gateway)
│   ├── agents/           # MastraAgent, SessionManager, ToolRegistry
│   ├── tools/            # Tool implementations
│   ├── types/            # Type definitions
│   └── services/         # Business logic services
├── electron/             # Main Electron process (CommonJS)
│   ├── index.cjs         # Main process entry
│   ├── preload.cjs       # Preload script
│   ├── ipc/              # IPC handlers
│   └── main.js           # Electron app initialization
├── gateway/              # Gateway process (sub-agents, jobs)
│   ├── index.ts          # Gateway entry
│   ├── services/         # Gateway services
│   └── websocket/        # WebSocket handlers
└── resources/            # Agent docs, skills, templates
    ├── agent-docs/       # Documentation for agents
    ├── skills/           # Skill definitions
    └── workspace-templates/ # Workspace templates
```

### UI Structure

```
ui/
├── components/           # React components
│   ├── Chat/             # Chat interface
│   ├── Sidebar/          # Sidebar navigation
│   ├── Settings/         # Settings UI
│   └── common/           # Shared components
├── hooks/                # Custom React hooks
├── stores/               # Zustand state management
├── types/                # UI-specific types
└── utils/                # Utility functions
```

---

## Common Patterns

### IPC Handler Pattern

```typescript
export function registerMyHandlers(
  service: MyService,
  window: BrowserWindow
) {
  ipcMain.handle('my:action', async (event, params: MyParams) => {
    try {
      const result = await service.doAction(params);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
```

### WebSocket Handler Pattern

```typescript
export function registerWebSocketHandlers(
  wss: WebSocket.Server,
  service: MyService
) {
  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'my:action') {
        const result = await service.doAction(message.data);
        ws.send(JSON.stringify({ type: 'my:result', data: result }));
      }
    });
  });
}
```

---

## Performance Guidelines

### Optimization Targets

- Cold start: <2 seconds
- First message response: <1 second
- Memory usage (idle): <200MB
- No memory leaks (24h+ runtime)

### Best Practices

1. **Avoid blocking the main thread**
2. **Use streaming for large responses**
3. **Implement proper cleanup in useEffect**
4. **Debounce expensive operations**
5. **Lazy load heavy components**

---

## Security Guidelines

### API Key Management

- **Never commit API keys** to version control
- Use `.env.local` for local development
- Use electron-store with encryption for production

### Tool Execution

- **Validate all inputs** before execution
- **Implement timeouts** for long-running operations
- **Sanitize outputs** to prevent data leaks

### IPC Security

- **Validate all renderer inputs**
- **Never expose Node APIs directly**
- **Use contextBridge in preload**

---

## Documentation

### When to Update Docs

- New features added
- API changes
- Breaking changes
- Architecture updates

### Documentation Structure

- **README.md** - Project overview and quick start
- **CLAUDE.md** - Developer context and learnings
- **docs/** - Comprehensive documentation
  - `architecture/` - System design docs
  - `API_*.md` - API documentation
  - `*_GUIDE.md` - How-to guides

---

## Getting Help

### Resources

- **Documentation**: [docs/](docs/)
- **GitHub Issues**: Report bugs or request features
- **GitHub Discussions**: Ask questions or discuss ideas
- **CLAUDE.md**: Key learnings and patterns

### Before Asking

1. Check existing issues
2. Read relevant documentation
3. Search discussions
4. Review CLAUDE.md for patterns

---

## License

By contributing to Paprwork V2, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0.

---

## Recognition

Contributors are recognized in our [CONTRIBUTORS.md](CONTRIBUTORS.md) file.

Thank you for helping make Paprwork V2 better! 🎉
