/**
 * MemorySetupPanel — first-run guidance on the Memory tab
 * Matches WikiLibrary dark Meridian styling; reuses onboarding chat flow.
 */

import React, { useCallback } from "react";
import { useChat } from "../../hooks/useChat";
import { useTabs } from "../../hooks/useTabs";
import {
  openPaprSignInSettings,
  startOnboardingChat,
} from "../../utils/startOnboardingChat";

export type MemorySetupVariant = "sign-in" | "setup" | "wiki-empty";

interface MemorySetupPanelProps {
  variant: MemorySetupVariant;
  onboardingPending?: boolean;
  placeholderFileCount?: number;
  onEditIdentity?: () => void;
}

export function MemorySetupPanel({
  variant,
  onboardingPending = false,
  placeholderFileCount = 0,
  onEditIdentity,
}: MemorySetupPanelProps) {
  const { createChat } = useChat();
  const { createTab, switchToTab } = useTabs();

  const handleTellPapr = useCallback(async () => {
    await startOnboardingChat(createChat, createTab, switchToTab);
  }, [createChat, createTab, switchToTab]);

  const handleSignIn = useCallback(() => {
    openPaprSignInSettings(createTab, switchToTab);
  }, [createTab, switchToTab]);

  if (variant === "sign-in") {
    return (
      <section className="wiki-setup-panel wiki-setup-panel--sign-in" aria-labelledby="memory-setup-title">
        <div className="wiki-setup-panel__icon" aria-hidden>
          ◉
        </div>
        <h2 id="memory-setup-title" className="wiki-setup-panel__title">
          Your personal wiki
        </h2>
        <p className="wiki-setup-panel__body">
          Sign in with Papr to browse goals, projects, people, and memories from your knowledge graph.
        </p>
        <div className="wiki-setup-panel__actions">
          <button type="button" className="wiki-btn wiki-btn--primary" onClick={handleSignIn}>
            Sign in with Papr
          </button>
        </div>
        <p className="wiki-setup-panel__footnote">
          After sign-in, tell Papr about yourself in chat — your wiki and long-term memory refresh overnight during the daily sleep cycle.
        </p>
      </section>
    );
  }

  if (variant === "setup") {
    return (
      <section className="wiki-setup-panel" aria-labelledby="memory-setup-title">
        <div className="wiki-setup-panel__icon" aria-hidden>
          ◉
        </div>
        <h2 id="memory-setup-title" className="wiki-setup-panel__title">
          {onboardingPending ? "Finish setting up your memory" : "Your memory is getting started"}
        </h2>
        <p className="wiki-setup-panel__body">
          {onboardingPending
            ? "Papr is waiting to learn about you. A short chat fills in your profile, preferences, and working context."
            : "Papr learns from conversations and builds a wiki of people, projects, and goals. Start with a quick setup chat or edit your context files directly."}
        </p>
        {placeholderFileCount > 0 ? (
          <p className="wiki-setup-panel__hint">
            {placeholderFileCount} context {placeholderFileCount === 1 ? "file still has" : "files still have"} template placeholders — setup will replace them with your details.
          </p>
        ) : null}
        <div className="wiki-setup-panel__actions">
          <button type="button" className="wiki-btn wiki-btn--primary" onClick={() => { void handleTellPapr(); }}>
            Tell Papr about yourself
          </button>
          {onEditIdentity ? (
            <button type="button" className="wiki-btn wiki-btn--secondary" onClick={onEditIdentity}>
              Edit IDENTITY.md
            </button>
          ) : null}
        </div>
        <p className="wiki-setup-panel__footnote">
          Your wiki and long-term memory update overnight during Papr&apos;s daily sleep cycle — new people, projects, and insights appear here after each night&apos;s refresh.
        </p>
      </section>
    );
  }

  return (
    <section className="wiki-setup-panel wiki-setup-panel--compact" aria-labelledby="memory-setup-title">
      <h2 id="memory-setup-title" className="wiki-setup-panel__title wiki-setup-panel__title--compact">
        Wiki pages will appear here
      </h2>
      <p className="wiki-setup-panel__body">
        Chat with Papr or add memories — they&apos;ll show up as browsable pages. Your knowledge graph refreshes overnight during the daily sleep cycle.
      </p>
      <div className="wiki-setup-panel__actions">
        <button type="button" className="wiki-btn wiki-btn--secondary" onClick={() => { void handleTellPapr(); }}>
          Tell Papr more about you
        </button>
      </div>
    </section>
  );
}
