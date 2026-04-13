# Git Auto-Staging - Preventing Data Loss from Agent Edits

**Added:** 2026-04-12  
**Status:** ✅ Implemented

## Problem

When Paprwork's agent uses `write_file` to create or modify files in a git repository, those changes are written to disk but **not tracked by git**. This creates a critical data loss scenario:

```bash
# Agent creates file
agent: write_file({ path: "src/paprProxyProvider.ts", content: "..." })
# File exists on disk ✓

# User switches branches
user: git checkout other-branch
# Untracked file lost! ❌
```

**Common scenarios that caused data loss:**
- `git checkout <branch>` - Untracked files in working directory can be lost
- `git clean -fd` - Removes all untracked files
- `git reset --hard` - Resets to HEAD, losing untracked work
- Branch switches with uncommitted files

**Real example:** Agent created `paprProxyProvider.ts` in commit 93ef22d, but file was never `git add`'d. Later branch switch wiped the source file (only compiled .js survived in dist/).

## Solution

**Automatic git staging after every `write_file` operation.**

When the agent writes a file using `write_file`, Paprwork now automatically:
1. ✅ Checks if file is in a git repository
2. ✅ Checks if file is gitignored (respects .gitignore rules)
3. ✅ Runs `git add <file>` to stage the file
4. ✅ Returns staging status in tool result

## Implementation

### 1. Git Auto-Stage Utility (`src/core/utils/gitAutoStage.ts`)

```typescript
export async function autoStageFile(filePath: string): Promise<GitAutoStageResult> {
  // 1. Check if file exists
  // 2. Check if in git repo (git rev-parse --git-dir)
  // 3. Check if gitignored (git check-ignore)
  // 4. Stage file (git add)
  return { staged: true, gitRepo: true, path: filePath };
}
```

### 2. Filesystem Tool Integration (`src/core/tools/filesystem.ts`)

```typescript
// After writing file
const gitResult = await autoStageFile(filePath);

return {
  success: true,
  data: {
    path: filePath,
    size: stats.size,
    git_staged: gitResult.staged,    // NEW: Was file staged?
    git_status: "staged",             // NEW: Git status
  },
};
```

### 3. Agent Documentation (`src/core/agents/SystemPrompt.ts`)

Added "Automatic Git Staging" section explaining:
- Files are auto-staged after `write_file`
- Prevents data loss on branch switches
- User still controls commits
- Respects .gitignore rules

## Behavior

### What Gets Staged:

| File Type | Staged? | Notes |
|-----------|---------|-------|
| New files | ✅ Yes | Prevents loss on branch switch |
| Modified files | ✅ Yes | Tracks agent changes |
| Files in .gitignore | ❌ No | Respects git rules |
| Files outside git repos | ❌ No | Silently skips (no error) |

### Example Output:

```typescript
// Agent writes file
write_file({
  path: "~/my-project/src/newFeature.ts",
  content: "export class Feature { ... }"
})

// Result in tool output:
{
  success: true,
  data: {
    path: "/Users/amir/my-project/src/newFeature.ts",
    size: 1234,
    backed_up: false,
    git_staged: true,           // ← NEW
    git_status: "staged"        // ← NEW
  }
}

// Git status now shows:
// Changes to be committed:
//   new file:   src/newFeature.ts
```

## Coverage

### Works With:

✅ **Any git repository:**
- GitHub repos
- GitLab repos  
- Bitbucket repos
- Local repos with no remote
- Paprwork's own codebase

✅ **Any file location:**
- `~/Papr/apps/` (mini-apps)
- `~/Papr/jobs/` (job code)
- `~/Documents/GitHub/my-project/` (external repos)
- Any directory with a `.git` folder

### Requires:

✅ Git CLI installed (`git --version` works)

❌ **Does NOT require:**
- GitHub account
- GitHub CLI (`gh`)
- Git remote configured
- Internet connection
- Authentication to git hosting services

## User Experience

### Before:
```
Agent: I've created paprProxyProvider.ts
User: *switches branch*
User: Where did paprProxyProvider.ts go?! 😱
Agent: Sorry, it was untracked and got lost...
```

### After:
```
Agent: I've created paprProxyProvider.ts (automatically staged in git)
User: *switches branch*
Git: error: Your local changes to the following files would be overwritten
User: Oh, let me commit that first!
Git: *protects user's work*
```

## Important Notes

### 1. Only Stages, Doesn't Commit

The agent **stages** files (`git add`) but **does not commit** them (`git commit`). The user maintains full control over:
- Commit messages
- Commit timing
- Commit squashing
- Branch management

### 2. Respects .gitignore

Files in `.gitignore` are NOT staged. Common examples:
- `node_modules/`
- `.env` files
- `dist/` build outputs
- IDE files (`.vscode/`, `.idea/`)

### 3. Works Silently

If a file is not in a git repo, the staging is silently skipped (no error thrown). This ensures the feature doesn't break workflows outside git repos.

### 4. Agent Transparency

The agent is informed via SystemPrompt that files are auto-staged. This helps the agent understand:
- No need to manually run `git add`
- Files are safe from branch switches
- User can see changes in `git status`

## Testing

### Manual Test:

```bash
# 1. Have agent create a new file
agent: write_file({ path: "test.ts", content: "console.log('test')" })

# 2. Check git status
git status
# Should show: new file:   test.ts (staged)

# 3. Try to switch branches (should be blocked)
git checkout other-branch
# Should show: error: Your local changes would be overwritten

# 4. Commit or stash
git commit -m "Add test file"
# Success! File is safe.
```

### Edge Cases Tested:

- ✅ File in git repo → Staged
- ✅ File outside git repo → Silently skipped
- ✅ File in .gitignore → Not staged
- ✅ File in nested git submodule → Staged in submodule
- ✅ File with spaces in path → Properly escaped and staged

## Future Enhancements

### Potential Improvements:

1. **Smart commit suggestions** - Agent offers to commit related file changes
2. **Auto-commit option** - User preference to auto-commit with AI-generated messages
3. **Commit grouping** - Group related file changes into atomic commits
4. **Branch creation** - Agent creates feature branches for large changes
5. **Git hooks integration** - Trigger pre-commit hooks on agent edits

### Not Planned:

- ❌ Automatic commits (user should control)
- ❌ Automatic pushes (too risky)
- ❌ Bypassing .gitignore (security risk)

## Related Issues

- **Issue #53:** Agent file loss on branch switch (original bug report)
- **Enhancement 22:** Papr Memory SDK integration (similar versioning need)

## Files Changed

**Created:**
- `src/core/utils/gitAutoStage.ts` - Auto-staging utility

**Modified:**
- `src/core/tools/filesystem.ts` - Integrated auto-staging into write_file
- `src/core/agents/SystemPrompt.ts` - Added agent documentation

**Documentation:**
- `docs/GIT_AUTO_STAGING_FIX.md` - This file

## Summary

This fix closes a critical data loss gap in Paprwork. Agent-created files are now automatically tracked by git, preventing loss during branch switches or git operations. The implementation:

- ✅ Works with any git repository
- ✅ Requires only git CLI (no external services)
- ✅ Respects .gitignore rules
- ✅ User maintains commit control
- ✅ Zero breaking changes
- ✅ Transparent to agent and user

**Impact:** Agents can now safely edit code in git repositories without risk of data loss. This makes Paprwork a reliable tool for development workflows.
