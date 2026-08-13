# Cloud Sync Initial Clone Fix

**Added:** 2026-08-13
**Severity:** CRITICAL - Data Loss Bug

## Problem

Users' cloud data (apps.json, jobs.json, databases.json, and potentially app/job folders) was being deleted from GitHub when:
1. User logged in with Papr or switched org/namespace workspace
2. A new namespace workspace folder was created at `~/Papr/orgs/{orgId}/namespaces/{namespaceId}/`
3. Cloud sync cloned the existing GitHub repo but **only copied `.git` metadata**, not working tree files
4. The empty working tree was then committed and pushed, effectively deleting all remote content

## Root Cause

In `CloudSyncService.initialClone()`, the code cloned the repo to a temp directory, copied only the `.git` folder to the new workspace, and deleted the temp directory with all the actual files:

```typescript
// BEFORE (buggy)
await this.gitRunner.clone(cloneUrl, tempDir);  // Full clone
fs.cpSync(path.join(tempDir, ".git"), path.join(this.paprDir, ".git"), { recursive: true });  // Only .git!
fs.rmSync(tempDir, { recursive: true, force: true });  // Delete files!
// No checkout — working tree remains empty!
```

After this:
- `.git` folder exists with refs to commits containing user's data
- Working tree is empty (just scaffold folders from `ensureWorkspaceLayout()`)
- Git sees all files from HEAD as "deleted" since they're not in working tree
- `git add -- workspace data` stages deletions
- Commit and push sends deletion to GitHub

## Solution

### Fix 1: Restore Working Tree After Clone

Added `git checkout HEAD -- .` after copying `.git` to populate the working tree:

```typescript
// AFTER (fixed)
await this.gitRunner.clone(cloneUrl, tempDir);
fs.cpSync(path.join(tempDir, ".git"), path.join(this.paprDir, ".git"), { recursive: true });
fs.rmSync(tempDir, { recursive: true, force: true });

// CRITICAL: Restore working tree from cloned HEAD
try {
  await this.git(["checkout", "HEAD", "--", "."]);
  console.log("[CloudSync] Restored working tree from cloned HEAD");
} catch (checkoutErr) {
  // If checkout fails (e.g., empty repo), continue
  console.log("[CloudSync] Working tree checkout skipped:", ...);
}
```

### Fix 2: Safety Check Before Commit

Added a safety check in `commitAndPushPaths()` to detect and block accidental mass deletions:

```typescript
const deletedFiles = await this.detectStagedDeletions();
if (deletedFiles.length > 5) {
  console.error(
    `[CloudSync] SAFETY BLOCK: Refusing to commit ${deletedFiles.length} file deletions...`
  );
  await this.git(["reset", "HEAD", "--", ...stagePaths]);
  // Try to restore working tree
  await this.git(["checkout", "HEAD", "--", "."]);
  return false;
}
```

## Why Local Files Survived

The user's actual app/job source files were still at the **old flat location** (`~/Papr/apps/`, `~/Papr/Jobs/`) because:
- Legacy migration to namespace structure **requires user consent** 
- The files were never moved to the new namespace folder
- Only the new (empty) namespace folder was synced to GitHub

## Files Changed

- `src/gateway/services/CloudSyncService.ts`
  - Added `git checkout HEAD -- .` after `initialClone()` copies `.git`
  - Added `detectStagedDeletions()` helper method
  - Added mass deletion safety check in `commitAndPushPaths()`

## Testing

1. Create test user with data in flat `~/Papr/` structure
2. Activate org/namespace to create new workspace
3. Verify working tree is populated from GitHub after clone
4. Verify no deletion commits are created
5. Verify safety check blocks if >5 deletions staged

## Related Issues

- Legacy migration requires user consent (separate flow)
- `repoIdentityChanged` flag triggers force push (mitigated by this fix)
- `archiveStaleFlatRootGitRepo()` archives old `.git` to prevent conflicts

## Prevention

- Always restore working tree after copying `.git` from a clone
- Add safety checks before committing to detect unexpected deletions
- Log clear warnings when detecting potential data loss scenarios
