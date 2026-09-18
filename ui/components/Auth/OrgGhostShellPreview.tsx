import type { ReactNode } from "react";

const NAV_BAR_WIDTHS = [42, 30, 36, 26];
const CHAT_BAR_WIDTHS = [64, 48, 56, 40, 52];

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "AK";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function skeletonBars(widths: number[]): ReactNode {
  return widths.map((width, index) => (
    <span className="onboarding-gh-row" key={`${width}-${index}`}>
      <i className="onboarding-gh-ic" aria-hidden />
      <i className="onboarding-gh-bar" style={{ width: `${width}%` }} aria-hidden />
    </span>
  ));
}

interface OrgGhostShellPreviewProps {
  userName: string;
  orgName: string;
  teamName: string;
}

export function OrgGhostShellPreview({
  userName,
  orgName,
  teamName,
}: OrgGhostShellPreviewProps) {
  const label = [orgName.trim(), teamName.trim()].filter(Boolean).join(" / ");
  const displayName = userName.trim() || "Your name";
  const initials = initialsFromName(userName);

  return (
    <aside className="onboarding-ghost-shell">
      <div className="onboarding-gh-win">
        <div className="onboarding-gh-side">
          <div className="onboarding-gh-top">
            <i className="onboarding-gh-bar" style={{ width: "52%" }} aria-hidden />
          </div>
          <div className="onboarding-gh-group">{skeletonBars(NAV_BAR_WIDTHS)}</div>
          <div className="onboarding-gh-group onboarding-gh-group--dim">
            {skeletonBars(CHAT_BAR_WIDTHS)}
          </div>
          <div className="onboarding-gh-foot-wrap">
            <div className="onboarding-gh-foot">
              <span className="onboarding-gh-av">{initials}</span>
              <span className="onboarding-gh-id">
                <b>{displayName}</b>
                <em className={label ? "" : "empty"}>
                  {label || "Organization / Team"}
                </em>
              </span>
              <span className="onboarding-gh-more" aria-hidden>
                ···
              </span>
            </div>
          </div>
        </div>
        <div className="onboarding-gh-main" aria-hidden />
      </div>
      <p className="onboarding-gh-cap">
        Your workspace lives here. You can switch or rename it from the same place.
      </p>
    </aside>
  );
}
