/**
 * Mini-app browser API policy — shared by desktop gateway and Cloud App Host.
 */

export const MINI_APP_BASH_DISABLED_MESSAGE =
  "Mini-apps cannot call /api/bash/run. Use POST /api/app/backend/:action for app backend handlers, " +
  "POST /api/jobs/run for sandbox/agent jobs, or /api/db/* for linked database access. " +
  "For publishable API keys, use POST /api/credentials/client-keys then fetch(thirdPartyUrl) from the frontend — never bash/run.";

export const MINI_APP_BASH_DISABLED_CODE = "mini_app_bash_disabled";
