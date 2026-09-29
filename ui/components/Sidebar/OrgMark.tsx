/**
 * OrgMark — an org's logo on a white tile, like an app icon. The monogram sits underneath,
 * so a missing or broken image still reads as the org.
 */
import { useEffect, useState } from "react";

interface OrgMarkProps {
  name: string;
  src: string;
  className?: string;
}

export function OrgMark({ name, src, className = "" }: OrgMarkProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={`org-mark ${className}`} data-letter={letter} aria-hidden="true">
      {src && !failed ? <img src={src} alt="" draggable={false} onError={() => setFailed(true)} /> : null}
    </span>
  );
}
