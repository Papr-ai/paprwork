/**
 * App preview video. Still poster by default; it plays only while the pointer is over (or
 * keyboard focus is inside) the card that holds it, so a page of cards stays calm. The card
 * is the nearest `[data-hover-play]` ancestor, else the video's parent. `autoPlay` is for the
 * one video the user opened on purpose (the app page): it plays while visible.
 * Reduced motion → the poster only. Decorative: clicks go to the card underneath.
 */
import { useEffect, useRef, useState } from "react";

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function DemoVideo({
  src,
  poster,
  className,
  onError,
  autoPlay = false,
}: {
  src: string;
  poster?: string;
  className?: string;
  onError?: () => void;
  autoPlay?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [still] = useState(reducedMotion);

  useEffect(() => {
    const el = ref.current;
    if (!el || still) return;
    const play = () => {
      if (document.visibilityState !== "visible") return;
      if (el.preload !== "auto") el.preload = "auto";
      void el.play().catch(() => undefined);
    };
    const stop = () => el.pause();

    if (autoPlay) {
      let visible = false;
      const sync = () => (visible ? play() : stop());
      const io = new IntersectionObserver(([e]) => { visible = Boolean(e?.isIntersecting); sync(); }, { threshold: 0.35 });
      io.observe(el);
      document.addEventListener("visibilitychange", sync);
      return () => { io.disconnect(); document.removeEventListener("visibilitychange", sync); stop(); };
    }

    const host = el.closest<HTMLElement>("[data-hover-play]") ?? el.parentElement;
    if (!host) return;
    // Leaving rewinds, so the next hover starts the story from the top (and the poster shows).
    const leave = () => { stop(); el.currentTime = 0; };
    const focusOut = (e: FocusEvent) => { if (!host.contains(e.relatedTarget as Node | null)) leave(); };
    host.addEventListener("pointerenter", play);
    host.addEventListener("pointerleave", leave);
    host.addEventListener("focusin", play);
    host.addEventListener("focusout", focusOut);
    document.addEventListener("visibilitychange", leave);
    return () => {
      host.removeEventListener("pointerenter", play);
      host.removeEventListener("pointerleave", leave);
      host.removeEventListener("focusin", play);
      host.removeEventListener("focusout", focusOut);
      document.removeEventListener("visibilitychange", leave);
      stop();
    };
  }, [still, src, autoPlay]);

  if (still && poster) {
    return <img className={className} src={poster} alt="" draggable={false} loading="lazy" onError={onError} />;
  }
  return (
    <video
      ref={ref}
      className={className}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="none"
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      onError={onError}
    />
  );
}
