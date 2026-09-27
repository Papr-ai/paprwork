/**
 * CreateAppModal — "What should this app do?"
 *
 * One big question (name is derived by Pen), starter examples, and two
 * optional nudges that make the first build much better: whether it should
 * run on its own, and what it connects to. Create opens a chat and sends
 * right away — no extra Enter.
 */

import { useEffect, useRef, useState } from "react";
import { openChatWithPrompt } from "../../utils/openChatWithPrompt";
import type { CreateAppStarter } from "../../utils/createAppStarters";
import "./CreateAppModal.css";

interface CreateAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** "Or start from a Team / Community app" link. */
  onBrowse?: () => void;
  /** Examples built from the user's own library (see createAppStarters). */
  starters?: readonly CreateAppStarter[];
}

type Cadence = "off" | "hourly" | "daily" | "weekly";

const FALLBACK_STARTERS: readonly CreateAppStarter[] = [
  { label: "Expense tracker", prompt: "Track my expenses from receipts I upload, categorize them, and show monthly totals." },
  { label: "Lead digest", prompt: "Every morning, collect new leads and send me a short digest of who to follow up with." },
  { label: "Revenue dashboard", prompt: "A dashboard of my revenue: MRR, new vs churned customers, and a trend chart." },
  { label: "Competitor watch", prompt: "Watch a list of competitor websites and tell me when pricing or features change." },
  { label: "Reading list", prompt: "Save articles I paste in, summarize each one, and let me tag and search them." },
];

const CADENCES: ReadonlyArray<{ value: Cadence; label: string }> = [
  { value: "off", label: "Only when I open it" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const CONNECTIONS = [
  "Gmail", "Google Sheets", "Google Calendar", "Slack", "Notion",
  "Stripe", "HubSpot", "GitHub", "LinkedIn", "Web pages",
] as const;

export function buildCreateAppPrompt(input: {
  goal: string;
  cadence: Cadence;
  connections: readonly string[];
}): string {
  const lines = [`Build me a mini-app: ${input.goal.trim()}`];
  if (input.cadence !== "off") {
    lines.push(`It should run on its own ${input.cadence} (set up a scheduled job).`);
  }
  if (input.connections.length) {
    lines.push(
      `It connects to: ${input.connections.join(", ")}. Tell me up front which API keys or sign-ins you'll need.`,
    );
  }
  lines.push("Pick a short, clear name for it. Ask me only if something important is ambiguous; otherwise start building.");
  return lines.join("\n");
}

export function CreateAppModal({ isOpen, onClose, onBrowse, starters }: CreateAppModalProps) {
  const examples = starters?.length ? starters : FALLBACK_STARTERS;
  const [goal, setGoal] = useState("");
  const [cadence, setCadence] = useState<Cadence>("off");
  const [connections, setConnections] = useState<string[]>([]);
  const [showMore, setShowMore] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setGoal("");
    setCadence("off");
    setConnections([]);
    setShowMore(false);
    const t = window.setTimeout(() => goalRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const ready = goal.trim().length >= 8;

  const submit = () => {
    if (!ready) return;
    openChatWithPrompt(buildCreateAppPrompt({ goal, cadence, connections }));
    onClose();
  };

  const toggleConnection = (c: string) =>
    setConnections((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));

  if (!isOpen) return null;

  return (
    <div className="create-app-modal__backdrop" onClick={onClose}>
      <div
        className="create-app-modal create-app-modal--guided"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-app-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="create-app-title" className="create-app-modal__title">
          What should this app do?
        </h3>
        <p className="create-app-modal__subtitle">
          Describe it in a sentence or two. Pen will name it and start building.
        </p>

        <textarea
          ref={goalRef}
          className="create-app-modal__textarea create-app-modal__goal"
          placeholder="e.g. Every Monday, pull last week's Stripe payments and show revenue by plan"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={4}
        />

        {goal.trim() ? null : (
          <div className="create-app-modal__starters" aria-label="Examples">
            {examples.map((s) => (
              <button
                key={s.label}
                type="button"
                className="create-app-modal__chip"
                onClick={() => {
                  setGoal(s.prompt);
                  // "Like <app>, but for " ends open: put the cursor at the end.
                  window.setTimeout(() => {
                    const el = goalRef.current;
                    if (!el) return;
                    el.focus();
                    el.setSelectionRange(el.value.length, el.value.length);
                  }, 0);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {showMore ? (
          <div className="create-app-modal__more">
            <div className="create-app-modal__group">
              <span className="create-app-modal__group-label">Should it run on its own?</span>
              <div className="create-app-modal__seg" role="radiogroup">
                {CADENCES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={cadence === c.value}
                    className={cadence === c.value ? "is-on" : undefined}
                    onClick={() => setCadence(c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="create-app-modal__group">
              <span className="create-app-modal__group-label">Does it connect to anything?</span>
              <div className="create-app-modal__starters">
                {CONNECTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={connections.includes(c)}
                    className={`create-app-modal__chip${connections.includes(c) ? " is-on" : ""}`}
                    onClick={() => toggleConnection(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <button type="button" className="create-app-modal__link" onClick={() => setShowMore(true)}>
            + Schedule and connections (optional)
          </button>
        )}

        <div className="create-app-modal__actions">
          {onBrowse ? (
            <button
              type="button"
              className="create-app-modal__link create-app-modal__browse"
              onClick={() => {
                onClose();
                onBrowse();
              }}
            >
              Or start from a Team or Community app →
            </button>
          ) : null}
          <button type="button" className="create-app-modal__cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="create-app-modal__submit"
            onClick={submit}
            disabled={!ready}
            title={ready ? "Opens a chat and starts building (⌘↵)" : "Describe what it should do"}
          >
            Create app
          </button>
        </div>
      </div>
    </div>
  );
}
