# Testing Guide for Paprwork V2

This guide explains how to run and write tests for Paprwork V2.

## Test Structure

We follow the **OpenClaw-inspired** testing strategy with separate test configurations:

```
paprwork-v2/
├── test/
│   ├── unit/                  # Unit tests (fast, isolated)
│   ├── integration/           # Integration tests (services, storage, WebSocket)
│   └── e2e/                   # End-to-end tests (full workflows)
├── tests/                     # Gateway service tests (legacy location)
└── ui/__tests__/              # UI component and store tests
    ├── components/
    ├── stores/
    └── features/
```

## Running Tests

### Quick Start

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:e2e          # E2E tests only
npm run test:all          # All test suites sequentially

# Run with coverage
npm run test:coverage
```

### Individual Test Files

```bash
# Run specific test file
npm test tests/storage-manager.test.ts

# Run in watch mode
npm test -- --watch

# Run with UI
npm test -- --ui
```

### Gateway Service Tests (in tests/ directory)

```bash
# Storage tests
npm test tests/storage-manager.test.ts
npm test tests/local-storage.test.ts
npm test tests/chat-session-manager.test.ts

# Title generation
npm test tests/title-generation.test.ts

# PAPR integration
npm test tests/papr-sdk-integration.test.ts
```

### Integration Tests (in test/integration/)

```bash
# WebSocket communication
npm run test:integration test/integration/websocket-communication.test.ts

# Agent streaming (parallel chats)
npm run test:integration test/integration/agent-streaming.test.ts

# Gateway-Storage integration
npm run test:integration test/integration/gateway-storage.test.ts
```

### UI Tests (in ui/__tests__/)

```bash
# Component tests
npm test ui/__tests__/components/ChatContainer.test.tsx
npm test ui/__tests__/components/MessageList.test.tsx

# Store tests
npm test ui/__tests__/stores/chatStore.test.ts
npm test ui/__tests__/stores/tabStore.test.ts

# Feature tests
npm test ui/__tests__/features/comprehensive.test.ts
```

### E2E Tests (in test/e2e/)

```bash
# Full chat workflow with Electron
npm run test:e2e test/e2e/chat-workflow.test.ts
```

## Test Coverage

### Current Coverage Status

| Area | Coverage | Status |
|------|----------|--------|
| Storage Layer | ~80% | ✅ Good |
| Gateway Services | ~70% | ✅ Good |
| UI Stores | ~60% | ⚠️ Needs improvement |
| UI Components | ~40% | ⚠️ Needs tests |
| WebSocket | 100% | ✅ Complete (new) |
| Integration | 100% | ✅ Complete (new) |
| E2E | 100% | ✅ Complete (new) |

**Overall Coverage Target:** 80%+

## Environment Variables

Some tests require environment variables in `.env.local`:

```bash
# Required for agent tests
ANTHROPIC_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here

# Required for PAPR tests
PAPR_API_KEY=your-key-here
PAPR_BASE_URL=https://memory.papr.ai  # Optional
```

**Note:** Tests will skip or use mock data if API keys are missing.

## Writing Tests

### Unit Test Template

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService();
  });

  it('should do something', () => {
    const result = service.doSomething();
    expect(result).toBe(expected);
  });
});
```

### Integration Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Service Integration', () => {
  beforeAll(async () => {
    // Setup services, database, etc.
  });

  afterAll(async () => {
    // Cleanup
  });

  it('should integrate services correctly', async () => {
    // Test cross-service interaction
  });
});
```

### UI Component Test Template

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MyComponent } from './MyComponent';

describe('MyComponent', () => {
  it('should render correctly', () => {
    render(<MyComponent />);
    const element = screen.getByTestId('my-component');
    expect(element).toBeDefined();
  });

  it('should handle user interaction', () => {
    render(<MyComponent />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    // Assert state change
  });
});
```

### E2E Test Template

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';

