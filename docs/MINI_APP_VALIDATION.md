# Mini-App Validation System

**Date:** 2026-03-17

## Overview

Automated validation system for mini-apps that enforces code quality standards and file size limits. Runs automatically on file changes and can be triggered manually by agents.

## Features

### 1. **100-Line Limit Enforcement** (CRITICAL)

Every mini-app file must have ≤100 **significant lines** (excluding empty lines and comments).

**Why 100 lines?**
- Forces component-based architecture
- Easier to understand and maintain
- Encourages reusable modules
- Prevents monolithic files

**What counts as a line?**
- Non-empty lines
- Non-comment lines
- Excludes `/* block comments */`
- Excludes `// single-line comments`

**Example violation:**
```
❌ index.html:0 - File has 157 lines (57 over the 100 line limit). Break into smaller components.
```

**How to fix:**
- Extract components into separate files (`components/Header.ts`, `components/Chart.ts`)
- Move utilities to `utils/` directory
- Split CSS into multiple files

### 2. **HTML Syntax Validation**

Checks for:
- Unclosed tags (e.g., `<div>` without `</div>`)
- Malformed markup
- Self-closing tags handled correctly

**Example issues:**
```
⚠️ index.html:45 - Potentially unclosed <div> tag
```

### 3. **CSS Syntax Validation**

Checks for:
- Mismatched braces (`{` without `}`)
- Double semicolons (`;;`)
- Basic syntax errors

**Example issues:**
```
❌ styles.css:0 - Mismatched braces (missing closing braces)
⚠️ styles.css:23 - Double semicolon found
```

### 4. **JavaScript/TypeScript Syntax Validation**

Checks for:
- Mismatched delimiters (braces, parentheses, brackets)
- `console.log` statements (warning - should remove before production)
- Basic syntax structure

**Example issues:**
```
❌ app.ts:0 - Mismatched parentheses (missing closing)
⚠️ utils.ts:34 - Remove console.log statements before production
```

## How It Works

### Automatic Validation

Validation runs automatically when any file in a mini-app changes:

1. **File Watcher** detects change (via bash, WebSocket, or any method)
2. **200ms debounce** prevents rapid-fire validation
3. **Validation runs** checking all source files
4. **Results broadcast** to all connected clients via WebSocket
5. **Console output** shows errors for agent visibility

### Manual Validation

Agents can trigger validation using the `validate_app` tool:

```typescript
// Agent calls
validate_app({ appId: "abc-123" })

// Returns:
{
  success: false,
  error: "Validation failed with 2 error(s) and 1 warning(s)",
  data: {
    valid: false,
    filesChecked: 4,
    issues: [
      {
        file: "index.html",
        severity: "error",
        message: "File has 157 lines (57 over the 100 line limit). Break into smaller components.",
        rule: "max-lines"
      },
      {
        file: "styles.css",
        line: 23,
        severity: "warning",
        message: "Double semicolon found",
        rule: "css-syntax"
      }
    ],
    summary: "2 error(s), 1 warning(s)"
  }
}
```

### Validation Result Format

```typescript
interface ValidationResult {
  appId: string;
  timestamp: string;
  valid: boolean;  // true if no issues found
  issues: ValidationIssue[];
  filesChecked: number;
}

interface ValidationIssue {
  file: string;      // Relative path (e.g., "components/Chart.ts")
  line?: number;     // Line number (1-indexed), optional
  column?: number;   // Column number, optional
  severity: "error" | "warning";
  message: string;   // Human-readable description
  rule?: string;     // Rule name (e.g., "max-lines", "css-syntax")
}
```

## Architecture

### Components

1. **AppService.ts** - Core validation logic
   - `validateApp()` - Public API for manual validation
   - `runValidation()` - Internal implementation
   - `checkLineLimit()` - LOC enforcement
   - `checkHtmlSyntax()` - HTML validation
   - `checkCssSyntax()` - CSS validation
   - `checkJavaScriptSyntax()` - JS/TS validation
   - `broadcastValidation()` - Send results to clients

2. **appJobs.ts** - Agent tool
   - `validate_app` tool for manual validation

3. **app.ts** - WebSocket handler
   - `app:validate` message handler
   - Returns validation result

