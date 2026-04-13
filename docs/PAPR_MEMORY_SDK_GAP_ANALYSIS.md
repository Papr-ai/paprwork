# Papr Memory Python SDK vs Tools - Feature Gap Analysis

**Date:** 2026-04-11  
**Status:** Complete analysis of missing SDK functionality

---

## Current Tool Coverage

### ✅ Implemented Tools (8 total)

1. **`add_agent_memory`** - Add memory items
2. **`search_agent_memory`** - Search memories with filters
3. **`register_schema`** - Create new schemas with node/relationship types
4. **`update_schema`** - Update existing schemas (**NEW - just added!**)
5. **`list_schemas`** - List all schemas (lightweight summary)
6. **`get_schema`** - Get full schema details
7. **`introspect_memory_graph`** - GraphQL schema introspection
8. **`query_memory_graph`** - Execute GraphQL queries

---

## Missing SDK Functionality

### 🔴 HIGH PRIORITY - Core Memory Operations

#### 1. Memory CRUD Operations

**Missing Methods:**
- `memory.update(memoryID, params)` - Update existing memory content/metadata
- `memory.delete(memoryID)` - Delete specific memory by ID
- `memory.deleteAll()` - Bulk delete memories with filters
- `memory.get(memoryID)` - Retrieve specific memory by ID
- `memory.addBatch([memories])` - Add multiple memories in one call

**Use Cases:**
- Editing incorrect memories
- Removing outdated information
- Bulk operations for cleanup
- Fetching specific memory details

**Python SDK Example:**
```python
# Update a memory
client.memory.update(
    memory_id="mem_123",
    content="Updated content",
    metadata={"category": "fact"}
)

# Delete a memory
client.memory.delete(memory_id="mem_123")

# Batch add
client.memory.add_batch(memories=[
    {"content": "Memory 1", "metadata": {...}},
    {"content": "Memory 2", "metadata": {...}}
])
```

**Impact:** Agents can ADD memories but can't UPDATE or DELETE them. This is a critical gap for memory management.

---

#### 2. Schema Delete Operation

**Missing Method:**
- `schemas.delete(schemaID)` - Soft delete (archive) a schema

**Use Case:**
- Deprecate old schemas
- Clean up test schemas
- Archive unused entity types

**Python SDK Example:**
```python
client.schemas.delete(schema_id="abc123")
# Soft deletes by marking as archived
```

**Impact:** Schemas can be created/updated but not deleted. Minor impact (can just ignore unused schemas).

---

### 🟡 MEDIUM PRIORITY - Advanced Features

#### 3. Document Processing

**Missing Resource:** `document` (entire API)

**Methods:**
- `document.upload(file, metadata)` - Upload PDFs, images, docs for processing
- `document.getStatus(uploadID)` - Check processing status
- `document.cancelProcessing(uploadID)` - Cancel long-running job

**Features:**
- Multi-tenant document processing
- TensorLake.ai / Reducto AI / Gemini Vision providers
- Real-time WebSocket status updates
- Automatic provider fallback
- Extracts text → creates memories automatically

**Use Cases:**
- Upload meeting notes (PDF) → extract memories
- Process receipts/invoices → structured data
- Analyze contracts/legal docs
- OCR images with text

**Python SDK Example:**
```python
# Upload document
result = client.document.upload(
    file=open("meeting_notes.pdf", "rb"),
    metadata={"source": "quarterly_review"}
)

# Check status
status = client.document.get_status(upload_id=result.upload_id)
# Returns: {"status": "processing", "progress": 45}
```

**Impact:** Major feature gap. Document processing is a killer feature for knowledge management. Agents can't process uploaded files.

---

#### 4. Message/Session Management

**Missing Resource:** `messages` (entire API)

**Methods:**
- `messages.store(content, role, sessionId, title)` - Store chat messages
- `messages.sessions.retrieveHistory(sessionId)` - Get conversation history
- `messages.sessions.process(sessionId)` - Process messages → memories
- `messages.sessions.compress(sessionId)` - Compress conversation
- `messages.sessions.retrieveStatus(sessionId)` - Check processing status

**Features:**
- Store raw chat messages (separate from memories)
- Session-based conversation grouping
- Background AI analysis → memory creation
- Role-based categorization (user: preferences/tasks, assistant: skills/learning)
- Conversation compression for context management

**Use Cases:**
- Store entire conversations before processing
- Retrieve conversation history by session
- Batch process conversations into memories
- Compress long conversations