describe('E2E: Feature Name', () => {
  let app: ElectronApplication;
  let window: Page;

  beforeAll(async () => {
    app = await electron.launch({ args: ['./dist/main.js'] });
    window = await app.firstWindow();
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('should complete user workflow', async () => {
    // Interact with app
    await window.click('[data-testid="button"]');
    await expect(window.locator('#result')).toBeVisible();
  });
});
```

## Test Best Practices

### 1. Test Organization

- **Unit tests** should be fast (<100ms) and isolated
- **Integration tests** can be slower (<5s) but test real interactions
- **E2E tests** can be slowest (<60s) but test full workflows

### 2. Test Naming

```typescript
// Good
it('should save message to storage when streaming completes')

// Bad
it('test 1')
```

### 3. Assertions

```typescript
// Good - specific assertion
expect(chat.title).toBe('Test Chat');

// Bad - vague assertion
expect(chat).toBeDefined();
```

### 4. Cleanup

Always clean up after tests:

```typescript
afterAll(async () => {
  await fs.remove(TEST_DATA_PATH);
  await db.close();
});
```

### 5. Mock External Dependencies

```typescript
// Mock API calls
vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: vi.fn(() => ({
    messages: { create: vi.fn() },
  })),
}));
```

### 6. Use Data Test IDs

Add `data-testid` attributes to components:

```tsx
<div data-testid="chat-container">
  <input data-testid="chat-input" />
  <button data-testid="send-button">Send</button>
</div>
```

## Debugging Tests

### Verbose Output

```bash
npm test -- --reporter=verbose
```

### Debug Single Test

```bash
npm test -- -t "should save message"
```

### Debug with Breakpoints

Add `debugger` statement in test:

```typescript
it('should do something', () => {
  debugger;  // Execution will pause here
  const result = service.doSomething();
  expect(result).toBe(expected);
});
```

Run with Node debugger:

```bash
node --inspect-brk ./node_modules/vitest/vitest.mjs run
```

### View Test UI

```bash
npm test -- --ui
```

Opens browser UI at `http://localhost:51204/__vitest__/`

## Continuous Integration

Tests run automatically on:
- Push to main branch
- Pull request creation
- Pre-commit hook (future)

## Coverage Reports

After running `npm run test:coverage`:

```
Coverage report available at:
./coverage/index.html
```

Open in browser to see detailed coverage.

## Common Issues

### Tests Timeout

Increase timeout for slow tests:

```typescript
it('should handle long operation', async () => {
  // Test code
}, 30000);  // 30 second timeout
```

### WebSocket Connection Errors

Make sure gateway is not running when testing:

```bash
# Stop gateway if running
pkill -f "tsx.*gateway/index.ts"
```

### SQLite Lock Errors

Clean up test databases:

```bash
rm -rf /tmp/paprwork-*
```

### Missing Dependencies

Install test dependencies:

```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom vitest playwright
```

## Test Metrics

Track these metrics:
- **Test Coverage:** 80%+ (goal)
- **Test Speed:** Unit <100ms, Integration <5s, E2E <60s
- **Test Reliability:** No flaky tests (99%+ pass rate)
- **Test Count:** 100+ tests total

## Next Steps

### Priority Tests to Add

1. ✅ WebSocket integration tests
2. ✅ Agent streaming tests
3. ✅ Gateway-storage integration tests
4. ✅ E2E chat workflow tests
5. ✅ ChatContainer component tests
6. ✅ MessageList component tests
7. ⏳ InputBar component tests
8. ⏳ Core agent library tests (MastraAgent, ToolRegistry)
9. ⏳ IPC handler tests
10. ⏳ Tool execution tests

### Future Improvements

- Add mutation testing with Stryker
- Add visual regression testing
- Add performance benchmarks
- Add accessibility tests (a11y)
- Add mobile E2E tests (future iOS/Android apps)

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
- [Playwright](https://playwright.dev/)
- [OpenClaw Testing Strategy](https://github.com/openclaw/openclaw) (inspiration)

## Getting Help

If you encounter issues:
1. Check this guide
2. Look at existing tests for examples
3. Run with `--reporter=verbose` for detailed output
4. Check GitHub Issues for similar problems
