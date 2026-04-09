# Context Menu Fix for Text Inputs

**Added:** 2026-03-31  
**Issue:** Users couldn't right-click to copy/paste in chat input or other text fields  
**Status:** ✅ FIXED

## Problem

Users reported that right-clicking in the chat input textarea didn't show a context menu for copy/paste operations. This made it difficult to:
- Copy text from the input
- Paste text into the input
- Use standard text editing shortcuts via context menu

## Root Cause

The Electron main process had `Menu.setApplicationMenu(null)` which disables the default application menu, but this also disabled the context menu for all inputs throughout the app.

## Solution

Added a custom context menu handler that shows standard edit operations for text inputs:

```javascript
mainWindow.webContents.on('context-menu', (event, params) => {
  const { selectionText, isEditable, inputFieldType } = params;
  
  // Only show menu for editable fields or when text is selected
  if (!isEditable && !selectionText) return;
  
  const menu = Menu.buildFromTemplate([
    ...(selectionText ? [{
      label: 'Copy',
      role: 'copy',
      accelerator: 'CmdOrCtrl+C'
    }] : []),
    ...(isEditable ? [
      {
        label: 'Cut',
        role: 'cut',
        accelerator: 'CmdOrCtrl+X',
        enabled: !!selectionText
      },
      {
        label: 'Paste',
        role: 'paste',
        accelerator: 'CmdOrCtrl+V'
      }
    ] : []),
    ...(isEditable && selectionText ? [
      { type: 'separator' },
      {
        label: 'Select All',
        role: 'selectAll',
        accelerator: 'CmdOrCtrl+A'
      }
    ] : [])
  ]);
  
  menu.popup();
});
```

## Features

### Smart Context Detection

The menu only appears when relevant:
- **Editable fields** (textarea, input) → Shows Cut, Paste
- **Selected text** (anywhere) → Shows Copy
- **Editable + selected text** → Shows Cut, Copy, Paste, Select All

### Menu Items

| Item | Appears When | Keyboard Shortcut |
|------|--------------|-------------------|
| Copy | Text is selected | Cmd/Ctrl+C |
| Cut | Editable field with selected text | Cmd/Ctrl+X |
| Paste | Editable field | Cmd/Ctrl+V |
| Select All | Editable field with selected text | Cmd/Ctrl+A |

### Platform Support

- **macOS**: Uses Cmd key (Cmd+C, Cmd+V, etc.)
- **Windows/Linux**: Uses Ctrl key (Ctrl+C, Ctrl+V, etc.)
- Accelerators automatically adapt via `CmdOrCtrl` role

## Testing

### Manual Test Cases

1. **Copy from input**
   - Type text in chat input
   - Select text
   - Right-click → Verify "Copy" appears
   - Click Copy → Verify text is in clipboard

2. **Paste into input**
   - Copy text elsewhere
   - Right-click in chat input
   - Verify "Paste" appears
   - Click Paste → Verify text is inserted

3. **Cut from input**
   - Type text in chat input
   - Select text
   - Right-click → Verify "Cut" appears
   - Click Cut → Verify text is removed and in clipboard

4. **Context menu outside inputs**
   - Right-click on non-editable text (messages, sidebar)
   - Verify no menu appears (correct behavior)

5. **Keyboard shortcuts still work**
   - Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+X work without menu
   - Menu just provides visual discoverability

## Files Changed

- `src/electron/index.cjs` - Added context menu handler after `Menu.setApplicationMenu(null)`

## Impact

- **Before**: No context menu, users had to memorize keyboard shortcuts
- **After**: Standard right-click copy/paste menu in all text inputs
- **User Experience**: Matches native app behavior (TextEdit, Notepad, etc.)

## Future Enhancements

### Spell Check

Could add spell check menu items:

```javascript
if (params.misspelledWord) {
  const suggestions = params.dictionarySuggestions.slice(0, 5);
  menu.insert(0, ...suggestions.map(word => ({
    label: word,
    click: () => mainWindow.webContents.replaceMisspelling(word)
  })));
  menu.insert(suggestions.length, { type: 'separator' });
}
```

### Undo/Redo

Could add undo/redo for text fields:

```javascript
{
  label: 'Undo',
  role: 'undo',
  accelerator: 'CmdOrCtrl+Z',
  enabled: params.editFlags.canUndo
},
{
  label: 'Redo',
  role: 'redo',
  accelerator: 'Shift+CmdOrCtrl+Z',
  enabled: params.editFlags.canRedo
}
```

### Context-Aware Items

Could show different items based on context:

```javascript
// For links
if (params.linkURL) {
  menu.append(new MenuItem({
    label: 'Copy Link Address',
    click: () => clipboard.writeText(params.linkURL)
  }));
}

// For images
if (params.hasImageContents) {
  menu.append(new MenuItem({
    label: 'Copy Image',
    role: 'copyImageContents'
  }));
}
```

## Related Documentation

- [Electron Context Menu API](https://www.electronjs.org/docs/latest/api/web-contents#event-context-menu)
- [Electron Menu API](https://www.electronjs.org/docs/latest/api/menu)
- [Electron Menu Roles](https://www.electronjs.org/docs/latest/api/menu-item#roles)