**Python SDK Example:**
```python
# Store message
client.messages.store(
    content="I prefer dark mode in all apps",
    role="user",
    sessionId="session_123",
    title="Preferences Discussion"
)

# Retrieve history
history = client.messages.sessions.retrieve_history(
    session_id="session_123",
    limit=50
)

# Process session → memories
result = client.messages.sessions.process(session_id="session_123")
```

**Impact:** Medium. Paprwork already stores chat messages locally. This would be for syncing to Papr Memory platform.

---

#### 5. Sync Operations

**Missing Resource:** `sync` (entire API)

**Methods:**
- `sync.getDelta(cursor)` - Get incremental changes since cursor
- `sync.getTiers()` - Get Tier 0 (goals/OKRs) and Tier 1 (hot memories)

**Features:**
- Incremental sync with cursor-based pagination
- Tiered memory architecture (goals → hot memories)
- Efficient delta updates
- Multi-device sync

**Use Cases:**
- Sync memories across devices
- Efficient incremental updates
- Prioritized memory loading (goals first)
- Offline-first architecture

**Python SDK Example:**
```python
# Get changes since last sync
delta = client.sync.get_delta(cursor="last_cursor_value")
# Returns: {upserts: [...], deletes: [...], next_cursor: "new_cursor"}

# Get priority memories
tiers = client.sync.get_tiers()
# Returns: {tier0: [goals], tier1: [hot_memories]}
```

**Impact:** Medium. Useful for multi-device sync but not critical for single-device usage.

---

#### 6. OMO (Open Memory Object) Import/Export

**Missing Resource:** `omo` (entire API)

**Methods:**
- `omo.exportMemories()` - Export memories in OMO standard format
- `omo.exportMemoriesAsJson()` - Export as downloadable JSON file
- `omo.importMemories(memories)` - Import from OMO format

