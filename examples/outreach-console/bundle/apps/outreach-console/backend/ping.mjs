// Startup-only health check. No credentials, configuration, database or network access.
console.log(JSON.stringify({ ok: true, data: { status: 'ready' } }));
