/**
 * Post-install notice for optional cross-app dependencies.
 */

import type { CloudAppDependenciesFile } from "../../src/core/types/cloudAppDependencies";
import "./CommunityAppsView.css";

interface CloudInstallOptionalDepsNoticeProps {
  appTitle: string;
  dependencies: CloudAppDependenciesFile;
  onClose: () => void;
  onOpenCommunityApps: () => void;
  onContinue: () => void;
}

export function CloudInstallOptionalDepsNotice({
  appTitle,
  dependencies,
  onClose,
  onOpenCommunityApps,
  onContinue,
}: CloudInstallOptionalDepsNoticeProps) {
  const optionalApps = dependencies.apps.filter((dep) => !dep.required);
  const optionalDbs = dependencies.databases.filter((dep) => !dep.required);

  if (optionalApps.length === 0 && optionalDbs.length === 0) {
    return null;
  }

  return (
    <div
      className="community-install-modal__backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="community-install-modal community-install-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-optional-deps-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="cloud-optional-deps-title" className="community-install-modal__title">
          {appTitle} is ready
        </h3>
        <p className="community-install-modal__desc">
          Core features are installed. Some capabilities need other apps — install
          each one separately from Community Apps when you need them.
        </p>
        <ul className="community-install-modal__dep-list">
          {optionalApps.map((dep) => {
            const label = dep.title ?? dep.slug ?? dep.appId;
            const enables =
              dep.enables && dep.enables.length > 0
                ? dep.enables.join(", ")
                : "additional features";
            return (
              <li key={dep.appId}>
                <strong>{label}</strong>
                <span> — {enables}</span>
              </li>
            );
          })}
          {optionalDbs.map((dbDep) => (
            <li key={dbDep.dbId}>
              <strong>{dbDep.alias ?? dbDep.dbId}</strong>
              <span>
                {" "}
                — from{" "}
                {dbDep.ownerTitle ?? dbDep.ownerSlug ?? dbDep.ownerAppId}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="community-install-modal__option"
          onClick={onOpenCommunityApps}
        >
          <strong>Browse Community Apps</strong>
          <span>Find and install linked apps separately.</span>
        </button>
        <button
          type="button"
          className="community-install-modal__primary"
          onClick={onContinue}
        >
          Open {appTitle}
        </button>
        <button
          type="button"
          className="community-install-modal__cancel"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
