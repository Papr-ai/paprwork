/** Hand off to the desktop app: papr://chat/open drafts the message in a new chat (index.cjs). */
export function openInDesktop(message: string): void {
  window.location.href = `papr://chat/open?message=${encodeURIComponent(message)}`;
}
