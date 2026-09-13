/**
 * Display initials for profile avatars when no photo is available or the image fails to load.
 */
export function getProfileInitials(
  displayName?: string,
  email?: string,
): string {
  const name = displayName?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0]?.[0] ?? "";
      const last = parts[parts.length - 1]?.[0] ?? "";
      const combined = (first + last).toUpperCase();
      if (combined) {
        return combined;
      }
    }
    if (parts.length === 1 && parts[0]) {
      return parts[0].charAt(0).toUpperCase();
    }
  }

  const mail = email?.trim();
  if (mail) {
    return mail.charAt(0).toUpperCase();
  }

  return "";
}
