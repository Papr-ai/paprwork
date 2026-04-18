# Mastra Version Lock - Why We Stay on 1.4.0

**Date:** 2026-04-17
**Current Version:** `@mastra/core@1.4.0` (exact)

## Summary

We are temporarily locked to Mastra 1.4.0 instead of upgrading to 1.25.0 due to breaking API changes in how tool execution contexts are handled.

## What Happened

1. **Accidental Upgrade:** Running `npm ci --force` (commit 21d63eb) upgraded `@mastra/core` from 1.4.0 to 1.25.0 due to `^1.4.0` in package.json allowing any 1.x version
2. **Breaking Changes:** Mastra 1.25.0 changed tool execute function signatures:
   - **Old (1.4.0):** `execute: async (input) => { const args = input.context || input; }`
   - **New (1.25.0):** `execute: async (inputData, context) => { ... }` (two separate parameters)
3. **Type Issues:** New version has stricter TypeScript checks causing 114+ type errors across tool files

## Impact

The upgrade broke:
- 112 errors in `src/core/tools/appJobs.ts`
- 1 error in `src/core/tools/filesystem.ts`
- 1 error in `src/core/tools/planning.ts`

Most errors were "args is of type unknown" because the new API doesn't unwrap the context automatically.

## Decision

**Lock to 1.4.0** (exact version, no `^`) until we can:
1. Schedule dedicated time to upgrade all 70+ tools
2. Test thoroughly across all workflows
3. Update documentation

## Files Changed

- `package.json`: Changed `"@mastra/core": "^1.4.0"` → `"@mastra/core": "1.4.0"` (exact)
- Added this documentation

## Future Upgrade Path

When ready to upgrade to 1.25.0+:

1. **Update all tool execute signatures:**
   ```typescript
   // Old pattern (1.4.0)
   execute: async (input) => {
     const args = (input as { context?: T }).context ?? input;
   }
   
   // New pattern (1.25.0+)
   execute: async (input: T) => {
     const args = input; // Direct access, no unwrapping
   }
   ```

2. **Fix z.preprocess type issues:**
   - Tools using `toolSchemaWithFilenameAlias()` need type assertions
   - Change `input: T` to `input` with `const args = input as T;`

3. **Fix schema incompatibilities:**
   - Change `.optional().default(x)` to just `.default(x)` (removes optional)
   - Ensure all required fields are truly required, not optional

4. **Test extensively:**
   - All 70+ tools
   - Job creation with different types
   - Mini-app creation
   - File operations
   - Version control operations

## Timeline

- **Short term (now):** Stay on 1.4.0, stable and working
- **Medium term (Q2 2026):** Evaluate Mastra 1.25.0 changes, create upgrade plan
- **Long term:** Stay current with Mastra releases once migration complete

## Related

- Commit `21d63eb`: "Fix: Windows/Linux build EBADPLATFORM error with npm ci --force"
- Original context unwrapping pattern: See CLAUDE.md "Mastra Framework Advantages"
