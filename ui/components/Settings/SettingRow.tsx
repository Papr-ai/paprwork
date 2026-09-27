import type { ReactNode } from "react";

/**
 * One compact settings row: label + one-line hint on the left, control on
 * the right. `nested` indents under a parent toggle; `disabled` dims the text.
 * Styles: `.setting-row*` in SettingsView.css.
 */
export function SettingRow({
  label,
  hint,
  tooltip,
  nested = false,
  disabled = false,
  children,
}: {
  label: string;
  hint?: string;
  tooltip?: string;
  nested?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const cls = ["setting-row", nested && "setting-row--nested", disabled && "setting-row--disabled"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} aria-disabled={disabled || undefined}>
      <div className="setting-row__text">
        <div className="setting-row__label">
          {label}
          {tooltip ? (
            <span className="setting-row__help" title={tooltip} aria-label={tooltip}>
              ?
            </span>
          ) : null}
        </div>
        {hint ? <div className="setting-row__hint">{hint}</div> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}
