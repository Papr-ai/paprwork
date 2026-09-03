/**
 * In-app browser for Papr account sign-in (Auth0 / Google) inside Papr.
 */

import { useCallback, useEffect, useRef } from "react";
import "./PaprAuthBrowser.css";

interface PaprAuthBrowserProps {
  visible: boolean;
}

export function PaprAuthBrowser({ visible }: PaprAuthBrowserProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const syncBounds = useCallback(async () => {
    const api = window.electronAPI?.platformBrowser;
    const container = containerRef.current;
    if (!api || !container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    await api.setBounds({
      platformId: "papr-auth",
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      visible: visible && rect.width > 0 && rect.height > 0,
    });
  }, [visible]);

  useEffect(() => {
    void syncBounds();
  }, [syncBounds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      void syncBounds();
    });
    observer.observe(container);

    const onWindowChange = () => {
      void syncBounds();
    };
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onWindowChange, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onWindowChange, true);
      void window.electronAPI?.platformBrowser?.setBounds({
        platformId: "papr-auth",
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    };
  }, [syncBounds]);

  return (
    <div
      className="papr-auth-browser"
      ref={containerRef}
      aria-hidden={!visible}
    />
  );
}
