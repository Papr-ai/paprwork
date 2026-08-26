/**
 * Agent-facing mini-app SDK catalog — built from sdk-manifest discovery.
 */

import {
  getPrimaryMiniAppSdkModule,
  MINI_APP_SDK_MANIFEST_PATH,
  PAPR_SDK_ENTRY_ROUTE,
} from "../../resources/mini-app-sdk/sdk-manifest.js";

export function buildMiniAppSdkCatalogSection(): string {
  const primary = getPrimaryMiniAppSdkModule();

  return `## Mini-app platform SDK

**One import — platform handles iframe vs top-level internally. Apps never branch on embed context.**

\`\`\`typescript
import { papr } from '${PAPR_SDK_ENTRY_ROUTE}';

const name = await papr.dialog.text('Function name', 'placeholder');
if (!name) return;

if (!await papr.dialog.confirm('Remove this item?', 'Remove')) return;

await papr.dialog.alert('Saved');

papr.jobs.subscribe({
  jobIds: [JOB_ID],
  onDbChanged: () => loadData(),
});

await papr.files.upload(file, { onProgress: (p) => updateBar(p) });
\`\`\`

| Need | API |
|---|---|
| Text input | \`papr.dialog.text(...)\` / \`askText\` |
| Yes/no confirm | \`papr.dialog.confirm(...)\` / \`askConfirm\` |
| Blocking OK message | \`papr.dialog.alert(...)\` / \`showAlert\` |
| Tooltip, hover popover, toast | **No SDK** — build in-app HTML/CSS |
| Live job/dashboard refresh | \`papr.jobs.subscribe(...)\` |
| Pause pollers when preview hidden | \`papr.preview.onLifecycle(...)\` |
| Large uploads | \`papr.files.upload/list/url/remove\` |

**Do NOT curl, fetch, or guess \`/__papr__/...\` URLs** — there is no \`papr-tooltip\`, \`papr-popover\`, or \`papr-ui\`. Runtime URLs are bundles for **imports**, not docs.

**Inspect source (once):** \`read_file\` on \`src/resources/mini-app-sdk/papr-sdk.ts\` or \`${MINI_APP_SDK_MANIFEST_PATH}\` for the auto-discovered module list.

Legacy direct imports (\`/__papr__/papr-dialog.ts\`, \`papr-job-events.ts\`, etc.) still work. Prefer \`${primary.route}\` for new code.

Legacy \`window.prompt\` / \`confirm\` / \`alert\` in iframes are auto-shimmed by platform injection.`;
}
