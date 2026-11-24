/**
 * Full-screen viewer for a rendered Mermaid diagram.
 * Wheel / pinch / +− to zoom, drag to pan, 0 to fit, Esc or backdrop to close.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface MermaidLightboxProps {
  svg: string;
  onClose: () => void;
}

const MIN = 0.2;
const MAX = 8;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

export function MermaidLightbox({ svg, onClose }: MermaidLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setZoom((z) => clamp(z * 1.25));
      else if (e.key === "-") setZoom((z) => clamp(z / 1.25));
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reset]);

  const onWheel = (e: React.WheelEvent) => {
    // Trackpad pinch arrives as ctrl+wheel; plain wheel zooms too — there is
    // nothing else to scroll in the viewer.
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    setZoom((z) => clamp(z * factor));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return createPortal(
    <div
      className="mermaid-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram viewer"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="mermaid-lightbox__stage"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
      >
        <div
          className="mermaid-lightbox__canvas"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="mermaid-lightbox__toolbar">
        <button onClick={() => setZoom((z) => clamp(z / 1.25))} title="Zoom out (−)">
          −
        </button>
        <button onClick={reset} title="Fit (0)" className="mermaid-lightbox__pct">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => clamp(z * 1.25))} title="Zoom in (+)">
          +
        </button>
        <span className="mermaid-lightbox__divider" />
        <button onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
    </div>,
    document.body,
  );
}