**Features:**
- OMO v1 standard format (https://github.com/papr-ai/open-memory-object)
- Memory portability between platforms
- Data export for backup
- Import from other OMO-compliant systems

**Use Cases:**
- Export memories for backup
- Migrate to another OMO platform
- Share memory sets
- Data portability

**Python SDK Example:**
```python
# Export memories
export = client.omo.export_memories(
    user_id="user_123",
    format="omo_v1"
)

# Import memories
result = client.omo.import_memories(
    memories=[...],  # OMO format
    user_id="user_123"
)
```

**Impact:** Low. Nice-to-have for data portability but not critical.

---

### 🟢 LOW PRIORITY - Administrative Features

#### 7. User Management

**Missing Resource:** `user` (entire API)

**Methods:**
- `user.create(external_id, name, email)` - Create/link users
- `user.update(userID, params)` - Update user details
- `user.list()` - List users for developer
- `user.delete(userID)` - Delete user association
- `user.createBatch([users])` - Create multiple users

**Features:**
- Multi-tenant user management
- External ID mapping
- Developer-user associations
- Workspace assignments
- Batch operations

**Use Cases:**
- SaaS applications with multiple users
- Team collaboration
- User provisioning
- Access control

**Impact:** Low. Paprwork is single-user (authenticated via Papr login). Multi-user features not needed.

---

#### 8. Feedback Submission

**Missing Resource:** `feedback` (entire API)

**Methods:**
- `feedback.submit(rating, content, metadata)` - Submit user feedback
- `feedback.submitBatch([feedback])` - Batch feedback submission

**Features:**
- User feedback collection
- Memory quality ratings
- Bug reports
- Feature requests

**Use Cases:**
- Collecting feedback on memory quality
- Reporting issues
- Rating search relevance

**Impact:** Low. More relevant for Papr Memory platform itself, not for Paprwork agents.

---

## Priority Ranking for Implementation

### 🚀 Should Implement Next

1. **Memory Update/Delete** (`memory.update`, `memory.delete`)
   - Agents can't edit or remove memories currently
   - Critical for memory management workflow
   - Relatively simple to implement (similar to `add_agent_memory`)

2. **Batch Memory Add** (`memory.addBatch`)
   - More efficient than multiple single calls
   - Useful for bulk memory creation
   - Easy to implement (wrap array in API call)

3. **Document Upload** (`document.upload`, `document.getStatus`)
   - Killer feature for processing PDFs/images
   - Automatic memory extraction
   - Would require file upload support

### 🤔 Consider for Future

4. **Message/Session APIs** (`messages.store`, `messages.sessions.*`)
   - Useful for syncing to Papr Memory platform
   - Not critical (we have local chat storage)
   - Medium complexity

5. **Schema Delete** (`schemas.delete`)
   - Nice to have for cleanup
   - Can work around by ignoring schemas
   - Low complexity

### 📦 Nice to Have

6. **Sync APIs** (`sync.getDelta`, `sync.getTiers`)
   - Multi-device sync feature
   - Not needed for single-user app
   - Medium complexity

7. **OMO Import/Export** (`omo.*`)
   - Data portability feature
   - Low priority for MVP
   - Low complexity

8. **User Management** (`user.*`)
   - Not needed for single-user app
   - Enterprise feature
   - Can skip entirely

9. **Feedback APIs** (`feedback.*`)
   - Platform-level feature
   - Not needed for agents
   - Can skip entirely

---

## Implementation Roadmap

### Phase 1: Memory Management (High Priority)

**Tools to Add:**
1. `update_memory(memoryId, content, metadata)` - Update existing memory
2. `delete_memory(memoryId)` - Delete specific memory
3. `get_memory(memoryId)` - Retrieve specific memory details
4. `add_memories_batch([memories])` - Bulk add memories

**Estimated Effort:** 2-3 hours (similar to existing tools)

**Impact:** Completes core memory CRUD operations

---

### Phase 2: Document Processing (Medium Priority)

**Tools to Add:**
1. `upload_document(filePath, metadata)` - Upload file for processing
2. `get_document_status(uploadId)` - Check processing status
3. `cancel_document_processing(uploadId)` - Cancel upload

**Estimated Effort:** 4-6 hours (requires file upload support)

**Impact:** Major feature - agents can process uploaded documents

**Challenges:**
- Need to handle file uploads in tool framework
- May need to use bash tool to read files first
- Status polling for long-running uploads

---

### Phase 3: Schema Cleanup (Low Priority)

**Tool to Add:**
1. `delete_schema(schemaId)` - Archive schema

**Estimated Effort:** 30 minutes

**Impact:** Minor - schema cleanup

---

### Phase 4: Advanced Features (Future)

Consider adding if there's demand:
- Message/session APIs for platform sync
- Sync APIs for multi-device support
- OMO import/export for data portability

---

## API Coverage Summary

| Resource | Methods | Exposed as Tools | Coverage |
|----------|---------|------------------|----------|
| **Memory** | 7 | 2 (add, search) | **29%** 🔴 |
| **Schemas** | 5 | 4 (create, update, list, get) | **80%** 🟢 |
| **GraphQL** | 1 | 2 (introspect, query) | **200%** ✅ |
| **Document** | 3 | 0 | **0%** 🔴 |
| **Messages** | 5 | 0 | **0%** 🔴 |
| **Sync** | 2 | 0 | **0%** 🔴 |
| **OMO** | 3 | 0 | **0%** 🔴 |
| **User** | 5 | 0 | **0%** 🟢 (not needed) |
| **Feedback** | 2 | 0 | **0%** 🟢 (not needed) |

**Overall Coverage:** 8 / 33 methods = **24%**

**Core Coverage (Memory + Schemas + GraphQL):** 8 / 15 methods = **53%**

---

## Key Takeaways

1. **Memory CRUD is incomplete** - Agents can add and search memories but can't update/delete them. This is the biggest gap.

2. **Document processing is missing** - This would be a killer feature (upload PDFs → automatic memories).

3. **Schema management is strong** - We just added full schema support (create/update/list/get). Only missing delete.

4. **GraphQL is excellent** - We have both introspection and query tools, more than the Python SDK exposes directly.

5. **Multi-tenant features skipped** - User management, feedback, etc. are not needed for single-user Paprwork.

6. **Should prioritize:**
   - ✅ Memory update/delete (critical gap)
   - ✅ Batch memory add (efficiency)
   - 🤔 Document upload (major feature)
   - 🤔 Message/session APIs (platform sync)

---

## Recommendation

**Immediate Next Steps:**

1. Add `update_memory`, `delete_memory`, `get_memory` tools (~2 hours)
2. Add `add_memories_batch` tool (~30 minutes)
3. Consider document upload tools if there's demand (~4-6 hours)

This would bring core Memory coverage from 29% → 86% (6/7 methods).

---

**Status:** Analysis complete  
**Next:** Implement Phase 1 (Memory Management tools)  
**Version:** Paprwork v2.0  
**Date:** 2026-04-11
