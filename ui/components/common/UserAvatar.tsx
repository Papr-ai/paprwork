import React, { useEffect, useState } from "react";
import { getProfileInitials } from "../../utils/profileInitials";
import "./UserAvatar.css";

export interface UserAvatarProps {
  imageUrl?: string | null;
  displayName?: string;
  email?: string;
  /** Diameter in px. The circle is enforced here, not by the caller. */
  size?: number;
  alt?: string;
  /** Extra classes on the frame. */
  className?: string;
  /** Hairline ring — for avatars sitting on a photo or coloured fill. */
  ring?: boolean;
  /** Hover affordance — only when the avatar is itself the click target. */
  interactive?: boolean;
  /** Replaces the built-in person glyph when there is no image and no initials. */
  fallback?: React.ReactNode;
}

/** Person glyph. Lives here so call sites stop pasting their own copy. */
function PersonGlyph() {
  return (
    <svg
      className="papr-avatar__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The one avatar. Renders a perfect circle containing — in order of
 * preference — the profile photo, the person's initials, or a person glyph.
 */
export function UserAvatar({
  imageUrl,
  displayName,
  email,
  size = 32,
  alt = "",
  className,
  ring = false,
  interactive = false,
  fallback,
}: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const url = imageUrl?.trim() ?? "";
  const showImage = url.length > 0 && !imageFailed;

  // A new URL deserves a fresh attempt; without this a single 404 would
  // permanently pin the avatar to initials for the rest of the session.
  useEffect(() => {
    setImageFailed(false);
  }, [url]);

  const initials = getProfileInitials(displayName, email);
  const label = alt || displayName || email || "";

  const frameClass = [
    "papr-avatar",
    ring ? "papr-avatar--ring" : "",
    interactive ? "papr-avatar--interactive" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  let content: React.ReactNode;
  if (showImage) {
    content = (
      <img
        src={url}
        alt={label || "Profile"}
        className="papr-avatar__img"
        onError={() => setImageFailed(true)}
        draggable={false}
      />
    );
  } else if (initials) {
    content = <span className="papr-avatar__initials">{initials}</span>;
  } else {
    content = fallback ?? <PersonGlyph />;
  }

  return (
    <span
      className={frameClass}
      style={{ "--papr-avatar-size": `${size}px` } as React.CSSProperties}
      // Decorative when the name is already rendered beside it; labelled when
      // the avatar is the only identity cue.
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {content}
    </span>
  );
}
