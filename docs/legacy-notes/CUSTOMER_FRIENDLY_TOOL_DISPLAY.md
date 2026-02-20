# Customer-Friendly Tool Display

**Implementation**: V1's smart bash command translation with fallback to actual commands

---

## Overview

Tool calls now show customer-friendly descriptions instead of raw tool names or technical details.

### Examples

**Instead of**:
```
→ bash
→ Running ls -la ~/Dropbox/reach
```

**You see**:
```
→ Listing reach
→ Getting info from github.com
→ Updating README.md
```

---

## Smart Bash Command Translation

### Supported Commands

#### 1. **curl** - Web Requests
```bash
curl https://api.github.com/users/octocat
```
**Shows**: `Getting info from api.github.com` (while running) → `Got info from api.github.com` (complete)

#### 2. **cat >** - File Creation/Updates
```bash
cat > ~/Documents/report.md <<EOF
```
**Shows**: `Updating report.md` → `Updated report.md`

#### 3. **cat** - File Reading
```bash
cat ~/Documents/notes.txt
```
**Shows**: `Reading notes.txt` → `Read notes.txt`

#### 4. **grep** - Searching
```bash
grep -r "reach" ~/Dropbox
```
**Shows**: `Searching for "reach"` → `Searched for "reach"`

#### 5. **ls** - Listing
```bash
ls -la ~/Dropbox/reach
```
**Shows**: `Listing reach` → `Listed reach`

#### 6. **npm/yarn** - Package Management
```bash
npm install react
```
**Shows**: `Installing react` → `Installed react`

```bash
npm run build
```
**Shows**: `Running build` → `Ran build`

#### 7. **git** - Version Control
```bash
git clone https://github.com/user/repo.git
```
**Shows**: `Cloning repo` → `Cloned repo`

```bash
git pull
```
**Shows**: `Updating repository` → `Updated repository`

#### 8. **mkdir** - Directory Creation
```bash
mkdir -p ~/Projects/new-app
```
**Shows**: `Creating new-app` → `Created new-app`

#### 9. **rm** - Deletion
```bash
rm -rf ~/temp/old-files
```
**Shows**: `Deleting old-files` → `Deleted old-files`

#### 10. **cp** - Copying
```bash
cp source.txt ~/backup/source.txt
```
**Shows**: `Copying to source.txt` → `Copied to source.txt`

#### 11. **mv** - Moving
```bash
mv old-name.txt new-name.txt
```
**Shows**: `Moving to new-name.txt` → `Moved to new-name.txt`

---

## Fallback Behavior

### Unknown Commands
For commands without specific patterns, shows the actual command (truncated):

```bash
osascript -e 'tell application "Finder" to make new alias...'
```
**Shows**: `Running: osascript -e 'tell application "...` (40 char limit)

---

## Other Tool Types

Non-bash tools have friendly names:

```
create_document  → Creating document / Document created
read_document    → Reading document / Document read
update_document  → Updating document / Document updated
list_documents   → Listing documents / Documents listed
create_app       → Creating app / App created
read_app         → Reading app / App read
update_app       → Updating app / App updated
list_apps        → Listing apps / Apps listed
```

Unknown tools: Converts `snake_case` to readable format:
```
my_custom_tool → my custom tool...
```

---

## Implementation Details

### File Path Extraction

Smart filename extraction removes technical details:

```typescript
// UUID-based paths → "document"
/docs/a1b2c3d4-e5f6-7890-abcd-ef1234567890.md → "document"

// Clean extensions
/path/to/notes-content.md → "notes"

// Truncate long names
/very/long/path/with/extremely-long-filename.txt → "extremely-long-filenam..."
```

### Status Text Changes

- **While running**: Present progressive tense ("Creating", "Reading", "Getting")
- **After completion**: Past tense ("Created", "Read", "Got")

---

## Code Structure

**File**: `ui/components/Chat/ExploringCard.tsx`

```typescript
// Helper: Extract clean filenames from paths
function getDisplayFilename(path: string): string

// Main: Translate bash commands to friendly descriptions
function getBashCommandDescription(command: string, isRunning: boolean): string

// Entry: Get display text for any tool call
function getToolCallDisplayText(toolCall: ToolCall): string
```

---

## Examples in Context

### Example 1: Listing Files

**User**: "Show me what's in my Dropbox reach folder"

**UI During**:
```
▼ Exploring
  → Listing reach
```

**UI After**:
```
▼ Exploring
  → Listed reach
```

### Example 2: Web Request

**User**: "Check the GitHub API status"

**UI During**:
```
▼ Exploring
  → Getting info from api.github.com
```

**UI After**:
```
▼ Exploring
  → Got info from api.github.com
```

### Example 3: File Search

**User**: "Find all mentions of 'reach' in my documents"

**UI During**:
```
▼ Exploring
  → Searching for "reach"
```

**UI After**:
```
▼ Exploring
  → Searched for "reach"
```

### Example 4: Unknown Command (Fallback)

**User**: "Add Papr folder to Finder sidebar"

**UI During**:
```
▼ Exploring
  → Running: osascript -e 'tell application...
```

**UI After**:
```
▼ Exploring
  → Ran: osascript -e 'tell application...
```

---

## Design Principles

1. **Customer-First Language**: Use terminology users understand
2. **Action-Oriented**: Focus on what's being done, not how
3. **Contextual**: Show relevant details (domain, filename, search term)
4. **Concise**: Keep descriptions under 50 characters when possible
5. **Smart Fallback**: Show actual command if no pattern matches (better than hiding info)

---

## No Emojis

As per requirements, we don't use emoji indicators:
- ❌ No ⏳ spinner
- ❌ No ✓ checkmark
- ❌ No ✗ error indicator

Status is conveyed through text alone:
- "Creating" (in progress)
- "Created" (complete)

---

## Testing

### Test Commands

Try these prompts to verify different patterns:

1. **curl**: "Check the GitHub API"
2. **cat >**: "Create a new file called test.txt"
3. **cat**: "Show me the contents of ~/.bashrc"
4. **grep**: "Search for 'reach' in my Dropbox"
5. **ls**: "List files in ~/Documents"
6. **npm**: "Install the react package"
7. **git**: "Clone the tensorflow repository"
8. **mkdir**: "Create a new folder called projects"
9. **Unknown**: "Add ~/Papr to Finder sidebar"

### Expected Behavior

- Tool call appears immediately with "present tense" description
- Description updates to "past tense" when complete
- No emojis shown
- Descriptions are clear and customer-friendly
- Fallback shows actual command (truncated) if no pattern matches

---

## Future Enhancements

Potential additions based on usage patterns:

1. **docker**: "Starting container", "Building image"
2. **ssh**: "Connecting to server"
3. **scp**: "Uploading to server", "Downloading from server"
4. **tar**: "Extracting archive", "Creating archive"
5. **python/node**: "Running script"
6. **make**: "Building project"

---

## Related Files

- **ui/components/Chat/ExploringCard.tsx** - Main implementation
- **ui/components/Chat/ExploringCard.css** - Styling
- **ui/hooks/useAgent.ts** - Tool call chunk processing

---

## Status

✅ **COMPLETE** - Customer-friendly descriptions implemented with V1 parity
