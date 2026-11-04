/**
 * A person in chat is a pill: photo (or initials) + name, never plain "@name" text.
 * linkMentions turns "@Name" into a markdown link with a #mention: href (fragments survive
 * react-markdown's URL filter); Markdown renders those links as <MentionPill>.
 * Full teammate names ("@Shawkat Kabbara") match first, then any single @token. Emails and code are left alone.
 */
import { cachedTeammates, loadTeammates } from "../Chat/MentionMenu";
import { findTeammate } from "../Chat/mentionText";
import { UserAvatar } from "./UserAvatar";
import "./mentionPill.css";

// Full names ("@Shawkat Kabbara") need the team list; load it once, early.
void loadTeammates().catch(() => undefined);

export const MENTION_HREF = "#mention:";
const initials = (n: string) => n.replace(/[@+].*$/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "@";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const link = (name: string) => `[@${name.replace(/[[\]]/g, "")}](${MENTION_HREF}${encodeURIComponent(name)})`;

export function linkMentions(text: string, names: string[] = cachedTeammates().map((m) => m.displayName)): string {
  if (!text.includes("@")) return text;
  const full = [...new Set(names.filter((n) => n && /\s/.test(n)))].sort((a, b) => b.length - a.length);
  const fullRe = full.length ? new RegExp(`(^|[\\s(*_])@(${full.map(escRe).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
  let fence = false;
  return text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    // Leave inline code alone: only touch the parts between backticks.
    return line.split(/(`[^`]*`)/).map((part) => {
      if (part.startsWith("`")) return part;
      let out = fullRe ? part.replace(fullRe, (_, pre: string, n: string) => pre + link(n)) : part;
      out = out.replace(/(^|[\s(*_])@([\p{L}\p{N}][\p{L}\p{N}._+-]*[\p{L}\p{N}+])(?![\]\p{L}\p{N}@])/gu, (_, pre: string, n: string) => pre + link(n));
      return out;
    }).join("");
  }).join("\n");
}

export function MentionPill({ name }: { name: string }) {
  const m = findTeammate(name, cachedTeammates());
  return (
    <span className="mention-pill" title={m?.email ? `${name} · ${m.email}` : name}>
      {m?.imageUrl
        ? <UserAvatar imageUrl={m.imageUrl} displayName={m.displayName} email={m.email} size={18} className="mention-pill__av" />
        : <i aria-hidden="true">{initials(name)}</i>}
      {name}
    </span>
  );
}
