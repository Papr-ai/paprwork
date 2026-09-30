/**
 * In-app text input and confirm dialogs for mini-apps.
 *
 * window.prompt(), window.confirm(), and window.alert() silently fail inside
 * Paprwork iframes (cross-origin embed) and in sandboxed previews — prompt
 * returns null, confirm returns false, with no UI shown.
 *
 * Import from the unified SDK (preferred):
 *   import { papr } from '/__papr__/papr-sdk.ts';
 *   await papr.dialog.text('...');
 *
 * Or legacy direct import:
 *   import { askText, askConfirm } from '/__papr__/papr-dialog.ts';
 */

const STYLE_ID = "papr-dialog-styles";

const DIALOG_STYLES = `
  .papr-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(15, 23, 42, 0.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-family: "SF UI Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .papr-dialog-card {
    width: min(420px, 100%);
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
    padding: 20px 20px 16px;
    color: #111827;
  }
  .papr-dialog-title {
    margin: 0 0 12px;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.35;
  }
  .papr-dialog-body {
    margin: 0 0 16px;
    font-size: 14px;
    line-height: 1.5;
    color: #475467;
    white-space: pre-wrap;
  }
  .papr-dialog-field {
    display: block;
    margin: 0 0 16px;
  }
  .papr-dialog-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d0d5dd;
    border-radius: 10px;
    padding: 10px 12px;
    font: inherit;
    font-size: 14px;
    color: #111827;
    background: #fff;
  }
  .papr-dialog-input:focus {
    outline: 2px solid rgba(0, 128, 255, 0.25);
    border-color: #0080ff;
  }
  .papr-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .papr-dialog-btn {
    border: none;
    border-radius: 10px;
    padding: 9px 14px;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  .papr-dialog-btn--ghost {
    background: #f2f4f7;
    color: #344054;
  }
  .papr-dialog-btn--primary {
    background: #0080ff;
    color: #fff;
  }
  .papr-dialog-btn--danger {
    background: #d92d20;
    color: #fff;
  }
  @media (prefers-color-scheme: dark) {
    .papr-dialog-card {
      background: #1c1c1e;
      color: #f5f5f7;
    }
    .papr-dialog-body { color: #a1a1aa; }
    .papr-dialog-input {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.12);
      color: #f5f5f7;
    }
    .papr-dialog-btn--ghost {
      background: rgba(255,255,255,0.08);
      color: #f5f5f7;
    }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ensureDialogStyles(): void {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DIALOG_STYLES;
  document.head.appendChild(style);
}

function closeDialog<T>(
  backdrop: HTMLElement,
  resolve: (value: T) => void,
  value: T,
): void {
  backdrop.remove();
  resolve(value);
}

/**
 * Ask for a single line of text. Resolves trimmed value, or '' if cancelled.
 */
export function askText(
  title: string,
  placeholder = "",
  initial = "",
  submitLabel = "OK",
): Promise<string> {
  ensureDialogStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "papr-dialog-backdrop";
    backdrop.innerHTML = `<div class="papr-dialog-card" role="dialog" aria-modal="true">
      <h2 class="papr-dialog-title">${escapeHtml(title)}</h2>
      <label class="papr-dialog-field">
        <input class="papr-dialog-input" id="papr-dialog-input" autocomplete="off"
          placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(initial)}">
      </label>
      <div class="papr-dialog-actions">
        <button type="button" class="papr-dialog-btn papr-dialog-btn--ghost" data-papr-dialog="cancel">Cancel</button>
        <button type="button" class="papr-dialog-btn papr-dialog-btn--primary" data-papr-dialog="submit">${escapeHtml(submitLabel)}</button>
      </div>
    </div>`;

    const input = backdrop.querySelector("#papr-dialog-input") as HTMLInputElement;
    const submit = (): void => {
      closeDialog(backdrop, resolve, input.value.trim());
    };

    backdrop.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest("[data-papr-dialog]") as HTMLElement | null;
      if (action?.dataset.paprDialog === "submit") {
        submit();
        return;
      }
      if (action?.dataset.paprDialog === "cancel" || target === backdrop) {
        closeDialog(backdrop, resolve, "");
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog(backdrop, resolve, "");
      }
    });

    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

/** Ask a yes/no question. Resolves true only when the confirm button is clicked. */
export function askConfirm(
  message: string,
  confirmLabel = "Confirm",
): Promise<boolean> {
  ensureDialogStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "papr-dialog-backdrop";
    backdrop.innerHTML = `<div class="papr-dialog-card" role="dialog" aria-modal="true">
      <h2 class="papr-dialog-title">Are you sure?</h2>
      <p class="papr-dialog-body">${escapeHtml(message)}</p>
      <div class="papr-dialog-actions">
        <button type="button" class="papr-dialog-btn papr-dialog-btn--ghost" data-papr-dialog="cancel">Cancel</button>
        <button type="button" class="papr-dialog-btn papr-dialog-btn--danger" data-papr-dialog="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;

    backdrop.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest("[data-papr-dialog]") as HTMLElement | null;
      if (action?.dataset.paprDialog === "confirm") {
        closeDialog(backdrop, resolve, true);
        return;
      }
      if (action?.dataset.paprDialog === "cancel" || target === backdrop) {
        closeDialog(backdrop, resolve, false);
      }
    });

    document.body.appendChild(backdrop);
    (
      backdrop.querySelector('[data-papr-dialog="cancel"]') as HTMLElement
    )?.focus();
  });
}

/** Informational alert with a single OK button (non-blocking). */
export function showAlert(message: string, okLabel = "OK"): Promise<void> {
  ensureDialogStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "papr-dialog-backdrop";
    backdrop.innerHTML = `<div class="papr-dialog-card" role="alertdialog" aria-modal="true">
      <p class="papr-dialog-body">${escapeHtml(message)}</p>
      <div class="papr-dialog-actions">
        <button type="button" class="papr-dialog-btn papr-dialog-btn--primary" data-papr-dialog="ok">${escapeHtml(okLabel)}</button>
      </div>
    </div>`;

    const close = (): void => {
      backdrop.remove();
      resolve();
    };

    backdrop.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest("[data-papr-dialog]") as HTMLElement | null;
      if (action?.dataset.paprDialog === "ok" || target === backdrop) {
        close();
      }
    });

    document.body.appendChild(backdrop);
    (
      backdrop.querySelector('[data-papr-dialog="ok"]') as HTMLElement
    )?.focus();
  });
}
