/**
 * Single source of truth for multi-user / shared-DB access design.
 *
 * Injected into:
 *   1. product-architect system prompt (required "Access & Row ACL" output section)
 *   2. PRODUCT_ARCHITECT_IMPLEMENTATION_CONTRACTS_SECTION (builder checklist)
 * Long form: src/resources/agent-docs/PRODUCT_ARCHITECT_GUIDE.md § Multi-user access & row ACL.
 * Runtime contracts: GET /api/access (MiniAppAccessResponse), GET /api/members (MiniAppMembersResponse),
 * server-injected PAPR_CALLER_USER_ID in backend actions / jobs.
 */

/** When the architect must produce the access section. */
export const MULTI_USER_ACL_TRIGGER =
  "Applies when the app is published to more than one person (team, link, public) AND uses a shared (non per-user) registry DB. " +
  "Single-user desktop apps: write \"single-user, no row ACL\" and skip.";

export const MULTI_USER_ACL_RULES = [
  "Pick isolation explicitly: per-user DB (create_database isolation: \"per-user\") when rows are never shared; shared DB + row ACL when users collaborate or an admin must see everything.",
  "Every user-facing table in a shared DB gets ACL columns: owner_user_id TEXT (Papr userId), visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team','public')), created_at. Index (owner_user_id) and (visibility).",
  "Row-level sharing beyond owner/visibility: a row_acl table (table_name, row_id, principal_user_id, permission 'read'|'write', PRIMARY KEY(table_name,row_id,principal_user_id)) — not comma-separated lists in a column.",
  "Roles: app_roles table (papr_user_id TEXT PRIMARY KEY, role 'admin'|'editor'|'viewer', granted_by, granted_at). Seed the owner as admin in the migration with '{{papr.owner_user_id}}' — never a hard-coded id.",
  "Identity: GET /api/access at startup → { loggedIn, isOwner, userId, email, mode }. Use userId for filters; isOwner (or app_roles admin) gates admin UI — hide admin tabs entirely for everyone else.",
  "Role assignment UI: GET /api/members → workspace roster keyed by userId. Admin picks members from that list (never free-text email); flag app_roles rows whose userId is no longer a member.",
  "Enforcement lives on the server: /api/db/query does NOT enforce row ACL. Private/team rows and all writes to ACL columns go through POST /api/app/backend/:action using PAPR_CALLER_USER_ID — never a client-supplied userId/role param.",
  "Canonical read filter (backend): WHERE visibility='public' OR (visibility='team' AND :caller_is_member) OR owner_user_id=:caller OR id IN (SELECT row_id FROM row_acl WHERE table_name=? AND principal_user_id=:caller) — admins skip the filter.",
  "Only public/aggregate data may be read directly from the browser via /api/db/query (e.g. app_stats). Anonymous funnels with no sign-in use owner_session instead, and are UX isolation only.",
  "Publish access ≠ row ACL: publish_cloud_app loginAccess decides who can open the app; the ACL tables decide which rows each person sees.",
] as const;

/** Architect output section template. */
export const MULTI_USER_ACL_SECTION =
  "## Access & Row ACL (REQUIRED — multi-user / shared DB)\n" +
  `${MULTI_USER_ACL_TRIGGER}\n` +
  "Output: isolation choice + why; roles matrix (role → can read / can write / admin-only pages); ACL columns per table; " +
  "which backend actions enforce ACL (with PAPR_CALLER_USER_ID); which reads are safe from the browser; " +
  "how admins are bootstrapped (owner seed) and assigned (/api/members picker); publish loginAccess.\n" +
  MULTI_USER_ACL_RULES.map((r) => `- ${r}`).join("\n");

/** One-line builder contract. */
export const MULTI_USER_ACL_CONTRACT =
  "- Multi-user shared DB: ACL columns (owner_user_id, visibility) + app_roles/row_acl tables per architect plan; GET /api/access for identity + isOwner admin gating; GET /api/members for role pickers; " +
  "private/team reads and ACL writes ONLY via backend actions using PAPR_CALLER_USER_ID (/api/db/query does not enforce ACL); seed owner admin with '{{papr.owner_user_id}}'\n";
