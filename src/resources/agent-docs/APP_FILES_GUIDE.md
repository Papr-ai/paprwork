# App Files — Large Binaries for Mini-Apps

Use **App Files** when a mini-app needs to store or serve files **over 10MB** (video, audio, large PDFs, datasets). Git cloud sync **skips** files over 10MB in `apps/{id}/` — they stay local only and **break published apps** if you reference them as static paths.

**App Files ≠ editing app source code.** To edit `index.html`, `app.ts`, etc., see [Editing App Source Files](#not-this-guide) in APP_AND_JOBS_GUIDE.md.

---

## When to use what

| Need | Use |
|------|-----|
| Video/audio/PDF served to visitors on apps.papr.ai | **App Files** — store file **id** in SQLite |
| Small icon, SVG, PDF under 10MB | `apps/{id}/assets/` — git sync works |
| Searchable brand book in **chat only** (not web asset) | `upload_document_to_memory` / Papr Memory |
| Job output file (recording, export) | `papr_files.add()` from Python job |

---

## Limits

- **Git sync:** 10MB max per file in `apps/{id}/`
- **App Files:** object storage (chunked upload, CDN when published)
- **Never** store absolute paths in DB columns — store App Files **id**, resolve with `papr.files.url(id)`

---

## Mini-app (browser)

SDK: `src/resources/mini-app-sdk/papr-files.ts` (served at `/__papr__/papr-files.js`)

```typescript
import { papr } from '/__papr__/papr-files.js';

// Upload (browser → object storage directly)
const { id } = await papr.files.upload(file, {
  onProgress: (p) => setPct(p.uploadedBytes / p.totalBytes),
});

// Save id in SQLite — NOT the path
await dbWrite('UPDATE assets SET file_id = ? WHERE id = ?', [id, rowId]);

// Serve to user
const { url } = await papr.files.url(id);
video.src = url;

// List / remove
const files = await papr.files.list();
await papr.files.remove(id);
```

**Rules:**
- Pass `File`/`Blob` directly to `upload()` — never `readAsDataURL()` large files
- `scope: 'user'` keeps uploads private to the uploader on public apps
- Do not compress video/audio before upload (breaks range requests)

---

## Jobs (Python)

SDK: `src/resources/job-sdk/papr_files.py`

```python
from papr_files import add

file_id = add("data/recordings/meeting.wav", scope="user")
con.execute(
    "UPDATE meetings SET audio_ref = ? WHERE id = ?",
    (file_id, meeting_id),
)
```

Wrap registration so a storage error never loses the recording.

---

## User upload (desktop UI)

**App Files** panel (beside Data Sources in the mini-app workspace) — drag & drop large files. Same object storage as SDK uploads.

---

## Agent debugging

```javascript
// Check for oversized files blocking web sync
get_cloud_sync_status({ appId: "..." })
// → oversizedAppFiles.message lists paths over 10MB

validate_app({ appId: "..." })
// → warning rule "oversized-for-git-sync" per file
```

After `write_file` or `bash cp` into `apps/{id}/`, tool results include `_largeFileReminder` when the file exceeds 10MB.

---

## Publish

Publishing verifies App Files references are uploaded. Missing uploads fail with:

> Re-upload from App Files, or remove the reference, then publish again.

---

## Not this guide

**Editing app source** (HTML, TS, CSS): use `read_app_file`, `write_file`, `edit_file`, `edit_app_file_lines` — see APP_AND_JOBS_GUIDE.md § "Editing App Source Files".
