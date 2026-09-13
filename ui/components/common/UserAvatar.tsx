import React, { useEffect, useState } from "react";
import { getProfileInitials } from "../../utils/profileInitials";

export interface UserAvatarProps {
  imageUrl?: string | null;
  displayName?: string;
  email?: string;
  alt?: string;
  /** Class for the profile photo when loaded. */
  className?: string;
  /** Class for the initials fallback (defaults to className). */
  initialsClassName?: string;
  /** Shown when there is no image and initials cannot be derived. */
  fallback?: React.ReactNode;
}

export function UserAvatar({
  imageUrl,
  displayName,
  email,
  alt = "",
  className,
  initialsClassName,
  fallback = null,
}: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const url = imageUrl?.trim() ?? "";
  const showImage = url.length > 0 && !imageFailed;

  useEffect(() => {
    setImageFailed(false);
  }, [url]);

  const initials = getProfileInitials(displayName, email);
  const initialsClass = initialsClassName ?? className;

  if (showImage) {
    return (
      <img
        src={url}
        alt={alt || displayName || "Profile"}
        className={className}
        onError={() => setImageFailed(true)}
      />
    );
  }

  if (initials) {
    return (
      <span className={initialsClass} aria-hidden={alt.length === 0}>
        {initials}
      </span>
    );
  }

  return <>{fallback}</>;
}
