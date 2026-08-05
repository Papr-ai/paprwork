/**
 * OrgNamespaceSetup - First-time org/namespace naming after Papr sign-in.
 * Uses the same split-screen layout as AuthWall.
 */

import React, { useEffect, useRef, useState } from "react";
import type { PaprLoginSource } from "../../../src/core/telemetry/paprLoginSteps";
import { trackPaprLoginStep } from "../../lib/paprLoginTelemetry";
import "./OrgNamespaceSetup.css";
import "../Auth/AuthWall.css";

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
  const [orgName, setOrgName] = useState(request.orgName);
  const [namespaceName, setNamespaceName] = useState(request.namespaceName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const setupViewedTracked = useRef(false);
  const submitStartedAt = useRef<number | null>(null);

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

  return (
    <div className="auth-wall auth-wall--split org-namespace-setup">
      <div className="auth-wall-left">
        {isSubmitting ? (
          <div
            className="auth-wall-form org-namespace-setup__form org-namespace-setup__loading"
            aria-live="polite"
            aria-busy="true"
          >
            <h1 className="auth-wall-title org-namespace-setup__loading-title">
              Setting up your workspace
            </h1>
            <div className="org-namespace-setup__loading-body">
              <div className="auth-wall-spinner org-namespace-setup__spinner" />
              <p className="org-namespace-setup__loading-message">
                {SETUP_LOADING_MESSAGES[loadingMessageIndex]}
              </p>
            </div>
          </div>
        ) : (
          <form className="auth-wall-form org-namespace-setup__form" onSubmit={(e) => void handleSubmit(e)}>
            <h1 className="auth-wall-title org-namespace-setup__title">Set up your workspace</h1>
            <p className="auth-wall-subtitle org-namespace-setup__subtitle">
              Name your organization and first namespace to finish signing in.
            </p>

            {error && (
              <div className="auth-wall-error" role="alert">
                <strong>Setup issue</strong>
                <p>{error}</p>
              </div>
            )}

            <div className="org-namespace-setup__fields">
              {request.needsOrg && (
                <label className="org-namespace-setup__field">
                  <span className="org-namespace-setup__label">
                    Organization name{" "}
                    <span className="org-namespace-setup__label-hint">Required</span>
                  </span>
                  <input
                    type="text"
                    className="org-namespace-setup__input"
                    value={orgName}
                    onChange={(event) => setOrgName(event.target.value)}
                    placeholder="Acme"
                    autoComplete="organization"
                    required
                    maxLength={64}
                  />
                </label>
              )}

              {request.needsNamespace && (
                <label className="org-namespace-setup__field">
                  <span className="org-namespace-setup__label">
                    Namespace name{" "}
                    <span className="org-namespace-setup__label-hint">Required</span>
                  </span>
                  <input
                    type="text"
                    className="org-namespace-setup__input"
                    value={namespaceName}
                    onChange={(event) => setNamespaceName(event.target.value)}
                    placeholder="GTM Team"
                    autoComplete="off"
                    required
                    maxLength={64}
                  />
                </label>
              )}
            </div>

            <button
              type="submit"
              className="auth-wall-login-button org-namespace-setup__submit"
              disabled={isSubmitting}
            >
              Continue
            </button>

            <p className="auth-wall-terms org-namespace-setup__terms">
              You can rename these later from Papr settings.
            </p>
          </form>
        )}
      </div>

      <div className="auth-wall-right">
        <div className="auth-wall-branding">
          <div className="auth-wall-papr-logo">
            <img
              src="/images/papr-logo.svg"
              alt="Papr Logo"
              className="auth-wall-logo-icon"
            />
            <img
              src="/images/papr typefont.svg"
              alt="Papr"
              className="auth-wall-logo-text"
            />
          </div>

          <div className="auth-wall-fold">
            <svg viewBox="0 0 300 270" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M300 262C300 266.418 296.418 270 292 270L54.5454 270L300 0L300 262Z"
                fill="#0080FF"
              />
              <path
                opacity="0.04"
                fillRule="evenodd"
                clipRule="evenodd"
                d="M54.5454 40.5L54.5454 67.5L300 3.05176e-05L54.5454 40.5Z"
                fill="#212721"
              />
              <path
                opacity="0.48"
                fillRule="evenodd"
                clipRule="evenodd"
                d="M54.5455 270L0 81L300 0L54.5455 270Z"
                fill="#0080FF"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
