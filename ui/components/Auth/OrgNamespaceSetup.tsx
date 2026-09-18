/**
 * OrgNamespaceSetup - First-time org/namespace naming after Papr sign-in.
 * Visual language matches the onboarding redesign prototype (ghost shell preview).
 */

import React, { useEffect, useRef, useState } from "react";
import type { PaprLoginSource } from "../../../src/core/telemetry/paprLoginSteps";
import { trackPaprLoginStep } from "../../lib/paprLoginTelemetry";
import { AuthProgressDots } from "./AuthProgressDots";
import { OrgGhostShellPreview } from "./OrgGhostShellPreview";
import "./onboardingTheme.css";
import "./OrgNamespaceSetup.css";

const SETUP_LOADING_MESSAGES = [
  "We're creating your organization...",
  "We're creating your team's space...",
  "We're getting things ready...",
] as const;

export interface OrgNamespaceSetupRequest {
  orgName: string;
  namespaceName: string;
  needsOrg: boolean;
  needsNamespace: boolean;
}

interface OrgNamespaceSetupProps {
  request: OrgNamespaceSetupRequest;
  onComplete: () => void;
  source?: PaprLoginSource;
}

export function OrgNamespaceSetup({
  request,
  onComplete,
  source = "unknown",
}: OrgNamespaceSetupProps) {
  const [userDisplayName, setUserDisplayName] = useState("");
  const [orgName, setOrgName] = useState(request.orgName);
  const [namespaceName, setNamespaceName] = useState(request.namespaceName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const setupViewedTracked = useRef(false);
  const submitStartedAt = useRef<number | null>(null);

  useEffect(() => {
    void window.electronAPI.papr
      .getProfile()
      .then((result) => {
        const name = result?.profile?.displayName?.trim();
        if (name) {
          setUserDisplayName(name);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (setupViewedTracked.current) {
      return;
    }
    setupViewedTracked.current = true;
    trackPaprLoginStep("org_setup_viewed", {
      source,
      needs_org: request.needsOrg,
      needs_namespace: request.needsNamespace,
    });
  }, [request.needsNamespace, request.needsOrg, source]);

  useEffect(() => {
    if (!isSubmitting) {
      setLoadingMessageIndex(0);
      return;
    }

    const interval = window.setInterval(() => {
      setLoadingMessageIndex((current) => (current + 1) % SETUP_LOADING_MESSAGES.length);
    }, 2800);

    return () => window.clearInterval(interval);
  }, [isSubmitting]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    setIsSubmitting(true);
    setError(null);
    submitStartedAt.current = Date.now();
    trackPaprLoginStep("org_setup_submitted", {
      source,
      needs_org: request.needsOrg,
      needs_namespace: request.needsNamespace,
    });

    try {
      const result = await window.electronAPI.papr.completeOrgSetup({
        orgName: orgName.trim(),
        namespaceName: namespaceName.trim(),
      });

      if (!result.success) {
        const message = result.error || "Could not finish setup";
        trackPaprLoginStep("org_setup_failed", {
          source,
          needs_org: request.needsOrg,
          needs_namespace: request.needsNamespace,
          stage: "form",
          error: message,
          ...(submitStartedAt.current
            ? { duration_ms: Date.now() - submitStartedAt.current }
            : {}),
        });
        setError(message);
        return;
      }

      onComplete();
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : "Could not finish setup";
      trackPaprLoginStep("org_setup_failed", {
        source,
        needs_org: request.needsOrg,
        needs_namespace: request.needsNamespace,
        stage: "form",
        error: message,
        ...(submitStartedAt.current
          ? { duration_ms: Date.now() - submitStartedAt.current }
          : {}),
      });
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canSubmit =
    (!request.needsOrg || orgName.trim().length > 0) &&
    (!request.needsNamespace || namespaceName.trim().length > 0);

  const formBody = isSubmitting ? (
    <>
      <div className="onboarding-spinner" />
      <h1 className="onboarding-h1 onboarding-h1--small">Setting up your workspace</h1>
      <p className="onboarding-lede org-namespace-setup__loading-message">
        {SETUP_LOADING_MESSAGES[loadingMessageIndex]}
      </p>
    </>
  ) : (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <h1 className="onboarding-h1 onboarding-h1--small">Set up your workspace</h1>
      <p className="onboarding-lede">
        We filled in what we could from your account. Change anything that looks wrong.
      </p>

      {error && (
        <div className="onboarding-alert" role="alert">
          <strong>Setup issue</strong>
          <p>{error}</p>
        </div>
      )}

      <label className="onboarding-fld">
        <span>Your name</span>
        <input
          type="text"
          className="onboarding-fld-in"
          value={userDisplayName}
          onChange={(event) => setUserDisplayName(event.target.value)}
          placeholder="Amir Kabbara"
          autoComplete="name"
        />
      </label>

      {request.needsOrg && (
        <label className="onboarding-fld">
          <span>Organization</span>
          <input
            type="text"
            className="onboarding-fld-in"
            value={orgName}
            onChange={(event) => setOrgName(event.target.value)}
            placeholder="Acme Inc"
            autoComplete="organization"
            required
            maxLength={64}
          />
        </label>
      )}

      {request.needsNamespace && (
        <label className="onboarding-fld">
          <span>Team</span>
          <input
            type="text"
            className="onboarding-fld-in"
            value={namespaceName}
            onChange={(event) => setNamespaceName(event.target.value)}
            placeholder="Go-to-market"
            autoComplete="off"
            required
            maxLength={64}
          />
          <em>Teams usually map to a function — sales, marketing, ops.</em>
        </label>
      )}

      <button
        type="submit"
        className="onboarding-cta onboarding-cta--wide"
        disabled={!canSubmit}
      >
        Create workspace
      </button>

      <p className="onboarding-auth-alt org-namespace-setup__terms">
        You can rename these later from Papr settings.
      </p>
    </form>
  );

  return (
    <div className="onboarding-flow onboarding-split onboarding-split--org org-namespace-setup">
      <section className="onboarding-split-r">
        <div className="onboarding-split-form">
          <AuthProgressDots activeIndex={1} />
          {formBody}
        </div>
      </section>
      <OrgGhostShellPreview
        userName={userDisplayName}
        orgName={orgName}
        teamName={namespaceName}
      />
    </div>
  );
}
