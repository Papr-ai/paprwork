# Notifications, Stage 2: sources, settings, one dot color

Spec for the Stage 2 PRs. The prototype is the *Papr Notifications UX* mini-app (Walkthrough + Plan tabs).
Stage 1 (#708, #711) shipped the notices table, route(), desktop notifications and a first Settings page.

## Model

- **Level** is set by the sender from facts and capped by Papr: Status, FYI, Priority, Urgent.
  Apps, jobs and agents top out at Priority. Only Papr (platform, billing) sends Urgent.
- **Source** is the Settings row a notice belongs to. Decided by `sourceOf()` from the notice, never picked by the sender.
- **Type** is the chip inside a source (`typeOf()`), e.g. `chats/chat.done`, `apps/proposal.review`.
- **Category**: FYI is *Done* (green dot); Priority and Urgent are *Waiting on you* (solid blue dot).

## Sources (Papr Work)

| Source | Waiting on you | Done |
|---|---|---|
| Chats | Pen needs a key, something set up in a chat is waiting | Finished replies |
| App management | An app's job is waiting, proposals to review | Your proposal was accepted or declined |
| Account & team | A teammate asked to connect an account | Connection request updates |
| App updates | New version ready to install | |
| Focus & goals | *(with the Focus PR)* morning plan, check-ins (Focus only), back on track | progress, weekly review |

Each mini-app that sends notifications gets its own row (`app:{appId}`). Only the app's own
`notification.show` reaches you (`forYou`); anything else from an app stays inside it.

## Settings

Per source: **Allow**, and for each category **where it appears**: Desktop, Badges (Banner and Focus
columns arrive with Pen's banner and Focus's Needs-you list). Per type: a chip to turn it off.

- Defaults: Waiting → Desktop + Badges. Done → Badges. Chats › Done also → Desktop (finished replies pop while you're away).
- Stored sparse (`version: 2`): only what differs from the default, so better defaults reach everyone. Reset deletes the row.
- Stage 1 settings carry over once: `priorityOs:false` → Waiting › Desktop off everywhere; `chatDoneOs:false` → Chats › Done › Desktop off;
  `apps.X:"off"` → `app:X` not allowed.
- Settings are applied **after** the facts and only take things away (no desktop, no dot, kept inside). They never raise a level.
- **Urgent is Always on**: no setting touches it. Check-ins are Focus only: never a desktop notification, whatever the table says.

## Dots

Green = done or an unread reply. Solid blue = waiting on you. Gray everywhere while offline. No amber, no red.
Old rows stored as amber/red read back as blue.

## Rules carried into later PRs in this stage

- **One root cause, one notice.** Offline is one ambient notice (gray dots; Pen's hover card says why).
  A connector signing out raises `conn.expired` once from the shared connection layer, for any connector.
  A run that failed because a tool call came back unauthorized links to it; route shows one notice on the
  failure with *Reconnect*, hides the account one while anything depends on it, and reconnecting clears both.
- Focus "Needs you" + a small blue count on Pen + the "…" menu (Mute 1 hour / Turn off this type / Settings).
- Pen leans out for Urgent; replaces PaprQuotaBanner and the avatar dot. Credits out gets Papr copy, not the raw 402.

## Open

- *Block 1 hour* on Back on track: decide with the Focus & goals PR. Leaning: "Focus for 1 hour" = timed Do Not Disturb.
