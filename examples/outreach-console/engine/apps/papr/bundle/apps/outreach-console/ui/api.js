/* global document, location, URLSearchParams, fetch */
export async function call(action, params = {}) {
  const APP_ID = new URLSearchParams(location.search).get('appId') || document.documentElement.dataset.appId || 'outreach-console';
  const res = await fetch(`/api/app/backend/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, params }),
  });
  const envelope = await res.json().catch(() => ({}));
  let result;
  try {
    result = JSON.parse(envelope.stdout || '{}');
  } catch {
    result = { ok: false, error: 'the backend returned no result' };
  }
  if (!result.ok) throw new Error(result.error || 'request failed');
  return result.data;
}
