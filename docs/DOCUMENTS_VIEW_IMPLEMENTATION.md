# Documents View Implementation

**Date:** 2026-03-07
**Feature:** Add Documents gallery view in left sidebar with same card-based UI as Apps

## Overview

Added a dedicated "Documents" section to the left sidebar navigation that displays documents in the same beautiful card-based layout as the Apps view. This removes the need to access documents only through Command-K.

## What Was Added

### 1. New Components

#### `DocumentsView.tsx`
- Full-screen document gallery (mirrors `AppsView.tsx`)
- Features:
  - Search documents
  - Create new documents inline
  - Sort by: Recent, Name, Favorites
  - Featured document section (favorited or most recent)
  - Grid layout for all documents
  - Empty state with helpful messaging

#### `DocumentCard.tsx`
- Individual document card component (mirrors `AppCard.tsx`)
- Features:
  - Liquid Glass orb icon with **purple/pink gradient** (vs blue for apps)
  - Document preview text
  - Word count display
  - Double-click to rename
  - Favorite toggle
  - Delete action
  - Drag support for future features
  - Hover actions (favorite/delete buttons)

#### `DocumentsView.css` & `DocumentCard.css`
- Wabi-inspired Liquid Glass design
- Purple/pink gradient for document orbs: `rgba(139, 92, 246) → rgba(217, 70, 239) → rgba(236, 72, 153)`
- Responsive grid layout
- Glass morphism effects with backdrop blur
- Dark mode support

### 2. Updated Components

#### `Sidebar.tsx`
- Added "Documents" navigation button between Chat and Apps
- Document icon with file and lines
- Active state highlighting
- Removed unused imports (React, ChatList)
- Fixed `.tsx` extension imports to match codebase pattern

#### `ContentArea.tsx`
- Added `DocumentsView` import
- Added "documents" tab type to switch statement
- Renders `<DocumentsView />` when tab type is "documents"

#### `ui/types/tabs.ts`
- Added `"documents"` to `TabType` union

### 3. Design System

**Document Card Gradient (Purple/Pink):**
- Light mode: `rgba(139, 92, 246, 0.45)` → `rgba(217, 70, 239, 0.35)` → `rgba(236, 72, 153, 0.30)`
- Dark mode: `rgba(139, 92, 246, 0.50)` → `rgba(217, 70, 239, 0.35)` → `rgba(236, 72, 153, 0.25)`
- Border: `rgba(217, 70, 239, 0.35)`
- Icon color: `rgba(139, 92, 246, 0.80)` (light) / `rgba(217, 70, 239, 0.90)` (dark)

**vs App Card Gradient (Blue/Cyan) for reference:**
- Papr brand: `rgba(1, 97, 224)` → `rgba(12, 205, 255)` → `rgba(0, 254, 254)`

This visual distinction helps users quickly identify documents vs apps at a glance.

## User Experience

### Navigation Flow

1. **Sidebar → Documents button** → Opens Documents gallery view
2. **Search** → Filter documents by title/tags
3. **Create new document** → Enter name, press Enter or click Create
4. **Click document card** → Opens document in editor (existing DocumentView)
5. **Double-click title** → Rename inline
6. **Star icon** → Toggle favorite
7. **Trash icon** → Delete (with confirmation)

### Sort Options

- **Recent** (default): Most recently updated documents first
- **Name**: Alphabetical order
- **Favorites**: Favorited documents first, then by recent

### Featured Section

- Shows the most recent favorited document
- If no favorites, shows the most recent document
- Larger card with more preview text

## Architecture

### Data Flow

```
DocumentsView
  ├─ useArtifacts() hook
  │   ├─ Fetches documents via gateway.send("document:list")
  │   ├─ Filters artifacts.filter(a => a.type === "document")
  │   └─ Provides: create, delete, toggleFavorite, search
  │
  ├─ useTabs() hook
  │   └─ Creates document tabs: createTab("document", id, title)
  │
  └─ DocumentCard (for each document)
      ├─ Displays: title, preview, wordCount, date
      ├─ Actions: favorite, delete, rename, open
      └─ Drag-to-tab support
```

### Gateway Integration

Uses existing gateway endpoints:
- `document:list` - List all documents
- `document:create` - Create new document
- `document:update` - Update document (rename)
- `document:delete` - Delete document
- `document:toggle-favorite` - Toggle favorite status

## Files Changed

### New Files
- `ui/components/Documents/DocumentsView.tsx` (312 lines)
- `ui/components/Documents/DocumentCard.tsx` (244 lines)
- `ui/components/Documents/DocumentsView.css` (235 lines)
- `ui/components/Documents/DocumentCard.css` (316 lines)

### Modified Files
- `ui/components/Sidebar/Sidebar.tsx` - Added Documents nav button
- `ui/components/Layout/ContentArea.tsx` - Added DocumentsView routing
- `ui/types/tabs.ts` - Added "documents" tab type

## TypeScript Fixes

Fixed import pattern to match codebase:
- ❌ `import { Component } from "./Component.tsx"`
- ✅ `import { Component } from "./Component"`

Removed unused imports:
- Removed `React` (not used with new React 17+ JSX transform)
- Removed `ChatList` (not used in Sidebar)

## Testing Checklist

- [ ] Documents appear in gallery view
- [ ] Search filters documents correctly
- [ ] Create new document works
- [ ] Opening document loads in editor
- [ ] Rename via double-click works
- [ ] Favorite toggle updates UI and persists
- [ ] Delete removes document (with confirmation)
- [ ] Sort options work (Recent, Name, Favorites)
- [ ] Featured section shows correct document
- [ ] Empty state displays when no documents
- [ ] Cards display word count and preview
- [ ] Dark mode looks correct
- [ ] Drag support works (for future tab features)

## Future Enhancements

- Drag documents to create tabs
- Bulk operations (multi-select)
- Document templates
- Tags/categories view
- Recent documents shortcut
- Quick preview on hover
- Export/share options in card
- Duplicate document action

## Design Notes

The purple/pink gradient was chosen for documents to:
1. Differentiate from apps (blue/cyan)
2. Associate with writing/creativity
3. Maintain the Liquid Glass aesthetic
4. Provide visual hierarchy in mixed views

The same card layout, animations, and interactions as Apps ensures UI consistency while the distinct gradient provides clear visual categorization.
