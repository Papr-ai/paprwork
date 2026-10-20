"""Release gate: every change in a release PR must be verified on dev (or have a logged exception).

Evidence is a PR comment posted by Release Desk:
  **Verified on dev** ...        (recorded with Mark verified)
  **Break-glass exception** ...  (recorded when releasing anyway)
PRs merged before AUDIT_START, bot PRs and branch syncs are listed but not required.
"""
import json, os, subprocess, sys, urllib.request

TOKEN, REPO = os.environ['GH_TOKEN'], os.environ['REPO']
BASE, HEAD = os.environ['BASE_SHA'], os.environ['HEAD_SHA']
START = os.environ.get('AUDIT_START', '2026-10-19')
MARKS = ('**Verified on dev**', '**Break-glass exception**')
SYNC = ('main', 'master', 'development')


def api(path):
    out, url = [], f'https://api.github.com/repos/{REPO}/{path}'
    while url:
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}', 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req) as r:
            data, link = json.load(r), r.headers.get('Link', '')
        out += data
        url = next((p.split(';')[0].strip(' <>') for p in link.split(',') if 'rel="next"' in p), None)
    return out


shas = subprocess.run(['git', 'log', '--format=%H', f'{BASE}..{HEAD}'], capture_output=True, text=True, check=True).stdout.split()
prs = {}
for sha in shas:
    for p in api(f'commits/{sha}/pulls?per_page=100'):
        if p.get('merged_at') and p['base']['ref'] == 'development':
            prs[p['number']] = p

rows, missing = [], []
for n, p in sorted(prs.items()):
    who, head = p['user']['login'], p['head']['ref']
    if p['merged_at'][:10] < START:
        status = 'before audit start'
    elif who.endswith('[bot]') or head in SYNC:
        status = 'not required (bot or branch sync)'
    else:
        bodies = [c['body'] or '' for c in api(f'issues/{n}/comments?per_page=100')]
        hit = next((m for b in bodies for m in MARKS if b.startswith(m)), None)
        status = {'**Verified on dev**': 'verified on dev', '**Break-glass exception**': 'exception logged'}.get(hit, 'MISSING')
        if not hit:
            missing.append(n)
    rows.append(f"| #{n} | {p['title'][:70].replace('|', '/')} | {who} | {status} |")

summary = ['## Release gate', f'{len(prs)} changes in this release, {len(missing)} missing dev verification.', '',
           '| PR | Title | Author | Status |', '|---|---|---|---|', *rows]
with open(os.environ.get('GITHUB_STEP_SUMMARY', '/dev/null'), 'a') as f:
    f.write('\n'.join(summary) + '\n')
print('\n'.join(summary))
if missing:
    print(f"::error::Not verified on dev: {', '.join('#' + str(n) for n in missing)}. Mark them verified in Release Desk "
          "(or release anyway with an exception), then re-run this check.")
    sys.exit(1)
