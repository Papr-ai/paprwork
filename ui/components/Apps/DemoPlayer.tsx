/**
 * The Gallery's video player. Starts paused behind a big play button; once playing, the
 * controls sit along the bottom and fade until you hover, like any player. Comment
 * markers ride on the scrub bar. Pins (children) sit over the picture.
 */
import { useState, type ReactNode, type RefObject } from "react";

export function DemoPlayer({ src, poster, videoRef, pinning, marks, onTime, onPlace, children }: {
  src: string;
  poster: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Choosing a spot for a comment: clicks place a pin instead of playing. */
  pinning: boolean;
  marks: { id: string; t: number }[];
  onTime: (t: number) => void;
  onPlace: (e: React.MouseEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const v = () => videoRef.current;
  const toggle = () => {
    const el = v();
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };
  const seek = (to: number) => {
    const el = v();
    if (!el) return;
    el.pause();
    el.currentTime = to;
    setT(to);
    onTime(to);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className={`dg-box dg-player ${playing ? "is-playing" : ""} ${pinning ? "is-pinning" : ""}`} onClick={onPlace}>
      <video ref={videoRef} className="dn-video" src={src} poster={poster} muted loop playsInline preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          const now = Math.round(e.currentTarget.currentTime * 10) / 10;
          setT(now);
          onTime(now);
        }} />
      {children}
      {!playing && !pinning ? (
        <button type="button" className="dg-bigplay" aria-label="Play" onClick={(e) => { stop(e); toggle(); }} />
      ) : null}
      <div className="dg-ctrl" onClick={stop}>
        <button type="button" className={`dg-pp ${playing ? "" : "is-paused"}`} aria-label={playing ? "Pause" : "Play"} onClick={toggle} />
        <div className="dg-track">
          <input type="range" className="dg-scrub" min={0} max={dur || 1} step={0.1} value={t} aria-label="Position"
            onChange={(e) => seek(Number(e.target.value))} />
          {dur ? marks.map((m) => (
            <button key={m.id} type="button" className="dg-tick" style={{ left: `${(m.t / dur) * 100}%` }}
              aria-label={`Comment at ${m.t.toFixed(1)}s`} onClick={() => seek(m.t)} />
          )) : null}
        </div>
        <span className="dg-time">{t.toFixed(1)}s</span>
      </div>
    </div>
  );
}
