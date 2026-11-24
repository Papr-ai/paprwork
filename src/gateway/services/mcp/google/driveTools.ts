/**
 * Google Drive tools on the public Drive API (v3). Scope: drive — read, create,
 * edit, organize, share and trash any file the user can access.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleFetch, googleJson, json, qs, safe, text, type GoogleTokenSource } from "./googleFetch.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,parents,owners(emailAddress),trashed";
const MAX_TEXT = 200_000;
const ALL_DRIVES = { supportsAllDrives: true };

/** Google-native types → export format that reads well as text. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/svg+xml",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

/** Create-as targets: upload text, Drive converts. */
const CONVERT: Record<string, { target: string; upload: string }> = {
  document: { target: "application/vnd.google-apps.document", upload: "text/plain" },
  spreadsheet: { target: "application/vnd.google-apps.spreadsheet", upload: "text/csv" },
  html_document: { target: "application/vnd.google-apps.document", upload: "text/html" },
};

export function isTextLike(mime: string | undefined): boolean {
  return !!mime && (/^text\//.test(mime) || /json|xml|javascript|yaml|csv|markdown|x-sh|sql/.test(mime));
}

export function escapeQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function buildSearchQuery(a: { text?: string; name?: string; mimeType?: string; folderId?: string; rawQuery?: string; includeTrashed?: boolean }): string {
  const parts: string[] = [];
  if (a.rawQuery) parts.push(`(${a.rawQuery})`);
  if (a.text) parts.push(`fullText contains '${escapeQuery(a.text)}'`);
  if (a.name) parts.push(`name contains '${escapeQuery(a.name)}'`);
  if (a.mimeType) parts.push(`mimeType = '${escapeQuery(a.mimeType)}'`);
  if (a.folderId) parts.push(`'${escapeQuery(a.folderId)}' in parents`);
  if (!a.includeTrashed) parts.push("trashed = false");
  return parts.join(" and ");
}

function multipart(meta: unknown, content: string, contentType: string): { body: string; type: string } {
  const b = `papr${Date.now().toString(36)}`;
  const body = [
    `--${b}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify(meta),
    `--${b}`, `Content-Type: ${contentType}; charset=UTF-8`, "", content, `--${b}--`, "",
  ].join("\r\n");
  return { body, type: `multipart/related; boundary=${b}` };
}

export function registerDriveTools(mcp: McpServer, token: GoogleTokenSource): void {
  const get = <T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) =>
    googleJson<T>(token, `${API}${path}${qs({ ...ALL_DRIVES, ...params })}`);
  const send = <T>(method: string, path: string, body: unknown, params: Record<string, string | boolean | undefined> = {}) =>
    googleJson<T>(token, `${API}${path}${qs({ ...ALL_DRIVES, fields: FIELDS, ...params })}`, {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

  mcp.registerTool("search_files", {
    title: "Search Drive",
    description: "Find files in Google Drive by content, name, type or folder. Newest first. rawQuery accepts Drive query syntax (e.g. \"modifiedTime > '2026-01-01'\").",
    inputSchema: {
      text: z.string().optional().describe("Words that appear in the file content or name"),
      name: z.string().optional().describe("Part of the file name"),
      mimeType: z.string().optional().describe("e.g. application/vnd.google-apps.document, application/pdf, application/vnd.google-apps.folder"),
      folderId: z.string().optional(),
      rawQuery: z.string().optional(),
      pageSize: z.number().int().min(1).max(50).default(15),
      pageToken: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, (a) => safe(async () => {
    const r = await get<{ files?: unknown[]; nextPageToken?: string }>("/files", {
      q: buildSearchQuery(a), pageSize: a.pageSize, pageToken: a.pageToken,
      orderBy: a.text ? undefined : "modifiedTime desc", includeItemsFromAllDrives: true, corpora: "allDrives",
      fields: `nextPageToken,files(${FIELDS})`,
    });
    return json({ files: r.files ?? [], nextPageToken: r.nextPageToken });
  }));

  mcp.registerTool("get_file", {
    title: "File details",
    description: "Metadata for a file or folder: name, type, owner, link, parents, size, modified time.",
    inputSchema: { fileId: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ fileId }) => safe(async () => json(await get(`/files/${encodeURIComponent(fileId)}`, { fields: `${FIELDS},description` }))));

  mcp.registerTool("read_file", {
    title: "Read file",
    description: "Read a file's text. Google Docs and Slides come back as plain text, Sheets as CSV (first sheet), text files as-is. Binary files (PDF, images) return metadata only.",
    inputSchema: { fileId: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ fileId }) => safe(async () => {
    const id = encodeURIComponent(fileId);
    const meta = await get<{ name: string; mimeType: string; webViewLink?: string }>(`/files/${id}`, { fields: "name,mimeType,webViewLink" });
    const exportAs = EXPORTS[meta.mimeType];
    let body: string;
    if (exportAs) body = await (await googleFetch(token, `${API}/files/${id}/export${qs({ mimeType: exportAs })}`)).text();
    else if (isTextLike(meta.mimeType)) body = await (await googleFetch(token, `${API}/files/${id}${qs({ alt: "media", ...ALL_DRIVES })}`)).text();
    else return json({ ...meta, note: "Binary file; open the link to view it." });
    const cut = body.length > MAX_TEXT;
    return text(`# ${meta.name} (${meta.mimeType})\n${meta.webViewLink ?? ""}\n\n${cut ? `${body.slice(0, MAX_TEXT)}\n…[truncated]` : body}`);
  }));

  mcp.registerTool("create_file", {
    title: "Create file",
    description: "Create a file in Drive. as=document makes a Google Doc from plain text, html_document a Google Doc from HTML, spreadsheet a Google Sheet from CSV, file a plain file of mimeType.",
    inputSchema: {
      name: z.string(),
      content: z.string().default(""),
      as: z.enum(["document", "html_document", "spreadsheet", "file"]).default("document"),
      mimeType: z.string().default("text/plain").describe("Only for as=file"),
      folderId: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, (a) => safe(async () => {
    const conv = a.as === "file" ? undefined : CONVERT[a.as];
    const meta = { name: a.name, mimeType: conv?.target ?? a.mimeType, ...(a.folderId ? { parents: [a.folderId] } : {}) };
    const mp = multipart(meta, a.content, conv?.upload ?? a.mimeType);
    return json(await googleJson(token, `${UPLOAD}/files${qs({ uploadType: "multipart", fields: FIELDS, ...ALL_DRIVES })}`, {
      method: "POST", headers: { "Content-Type": mp.type }, body: mp.body,
    }));
  }));

  mcp.registerTool("update_file_content", {
    title: "Replace file content",
    description: "Replace a file's whole content. For Google Docs pass plain text (or HTML with contentType text/html); for Sheets pass CSV. Read the file first and keep anything that should stay.",
    inputSchema: {
      fileId: z.string(),
      content: z.string(),
      contentType: z.string().optional().describe("Defaults: Docs text/plain, Sheets text/csv, else the file's type"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, ({ fileId, content, contentType }) => safe(async () => {
    const id = encodeURIComponent(fileId);
    const meta = await get<{ mimeType: string }>(`/files/${id}`, { fields: "mimeType" });
    const type = contentType ?? (meta.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : EXPORTS[meta.mimeType] ? "text/plain" : meta.mimeType);
    return json(await googleJson(token, `${UPLOAD}/files/${id}${qs({ uploadType: "media", fields: FIELDS, ...ALL_DRIVES })}`, {
      method: "PATCH", headers: { "Content-Type": `${type}; charset=UTF-8` }, body: content,
    }));
  }));

  mcp.registerTool("create_folder", {
    title: "Create folder",
    description: "Create a folder, optionally inside another folder.",
    inputSchema: { name: z.string(), parentId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ name, parentId }) => safe(async () =>
    json(await send("POST", "/files", { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) }))));

  mcp.registerTool("update_file", {
    title: "Rename / move file",
    description: "Rename a file, change its description, or move it between folders.",
    inputSchema: {
      fileId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      moveToFolderId: z.string().optional().describe("New parent folder; removes the old parents"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ fileId, name, description, moveToFolderId }) => safe(async () => {
    const id = encodeURIComponent(fileId);
    let move: Record<string, string> = {};
    if (moveToFolderId) {
      const cur = await get<{ parents?: string[] }>(`/files/${id}`, { fields: "parents" });
      move = { addParents: moveToFolderId, removeParents: (cur.parents ?? []).join(",") };
    }
    const body = { ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}) };
    return json(await send("PATCH", `/files/${id}`, body, move));
  }));

  mcp.registerTool("copy_file", {
    title: "Copy file",
    description: "Copy a file, optionally with a new name or into another folder.",
    inputSchema: { fileId: z.string(), name: z.string().optional(), folderId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ fileId, name, folderId }) => safe(async () =>
    json(await send("POST", `/files/${encodeURIComponent(fileId)}/copy`, { ...(name ? { name } : {}), ...(folderId ? { parents: [folderId] } : {}) }))));

  mcp.registerTool("share_file", {
    title: "Share file",
    description: "Give someone access to a file or folder. Confirm with the user before sharing outside the company.",
    inputSchema: {
      fileId: z.string(),
      email: z.string(),
      role: z.enum(["reader", "commenter", "writer"]).default("reader"),
      notify: z.boolean().default(true).describe("Send Google's share email"),
      message: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ fileId, email, role, notify, message }) => safe(async () =>
    json(await googleJson(token, `${API}/files/${encodeURIComponent(fileId)}/permissions${qs({ ...ALL_DRIVES, sendNotificationEmail: notify, emailMessage: notify ? message : undefined })}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "user", role, emailAddress: email }),
    }))));

  mcp.registerTool("trash_file", {
    title: "Move to trash",
    description: "Move a file or folder to Drive's trash (recoverable for 30 days). restore=true takes it back out.",
    inputSchema: { fileId: z.string(), restore: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, ({ fileId, restore }) => safe(async () => json(await send("PATCH", `/files/${encodeURIComponent(fileId)}`, { trashed: !restore }))));
}
