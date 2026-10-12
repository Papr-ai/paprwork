/**
 * Copy text to clipboard — Electron main-process clipboard first, then web fallbacks.
 */

export async function copyTextToClipboard(
  text: string,
  options?: { trim?: boolean },
): Promise<boolean> {
  const trim = options?.trim !== false;
  const payload = trim ? text.trim() : text;
  if (!payload) {
    return false;
  }

  try {
    if (window.electronAPI?.system?.invoke) {
      await window.electronAPI.system.invoke("clipboard.writeText", payload);
      return true;
    }
  } catch {
    // Fall through to renderer clipboard APIs.
  }

  try {
    await navigator.clipboard.writeText(payload);
    return true;
  } catch {
    // Fall through to execCommand fallback.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = payload;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

/**
 * Read clipboard text — Electron main-process clipboard first.
 * navigator.clipboard.readText() needs the "clipboard-read" permission, which
 * the main process denies (only sanitized-write is allowed), so the renderer
 * API alone always fails inside Papr Work.
 */
export async function readTextFromClipboard(): Promise<string | null> {
  try {
    if (window.electronAPI?.system?.invoke) {
      const result = (await window.electronAPI.system.invoke("clipboard.readText")) as
        | { text?: string }
        | undefined;
      if (typeof result?.text === "string") {
        return result.text;
      }
    }
  } catch {
    // Fall through to renderer clipboard API.
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
