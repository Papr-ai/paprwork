/**
 * The default cover: Papr blue with the app's name. Every app shows it until the owner
 * approves a gallery (catalog cards, the Gallery's big frame). Children sit on top,
 * e.g. the Gallery's "Generate video and screens" button.
 */
import type { ReactNode } from "react";
import "./DefaultCover.css";

export function DefaultCover({ name, tag, children, className }: {
  name: string;
  /** Small label in the corner, e.g. "Default cover" in the Gallery. */
  tag?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`dcover ${className ?? ""}`}>
      {tag ? <span className="dcover__tag">{tag}</span> : null}
      <div className="dcover__in">
        <b className="dcover__name">{name}</b>
        {children}
      </div>
    </div>
  );
}
