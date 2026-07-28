# Share Dialog Simplification

**Date:** 2026-07-27
**Status:** ✅ Implemented

## Overview

Simplified the mini-app share dialog UI to reduce confusion and improve clarity. Changes are **UI-only** with no backend deployment required.

## Changes Made

### 1. Prominent Share Link at Top

**Before:** Share link buried below "Cloud compatibility" section with technical details

**After:** Share link displayed at the very top of the dialog (moved Cloud compatibility panel to bottom)

**Why:** Users come to share dialog to get a link - show it immediately!

### 2. Simplified Permissions (3 → 2)

**Before:**
- Only me
- My team
- Anyone on the web (public)
- People with invite link

**After:**
- Only me
- Anyone in my workspace
- Anyone with the link

**Why:** Removed confusing distinction between "public" and "invite link". Most users want simple workspace or link sharing.

### 2. Simplified Permissions (3 → 2)

**Before:**
- View only
- Use the app
- Edit the code

**After:**
- Can view and interact
- Can edit code

**Why:** Clearer labels. "View and interact" combines read + use. Removed redundant "view only" since most users want interactivity.

### 3. Prominent Share Link

**Before:** Share link buried in "Live web link" section below access/permissions

**After:** Share link displayed at the top of the dialog (most prominent)

**Why:** Users come to the share dialog to get a link - show it first!

### 4. Cleaner Layout

**Removed:**
- Verbose "Live web link" section explanation
- "How install works" help buttons
- "Open-source template" export flow
- Confusing agent jobs notice for invite links
- Multiple "Put on web" buttons in different sections

**Kept:**
- CloudCompatibilityPanel (hybrid app notice)
- API credentials configuration (existing CloudAppCredentialsPanel)
- Code access / Community Apps listing
- Change requests panel (for code contributors)
- Unpublish section

### 5. Conditional Permissions Display

**Before:** Permission fieldset always shown (with disabled states)

**After:** Permission fieldset hidden when "Only me" is selected (no permissions needed for private apps)

## Files Modified

### UI Components
- `ui/components/Apps/MiniAppPublishBar.tsx` - Simplified dialog content
- `ui/components/Apps/MiniAppPublishBar.css` - Added `.share-sheet__link-section` styling

### Core Utilities
- `src/core/utils/shareAudienceModel.ts` - Updated `isPermissionAvailable()` logic

## Behavior Changes

### Access Mapping
| UI Selection | Backend `loginAccess` | Backend `externalLink` |
|--------------|----------------------|------------------------|
| Only me | `private` | `off` |
| Anyone in my workspace | `team` | `off` |
| Anyone with the link | `none` | `read` or `read_write` |

### Permission Mapping
| UI Selection | Backend `permission` | Backend `codeAccess` |
|--------------|---------------------|---------------------|
| Can view and interact | `write` | `off` |
| Can edit code | `edit` | `install` |

### Permission Availability
- **Only me (private):** No permissions shown (apps stay private)
- **Anyone in workspace / link:** Both "view & interact" and "edit code" available

## API Credentials

The existing `CloudAppCredentialsPanel` is still shown for live apps. It already supports per-key `credentialScope: "owner" | "user"` configuration via the backend.

**Future enhancement:** Could add a simple checkbox + "Advanced" link in the main dialog for quick "use my keys" toggle.

## Testing

### Manual Testing Checklist
- [ ] Open share dialog for unpublished app
  - [ ] Shows "Put on web" button
  - [ ] No share link shown yet
- [ ] Publish app
  - [ ] Share link appears at top
  - [ ] Can copy link
  - [ ] Can open in browser
- [ ] Select "Only me"
  - [ ] Permission section hidden
- [ ] Select "Anyone in my workspace"
  - [ ] Permission section shown
  - [ ] Both options available
- [ ] Select "Anyone with the link"
  - [ ] Permission section shown
  - [ ] Both options available
- [ ] Select "Can edit code"
  - [ ] Code access section appears
  - [ ] Community Apps mention shown if applicable
- [ ] API credentials panel shows for live apps
  - [ ] Can configure owner vs user keys
  - [ ] Save works correctly

### Regression Testing
- [ ] Existing published apps load correctly
- [ ] Access levels persist across app restarts
- [ ] API credential configuration unchanged
- [ ] Community Apps listing still works
- [ ] Change requests panel still functional

## Deployment

**Required:** Desktop app release only (via auto-update)
**Not Required:** Backend deployment, database migrations, or cloud app host changes

```bash
# Build and package desktop app
npm run build
npm run dist:mac  # or dist:win, dist:linux

# Users get update automatically via existing auto-update mechanism
```

## Future Enhancements

### Phase 2 (Optional)
1. Add namespace name dynamically in "Anyone in [Workspace Name]" label
2. Simple checkbox + "Advanced" link for API key management in main dialog
3. Deep link protocol for "Open in Paprwork" from web (`paprwork://apps/import?url=...`)
4. Banner on apps.papr.ai detecting desktop and suggesting "Open in Paprwork"

### Phase 3 (Optional)
1. Per-key usage limits and notifications in advanced panel
2. Usage analytics per shared app
3. Revoke specific share links
4. Share link expiration dates

## Success Metrics

- **Reduced confusion:** Fewer support questions about sharing
- **Faster sharing:** Users can share apps in fewer clicks
- **Clearer intent:** "view & interact" vs "edit code" is more obvious than before
- **Better discoverability:** Share link prominently displayed

## References

- Original discussion: User feedback on share UX complexity
- Backend API: All endpoints already support simplified model
- Design inspiration: Figma, Notion share dialogs (simple access + permissions)
