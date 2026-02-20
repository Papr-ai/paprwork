# Message UI - V1 Match Implementation

## Summary
Updated MessageItem component to match Paprwork v1 design exactly, replacing emoji icons with proper avatars and matching the layout structure.

## Changes Made

### 1. Avatar System (Matches V1 Exactly)

#### User Avatar
**V1 Implementation**:
- Uses `session.user.image` or falls back to `https://avatar.vercel.sh/${userEmail}`
- 32x32px, rounded-full
- Container: `h-8 w-8`, `overflow-hidden`

**Our Implementation**:
```tsx
<img
  src={`https://avatar.vercel.sh/${userEmail}`}
  alt="User Avatar"
  className="message-avatar-user"
/>
```

**CSS**:
```css
.message-avatar-user {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}
```

#### Assistant Avatar
**V1 Implementation**:
- Uses `/images/papr-logo.svg` (blue gradient feather logo)
- 16x16px icon inside a w-5 h-5 container
- Parent container: `h-8 w-8`, `ring-1 ring-border bg-background`

**Our Implementation**:
```tsx
<div className="message-avatar-assistant">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    {/* Blue-to-purple gradient layers icon */}
  </svg>
</div>
```

**CSS**:
```css
.message-avatar-assistant {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--background-color);
  border: 1px solid var(--border-color);
}
```

### 2. Layout Structure (Matches V1 Exactly)

**V1 Structure**:
```
flex items-start gap-3 w-full
├── Avatar (flex-shrink-0 h-8 w-8)
└── Content (flex-1 flex flex-col gap-3)
     ├── MessageReasoning
     ├── message.parts
     └── MessageActions
```

**Our Structure**:
```tsx
<div className="message-item">  {/* flex items-start gap-3 */}
  <div className="message-avatar-container">  {/* flex-shrink-0 32px */}
    {/* User or Assistant Avatar */}
  </div>
  <div className="message-content">  {/* flex-1 flex-col gap-3 */}
    <ThinkingCard />       {/* MessageReasoning */}
    <ActioningCard />      {/* Tool calls */}
    <div className="message-text" />  {/* Text content */}
  </div>
</div>
```

### 3. Removed Elements

**From V1**: Names are **not displayed** in the message UI
- ❌ No "User" label
- ❌ No "Assistant" label
- ❌ No username display
- ✅ Only avatars shown

**What We Removed**:
- Removed emoji icons (👤 🤖)
- Removed any name/role labels
- Removed message-user and message-assistant background classes

### 4. Component Alignment

#### MessageItem.tsx
- ✅ Proper avatar rendering (user image vs assistant logo)
- ✅ 32x32px avatar containers
- ✅ 12px gap between avatar and content
- ✅ flex items-start alignment
- ✅ No background colors on message items (removed hover bg)

#### MessageItem.css
- ✅ `.message-avatar-container` - 32x32px
- ✅ `.message-avatar-user` - rounded image
- ✅ `.message-avatar-assistant` - ring border + background
- ✅ `.message-avatar-icon` - 16x16px SVG
- ✅ Removed .message-user and .message-assistant classes

#### ThinkingCard
- ✅ Already matches v1 zinc color scheme
- ✅ Collapsible with chevron
- ✅ Border-left accent

#### ActioningCard
- ✅ Already matches v1 color-coded states
- ✅ Blue (calling), Gray (success), Red (error)
- ✅ Tool emojis matching v1

## Visual Comparison

### Before (Emoji Icons)
```
👤  User message text here
🤖  Assistant response here
```

### After (V1 Match)
```
[32x32 avatar]  User message text here
[Papr logo]     Assistant response here
                [Thinking card if present]
                [Tool cards if present]
                Response text
```

## TODO: Logo Asset

Currently using a placeholder SVG gradient layers icon. Need to:
1. Copy actual `/images/papr-logo.svg` from v1
2. Save to `ui/public/images/papr-logo.svg`
3. Update MessageItem to use `<img src="/images/papr-logo.svg" />`

**Temporary Solution**: Using inline SVG with blue-to-purple gradient that approximates the Papr logo style.

## User Session Integration

**Current**: Hardcoded email `user@example.com` for Vercel avatar
**TODO**: Integrate with Electron/Settings to get actual user info
- Option 1: Store in settings (email/avatar URL)
- Option 2: Use system username
- Option 3: Allow user to customize avatar in settings

## Testing Checklist

- [x] Build succeeds with no errors
- [ ] User avatar shows Vercel generated avatar
- [ ] Assistant avatar shows proper icon/logo
- [ ] Avatar sizes are 32x32px
- [ ] Gap between avatar and content is 12px
- [ ] Messages align to flex-start (top)
- [ ] Thinking cards render below assistant avatar
- [ ] Tool cards render after thinking cards
- [ ] Text content renders after cards
- [ ] No background colors on messages (removed hover)
- [ ] Reload app and verify visual match with v1

## Files Changed

### Modified
- `ui/components/Chat/MessageItem.tsx` - Updated avatar rendering
- `ui/components/Chat/MessageItem.css` - Updated avatar styles and layout

### No Changes Needed
- `ui/components/Chat/ThinkingCard.tsx` - Already matches v1
- `ui/components/Chat/ActioningCard.tsx` - Already matches v1
- `ui/components/Chat/MessageList.tsx` - No changes needed

## Next Steps

1. Get actual Papr logo SVG from v1 and integrate
2. Add user session/settings integration for avatar
3. Test with real messages
4. Verify model picker dropdown works after reload
5. Test thinking cards with thinking-enabled models