4. **File Watcher Integration**
   - `handleFileChange()` triggers validation automatically
   - Runs asynchronously (doesn't block file change broadcast)

### Flow Diagram

```
┌─────────────────┐
│ File Changed    │
│ (bash/WS/etc)   │
└────────┬────────┘
         │
         v
┌─────────────────┐
│ File Watcher    │
│ (200ms debounce)│
└────────┬────────┘
         │
         v
┌─────────────────────────────────┐
│ handleFileChange()              │
│ 1. Broadcast file-changed event │
│ 2. Trigger validation async     │
└────────┬────────────────────────┘
         │
         v
┌─────────────────────────────────┐
│ runValidation()                 │
│ 1. Find all source files        │
│ 2. Check LOC limit (100 lines)  │
│ 3. Check syntax (HTML/CSS/JS)   │
│ 4. Collect issues               │
└────────┬────────────────────────┘
         │
         v
┌─────────────────────────────────┐
│ broadcastValidation()           │
│ 1. Log errors to console        │
│ 2. Send WebSocket broadcast     │
└─────────────────────────────────┘
         │
         v
┌─────────────────────────────────┐
│ Agent sees errors in console    │
│ UI shows validation badge       │
└─────────────────────────────────┘
```

## Agent Usage

### Best Practices

1. **Run validation after file edits:**
   ```
   edit_app_file({ appId, filename, old_string, new_string })
   validate_app({ appId })  // Check for issues
   ```

2. **Fix LOC violations by breaking up files:**
   ```
   # If index.html has 157 lines:
   # 1. Extract header to components/Header.ts
   # 2. Extract chart to components/Chart.ts
   # 3. Import them in index.html
   ```

3. **Check validation before marking plan steps complete:**
   ```
   validate_app({ appId })
   # If valid:
   update_plan({ stepId, status: "completed" })
   ```

### Common Patterns

#### Pattern 1: Create App with Validation

```typescript
// 1. Create the app
create_app({
  title: "Dashboard",
  description: "Analytics dashboard",
  files: [/* ... */]
})

// 2. Validate immediately
validate_app({ appId: "abc-123" })

// 3. Fix any issues before continuing
```

#### Pattern 2: Extract Components

```typescript
// Large file detected (120 lines)
// Extract to components:

// components/Header.ts (40 lines)
export const Header = () => { /* ... */ }

// components/Chart.ts (50 lines)
export const Chart = () => { /* ... */ }

// index.html (30 lines)
import { Header } from './components/Header.ts'
import { Chart } from './components/Chart.ts'
```

#### Pattern 3: Continuous Validation

```typescript
// Edit file
edit_app_file({ appId, filename: "app.ts", old_string, new_string })

// Validation runs automatically in background
// Agent sees console output if issues found

// Optionally check manually:
validate_app({ appId })
```

## File Size Guidelines

| File Type | Max Lines | Typical Purpose |
|-----------|-----------|-----------------|
| `index.html` | 100 | Main entry, imports components |
| `styles.css` | 100 | Global styles only, use component styles |
| `app.ts` | 100 | Main logic, delegates to modules |
| `components/*.ts` | 100 | Single component per file |
| `utils/*.ts` | 100 | Single utility per file |

## Console Output Format

When validation finds issues, agents see them in the console:

```
[AppService] Validation found 3 issue(s) in app abc-123
❌ index.html:0 - File has 157 lines (57 over the 100 line limit). Break into smaller components.
⚠️ styles.css:23 - Double semicolon found
⚠️ app.ts:45 - Remove console.log statements before production
```

## UI Integration (Future)

The validation system broadcasts results that the UI can display:

```typescript
// WebSocket broadcast
{
  type: "app:validation-result",
  data: {
    appId: "abc-123",
    valid: false,
    issues: [/* ... */],
    filesChecked: 4
  }
}
```

Potential UI features:
- Validation badge on app tabs (✓ or ⚠️)
- Inline error markers in file list
- Validation panel showing all issues
- Auto-fix suggestions

## Configuration

Current limits (hardcoded):
- **Max lines per file:** 100 (significant lines)
- **Debounce delay:** 200ms
- **Ignored files:** `.versions/`, `data-sources.json`, hidden files

To adjust limits, modify `AppService.ts`:
```typescript
// In handleFileChange():
const locIssues = this.checkLineLimit(content, relativePath, 100);
//                                                             ^^^ Change this
```

## Performance

- **Validation time:** ~10-50ms for typical mini-apps (3-5 files)
- **Debouncing:** Prevents excessive validation during rapid edits
- **Async execution:** Doesn't block file change broadcasts or iframe reloads
- **Selective watching:** Only validates source files (`.html`, `.css`, `.js`, `.ts`, `.tsx`, `.jsx`)

## Error Handling

- **App not found:** Returns validation result with error issue
- **File read errors:** Logs error, continues with other files
- **Parse errors:** Caught and reported as validation issues
- **Broadcast failures:** Logged as warnings (non-fatal)

## Testing

Test scenarios:
1. Create app with 120-line file → validation fails ✓
2. Break file into components (<100 lines each) → validation passes ✓
3. Add `console.log` → warning shown ✓
4. Mismatched braces in CSS → error shown ✓
5. Unclosed HTML tag → warning shown ✓
6. Edit via bash → validation runs automatically ✓
7. Edit via WebSocket → validation runs automatically ✓

## Files Changed

- `src/gateway/services/AppService.ts` - Validation logic
- `src/core/tools/appJobs.ts` - `validate_app` tool
- `src/gateway/websocket/app.ts` - `app:validate` handler
- `docs/MINI_APP_VALIDATION.md` - This documentation

## Future Enhancements

Potential improvements:
1. **ESLint integration** - Full JavaScript/TypeScript linting
2. **Configurable limits** - Per-app or per-file type limits
3. **Auto-fix suggestions** - Suggest how to break up files
4. **Performance profiling** - Track validation performance metrics
5. **Custom rules** - Allow apps to define custom validation rules
6. **Prettier integration** - Automatic code formatting
7. **Type checking** - TypeScript type validation via `tsc`

## Related Documentation

- [MINI_APP_AUTO_RELOAD.md](MINI_APP_AUTO_RELOAD.md) - File watching and reload system
- [PLAN_ENFORCEMENT_STRATEGY.md](PLAN_ENFORCEMENT_STRATEGY.md) - Plan creation requirements
- [check-max-lines.ts](../scripts/check-max-lines.ts) - LOC checking script for main codebase
