/** The brief's three banners (load error, sample data, stale) and the hero. Port of app.js render*Banner + R.hero. */
import { openChat } from "./focusApi";
import { fmtDay, type Hero } from "./brief";

export function LoadErrorBanner({ message }: { message: string }) {
  return (
    <div className="load-error-banner"><div className="load-error-content">
      <div className="load-error-icon" aria-hidden="true">⚠</div>
      <div className="load-error-text"><strong>Could not load your brief</strong><span className="load-error-detail">{message}</span></div>
      <button type="button" className="fix-load-error-btn" onClick={() => openChat(`Focus cannot load my briefs: ${message}. Please check the Daily Brief Generator job and the Focus database.`)}>Ask Agent to fix</button>
    </div></div>
  );
}

const GenButton = ({ label, busy, onClick }: { label: string; busy: string | null; onClick: () => void }) => (
  <button type="button" className="gen-real-brief-btn" disabled={!!busy} onClick={onClick}>
    {busy ? <><div className="spinner" />{busy}</> : label}
  </button>
);

export function SampleBanner({ busy, onGenerate }: { busy: string | null; onGenerate: () => void }) {
  return (
    <div className="sample-data-banner"><div className="sample-data-content">
      <div className="sample-data-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M9 18h6M10 22h4M12 2a6 6 0 0 0-3.4 11c.6.4 1 1 1.1 1.7V16h4.6v-1.3c.1-.7.5-1.3 1.1-1.7A6 6 0 0 0 12 2z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div className="sample-data-text"><strong>This is sample data</strong> — showing what your dashboard will look like when populated.</div>
      <GenButton label="Generate My Real Brief" busy={busy} onClick={onGenerate} />
    </div></div>
  );
}

export function StaleBanner({ date, busy, onGenerate }: { date: string; busy: string | null; onGenerate: () => void }) {
  return (
    <div className="stale-brief-banner"><div className="stale-brief-content">
      <div className="stale-brief-text"><strong>Today&apos;s brief isn&apos;t ready yet</strong><span>Showing your latest brief from {fmtDay(date)}.</span></div>
      <GenButton label="Generate today's brief" busy={busy} onClick={onGenerate} />
    </div></div>
  );
}

/** Date, greeting and inline stats. Live counts replace last night's once Needs you has loaded. */
export function BriefHero({ hero, live }: { hero: Hero; live?: { need: number; waiting: number; later: number } | null }) {
  const stats = live
    ? [{ value: live.need, label: "need you" }, { value: live.waiting, label: "waiting on" }, { value: live.later, label: "coming up" }]
    : hero.stats ?? [];
  return (
    <>
      <p className="hero-date">{hero.date || ""}</p>
      <h1 className="hero-title">{hero.title || "Daily Brief"}</h1>
      {stats.length ? (
        <p className="hero-stats">{stats.map((s) => <span key={s.label} className="stat"><b className="stat-num">{s.value}</b> <span className="stat-label">{s.label}</span></span>)}</p>
      ) : null}
    </>
  );
}
