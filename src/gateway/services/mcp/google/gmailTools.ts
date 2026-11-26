/**
 * Gmail tools on the public Gmail API (v1). Scope: gmail.modify — read, compose,
 * send, label, trash. No permanent delete (that would need full mail.google.com).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { googleJson, json, qs, safe, type GoogleTokenSource } from "./googleFetch.js";
import { attachments, buildRawEmail, header, messageText, replySubject, type GmailPart } from "./gmailMime.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_BODY = 20_000;

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

function summarize(m: GmailMessage) {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    labels: m.labelIds,
    snippet: m.snippet,
  };
}

function full(m: GmailMessage) {
  const body = messageText(m.payload);
  return {
    ...summarize(m),
    cc: header(m.payload, "Cc"),
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…[truncated]` : body,
    attachments: attachments(m.payload),
  };
}

const recipients = z.array(z.string()).describe("Email addresses");
const composeShape = {
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().describe("Subject line. Ignored for replies (uses Re: original)").default(""),
  body: z.string().describe("Message body"),
  html: z.boolean().optional().describe("Body is HTML (default plain text)"),
  replyToMessageId: z.string().optional().describe("Gmail message id to reply to; keeps the thread"),
};

export function registerGmailTools(mcp: McpServer, token: GoogleTokenSource): void {
  const get = <T>(path: string) => googleJson<T>(token, `${API}${path}`);
  const post = <T>(path: string, body: unknown) =>
    googleJson<T>(token, `${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  async function compose(a: z.infer<z.ZodObject<typeof composeShape>>) {
    let threadId: string | undefined;
    let subject = a.subject;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (a.replyToMessageId) {
      const orig = await get<GmailMessage>(`/messages/${encodeURIComponent(a.replyToMessageId)}${qs({ format: "metadata", metadataHeaders: ["Subject", "Message-ID", "References"] })}`);
      threadId = orig.threadId;
      subject = replySubject(header(orig.payload, "Subject"));
      inReplyTo = header(orig.payload, "Message-ID");
      references = [header(orig.payload, "References"), inReplyTo].filter(Boolean).join(" ");
    }
    const raw = buildRawEmail({ to: a.to, cc: a.cc, bcc: a.bcc, subject, body: a.body, html: a.html, inReplyTo, references });
    return { raw, ...(threadId ? { threadId } : {}) };
  }

  mcp.registerTool("search_emails", {
    title: "Search email",
    description: "Search the mailbox with Gmail search syntax (e.g. 'from:sarah contract newer_than:7d', 'is:unread in:inbox'). Returns threads with sender, subject, date and snippet.",
    inputSchema: {
      query: z.string().default("in:inbox").describe("Gmail search query"),
      maxResults: z.number().int().min(1).max(25).default(10),
      pageToken: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, ({ query, maxResults, pageToken }) => safe(async () => {
    const list = await get<{ threads?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }>(
      `/threads${qs({ q: query, maxResults, pageToken })}`,
    );
    const threads = await Promise.all((list.threads ?? []).map(async (t) => {
      const th = await get<{ id: string; messages?: GmailMessage[] }>(`/threads/${t.id}${qs({ format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] })}`);
      const last = th.messages?.[th.messages.length - 1];
      return { threadId: th.id, messageCount: th.messages?.length ?? 0, latest: last ? summarize(last) : undefined };
    }));
    return json({ threads, nextPageToken: list.nextPageToken, estimate: list.resultSizeEstimate });
  }));

  mcp.registerTool("read_thread", {
    title: "Read email thread",
    description: "Read every message in a thread (sender, recipients, date, plain-text body, attachment names).",
    inputSchema: { threadId: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ threadId }) => safe(async () => {
    const th = await get<{ id: string; messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(threadId)}${qs({ format: "full" })}`);
    return json({ threadId: th.id, messages: (th.messages ?? []).map(full) });
  }));

  mcp.registerTool("read_email", {
    title: "Read email",
    description: "Read one message by id.",
    inputSchema: { messageId: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ messageId }) => safe(async () => json(full(await get<GmailMessage>(`/messages/${encodeURIComponent(messageId)}${qs({ format: "full" })}`)))));

  mcp.registerTool("send_email", {
    title: "Send email",
    description: "Send an email now, or reply in a thread with replyToMessageId. Sends immediately — confirm the recipients and text with the user first.",
    inputSchema: composeShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, (a) => safe(async () => {
    const sent = await post<{ id: string; threadId: string }>("/messages/send", await compose(a));
    return json({ sent: true, id: sent.id, threadId: sent.threadId });
  }));

  mcp.registerTool("create_draft", {
    title: "Create draft",
    description: "Save an email (or reply, with replyToMessageId) as a draft in Gmail without sending.",
    inputSchema: composeShape,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, (a) => safe(async () => {
    const d = await post<{ id: string; message: { id: string; threadId: string } }>("/drafts", { message: await compose(a) });
    return json({ draftId: d.id, messageId: d.message.id, threadId: d.message.threadId });
  }));

  mcp.registerTool("list_drafts", {
    title: "List drafts",
    description: "List saved drafts.",
    inputSchema: { maxResults: z.number().int().min(1).max(25).default(10) },
    annotations: { readOnlyHint: true },
  }, ({ maxResults }) => safe(async () => {
    const list = await get<{ drafts?: Array<{ id: string; message: { id: string } }> }>(`/drafts${qs({ maxResults })}`);
    const drafts = await Promise.all((list.drafts ?? []).map(async (d) => {
      const full = await get<{ id: string; message: GmailMessage }>(`/drafts/${d.id}${qs({ format: "metadata" })}`);
      return { draftId: d.id, ...summarize(full.message) };
    }));
    return json({ drafts });
  }));

  mcp.registerTool("send_draft", {
    title: "Send draft",
    description: "Send a saved draft. Confirm with the user first.",
    inputSchema: { draftId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, ({ draftId }) => safe(async () => json(await post("/drafts/send", { id: draftId }))));

  mcp.registerTool("list_labels", {
    title: "List labels",
    description: "List Gmail labels (system and user) with their ids.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => safe(async () => {
    const r = await get<{ labels?: Array<{ id: string; name: string; type: string }> }>("/labels");
    return json((r.labels ?? []).map(({ id, name, type }) => ({ id, name, type })));
  }));

  mcp.registerTool("create_label", {
    title: "Create label",
    description: "Create a new Gmail label.",
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, ({ name }) => safe(async () => json(await post("/labels", { name, labelListVisibility: "labelShow", messageListVisibility: "show" }))));

  mcp.registerTool("modify_labels", {
    title: "Label / archive / mark read",
    description: "Add or remove label ids on threads or messages. Archive = remove INBOX. Mark read = remove UNREAD; unread = add UNREAD. Star = add STARRED. Use list_labels for user label ids.",
    inputSchema: {
      ids: z.array(z.string()).min(1).max(100).describe("Thread or message ids"),
      target: z.enum(["thread", "message"]).default("thread"),
      addLabelIds: z.array(z.string()).optional(),
      removeLabelIds: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, ({ ids, target, addLabelIds, removeLabelIds }) => safe(async () => {
    const body = { addLabelIds: addLabelIds ?? [], removeLabelIds: removeLabelIds ?? [] };
    await Promise.all(ids.map((id) => post(`/${target}s/${encodeURIComponent(id)}/modify`, body)));
    return json({ updated: ids.length, target, ...body });
  }));

  mcp.registerTool("trash_emails", {
    title: "Move to trash",
    description: "Move threads or messages to Trash (recoverable for 30 days). Set restore=true to take them back out.",
    inputSchema: {
      ids: z.array(z.string()).min(1).max(100),
      target: z.enum(["thread", "message"]).default("thread"),
      restore: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, ({ ids, target, restore }) => safe(async () => {
    await Promise.all(ids.map((id) => post(`/${target}s/${encodeURIComponent(id)}/${restore ? "untrash" : "trash"}`, {})));
    return json({ [restore ? "restored" : "trashed"]: ids.length, target });
  }));
}
