/**
 * Looping app preview video. Loads nothing until it scrolls into view, plays only while
 * visible, pauses off-screen and in background tabs, and shows the still poster when the
 * user prefers reduced motion. Decorative: clicks go to the card underneath.
 */
import { useEffect, useRef, useState } from "react";

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function DemoVideo({
  src,
  poster,
  className,
  onError,
}: {
  src: string;
  poster?: string;
  className?: string;
  onError?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [still] = useState(reducedMotion);

  useEffect(() => {
    const el = ref.current;
    if (!el || still) return;
    let visible = false;
    const sync = () => {
      if (visible && document.visibilityState === "visible") {
        if (el.preload !== "auto") el.preload = "auto";
        void el.play().catch(() => undefined);
      } else {
        el.pause();
      }
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        sync();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
      el.pause();
    };
  }, [still, src]);

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
