import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, type FakeElement } from './ui-test-dom.js';

const ui = join(dirname(fileURLToPath(import.meta.url)), '../bundle/apps/outreach-console/ui');
const { askConfirm, askText } = await import(join(ui, 'dialog.js')) as {
  askConfirm: (message: string) => Promise<boolean>;
  askText: (message: string) => Promise<string | null>;
};
const { call } = await import(join(ui, 'api.js')) as { call: (action: string, params?: Record<string, string>) => Promise<unknown> };
const { renderReview } = await import(join(ui, 'review.js')) as { renderReview: (actions: unknown[], act: (...args: unknown[]) => unknown) => void };
const { renderApprovals } = await import(join(ui, 'approvals.js')) as { renderApprovals: (approvals: unknown[], act: (...args: unknown[]) => unknown) => void };
const { createActions } = await import(join(ui, 'actions.js')) as { createActions: (refresh: () => Promise<void>) => (button: FakeElement, action: string, params: Record<string, string>, done: string) => Promise<void> };
let document: FakeDocument;
let events: Map<string, Set<() => void>>;
const modal = (): FakeElement => document.body.find('dialog')!;

beforeEach(() => {
  document = new FakeDocument();
  events = new Map();
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('addEventListener', (name: string, fn: () => void) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)!.add(fn);
  });
  vi.stubGlobal('removeEventListener', (name: string, fn: () => void) => events.get(name)?.delete(fn));
});
afterEach(() => {
  for (const listener of [...(events.get('pagehide') ?? [])]) listener();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('iframe-safe decisions', () => {
  it('focuses Cancel first, labels the modal and restores prior focus', async () => {
    const trigger = document.createElement('button'); trigger.focus();
    const decision = askConfirm('<img src=x onerror=alert(1)>');
    expect(modal().attributes.get('aria-labelledby')).toBe('decision-title');
    expect(modal().attributes.get('aria-describedby')).toBe('decision-message');
    expect(modal().find('p')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.activeElement!.textContent).toBe('Cancel');
    await modal().findText('Cancel')!.emit('click');
    expect(await decision).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.body.children).toHaveLength(0);
  });
  it('Escape and page hide never approve, and a second pending dialog is rejected', async () => {
    const first = askConfirm('Stop?');
    expect(await askConfirm('Stop again?')).toBe(false);
    expect(document.body.children).toHaveLength(1);
    await modal().emit('cancel');
    expect(await first).toBe(false);
    const next = askConfirm('Stop?');
    for (const listener of [...events.get('pagehide')!]) listener();
    expect(await next).toBe(false);
  });
  it('returns focus to Refresh if a background refresh detached the triggering control', async () => {
    const list = document.getElementById('review');
    const trigger = document.createElement('button');
    list.append(trigger); trigger.focus();
    const decision = askText('Message ID');
    list.replaceChildren(document.createElement('li'));
    await modal().emit('cancel');
    expect(await decision).toBeNull();
    expect(document.activeElement).toBe(document.getElementById('refresh'));
  });
  it('approves only explicit form submission and resolves once', async () => {
    const decision = askConfirm('Stop?');
    await modal().find('form')!.emit('submit');
    expect(await decision).toBe(true);
    expect(document.body.children).toHaveLength(0);
  });
  it('requires nonblank message ID, trims it, and supports cancellation', async () => {
    const decision = askText('Message ID');
    const input = modal().find('input')!;
    expect(document.activeElement).toBe(input);
    input.value = '  ';
    await modal().find('form')!.emit('submit');
    expect(document.body.children).toHaveLength(1);
    input.value = '  provider-123  ';
    await modal().find('form')!.emit('submit');
    expect(await decision).toBe('provider-123');
    const cancelled = askText('Message ID');
    await modal().emit('cancel');
    expect(await cancelled).toBeNull();
  });
  it('fails closed when modal support is unavailable', async () => {
    const original = document.createElement.bind(document);
    document.createElement = (tag) => {
      const element = original(tag);
      if (tag === 'dialog') element.showModal = () => { throw new Error('unavailable'); };
      return element;
    };
    expect(await askConfirm('Stop?')).toBe(false);
    expect(document.body.children).toHaveLength(0);
  });
});

describe('browser/backend boundary', () => {
  it('uses the assigned app ID and keeps credentials out of browser requests', async () => {
    vi.stubGlobal('location', { search: '?appId=remapped-id' });
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ stdout: JSON.stringify({ ok: true, data: { ready: true } }) }) });
    vi.stubGlobal('fetch', fetch);
    expect(await call('overview')).toEqual({ ready: true });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/app/backend/overview');
    expect(JSON.parse(options.body)).toEqual({ appId: 'remapped-id', params: {} });
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  });
  it('uses the document ID fallback and propagates backend role denial', async () => {
    document.documentElement.dataset.appId = 'document-id';
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ stdout: JSON.stringify({ ok: false, error: 'Forbidden', status: 403 }) }) });
    vi.stubGlobal('fetch', fetch);
    await expect(call('kill-switch', { engaged: 'true' })).rejects.toThrow('Forbidden');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).appId).toBe('document-id');
  });
  it('rejects malformed backend output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ stdout: 'not-json' }) }));
    await expect(call('overview')).rejects.toThrow('the backend returned no result');
  });
  it('keeps exact approval hash and renders untrusted preview as text', async () => {
    const act = vi.fn();
    renderApprovals([{ id: 'approval-id', scope: 'campaign_version', operation_hash: 'f'.repeat(64), expires_at: 1, preview: { campaign: '<script>bad()</script>', audienceCount: 1, actions: [] } }], act);
    expect(document.getElementById('approvals').find('strong')!.textContent).toContain('<script>bad()</script>');
    await document.getElementById('approvals').findText('Approve exactly this')!.emit('click');
    expect(act.mock.calls[0]![2]).toEqual({ approvalId: 'approval-id', decision: 'approved', operationHash: 'f'.repeat(64) });
  });
  it('does not resolve a review after cancel, and keeps the clicked button across async input', async () => {
    const act = vi.fn();
    renderReview([{ id: 'action-id', recipient_norm: 'x', state_reason: '', attempt_count: 1 }], act);
    const button = document.getElementById('review').findText('It went out')!;
    const cancelled = button.emit('click');
    await modal().emit('cancel'); await cancelled;
    expect(act).not.toHaveBeenCalled();
    const submitted = button.emit('click');
    modal().find('input')!.value = 'provider-id';
    await modal().find('form')!.emit('submit'); await submitted;
    expect(act.mock.calls[0]![0]).toBe(button);
    expect(act.mock.calls[0]![2]).toEqual({ actionId: 'action-id', kind: 'sent', providerMessageId: 'provider-id' });
  });
  it('disables actions until completion, refreshes on success, and restores after failure', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ json: async () => ({ stdout: JSON.stringify({ ok: true, data: {} }) }) });
    vi.stubGlobal('fetch', fetch);
    const act = createActions(refresh), button = document.createElement('button');
    const pending = act(button, 'campaign-pause', {}, 'Paused');
    expect(button.disabled).toBe(true); await pending;
    expect(button.disabled).toBe(false); expect(refresh).toHaveBeenCalledOnce();
    fetch.mockRejectedValue(new Error('offline'));
    await act(button, 'campaign-pause', {}, 'Paused');
    expect(button.disabled).toBe(false); expect(refresh).toHaveBeenCalledOnce();
    expect(document.getElementById('toast').textContent).toBe('offline');
  });
});
