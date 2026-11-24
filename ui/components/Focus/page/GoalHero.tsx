/**
 * Goal page hero: is the time I put into this goal paying off? One number, one chart (last 7 days vs
 * the target), real faces and logos, the best evidence as tiles. Port of three_hero.js.
 */
import type { FocusGoal, Metrics, MetricsItem } from "./focusApi";
import { openChat } from "./focusApi";
import { ago, hours, num } from "./fmt";

const DOMAINS: Record<string, string> = { x: "x.com", twitter: "x.com", linkedin: "linkedin.com", stripe: "stripe.com", posthog: "posthog.com", github: "github.com" };
const NAMES: Record<string, string> = { x: "X", linkedin: "LinkedIn" };
const safe = (u?: string) => (typeof u === "string" && /^https:\/\//.test(u) ? u : "");
const logo = (d: string, sz = 64) => (d ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=${sz}` : "");
const domainOf = (src: string, url?: string) => { if (DOMAINS[src]) return DOMAINS[src]; try { return new URL(url ?? "").hostname.replace(/^www\./, ""); } catch { return ""; } };
const Img = ({ src, cls, alt = "" }: { src: string; cls: string; alt?: string }) =>
  src ? <img className={cls} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.remove()} /> : null;

export function fmtVal(v: unknown, f?: string): string {
  if (typeof v !== "number") return "";
  if (f === "usd") return `$${num(Math.round(v))}`;
  if (f === "pts") return `${v > 0 ? "+" : ""}${(Math.round(v * 10) / 10).toFixed(1)}`;
  if (f === "percent") return `${Math.round(v)}%`;
  return num(v);
}

interface Col { v: number; today: boolean; cls: string; label: string; title: string; tip?: string }
function Bars({ cols, target }: { cols: Col[]; target: number }) {
  const max = Math.max(target || 0, ...cols.map((c) => c.v), 1);
  return (
    <div className="hh-bars">
      {target ? <i className="hh-goal" style={{ bottom: `calc(18px + (100% - 18px) * ${(target / max).toFixed(3)})` }} /> : null}
      {cols.map((c, i) => (
        <div key={i} className={`hh-col${c.today ? " is-today" : ""}`} title={c.title}>
          <span className={`hh-bar ${c.cls}`} style={{ height: `${c.v ? Math.max(8, (c.v / max) * 100) : 0}%` }} /><em>{c.label}</em>
        </div>
      ))}
    </div>
  );
}
function Diverge({ cols }: { cols: Col[] }) {
  const hi = Math.max(0, ...cols.map((c) => c.v)), lo = Math.min(0, ...cols.map((c) => c.v)), span = hi - lo || 1, z = (-lo / span) * 100;
  const style = (c: Col) => { const h = Math.max(3, (Math.abs(c.v) / span) * 100);
    return c.v < 0 ? { top: `${(100 - z).toFixed(2)}%`, height: `${h.toFixed(2)}%` } : { bottom: `${z.toFixed(2)}%`, height: `${h.toFixed(2)}%` }; };
  return (
    <div className="hh-bars hh-div"><div className="hh-plot">
      {lo < 0 ? <i className="hh-zero" style={{ bottom: `${z.toFixed(2)}%` }} /> : null}
      {cols.map((c, i) => (
        <div key={i} className={`hh-col${c.today ? " is-today" : ""}`} title={c.title}>
          <span className={`hh-bar ${c.cls}`} style={style(c)}><b className="hh-val">{c.tip}</b></span><em>{c.label}</em>
        </div>
      ))}
    </div></div>
  );
}

function week(items: MetricsItem[]) {
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 6 + i); return { d, n: 0, views: 0, src: new Set<string>() }; });
  const by = Object.fromEntries(days.map((x) => [x.d.toLocaleDateString("en-CA"), x]));
  for (const it of items) { const day = it.at && by[new Date(it.at).toLocaleDateString("en-CA")]; if (day) { day.n++; day.views += it.impressions || 0; day.src.add(it.source ?? ""); } }
  return days;
}

function Chart({ m, nSrc }: { m: Metrics & { hero: string }; nSrc: number }) {
  const c = m.display?.chart, f = m.display?.format;
  if (c?.bars?.length) {
    const cols = c.bars.map((x, i) => ({ v: x.value, today: i === c.bars.length - 1, cls: x.value < 0 || x.tone === "neg" ? "is-neg" : x.tone === "full" ? "is-full" : x.tone === "part" ? "is-part" : "", label: x.label, tip: fmtVal(x.value, f), title: x.title || `${x.label} · ${fmtVal(x.value, f)}` }));
    return <div className="hh-chart"><p className="hh-cap">{c.caption}</p><Diverge cols={cols} /></div>;
  }
  const items = (m.items ?? []).filter((i) => i.at);
  if (items.length) {
    const days = week(items), hit = days.filter((d) => d.n > 0).length;
    const cols = days.map((d, i) => ({ v: d.n, today: i === 6, label: d.d.toLocaleDateString("en-US", { weekday: "narrow" }), cls: d.src.size >= nSrc ? "is-full" : d.n ? "is-part" : "",
      title: `${d.d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${d.n} posted${d.views ? ` · ${num(d.views)} views` : ""}` }));
    return <div className="hh-chart"><p className="hh-cap"><b>{hit} of 7 days</b> showed up</p><Bars cols={cols} target={nSrc} /></div>;
  }
  const hist = (m.history ?? []).filter((h) => typeof h[m.hero] === "number").slice(-14);
  if (hist.length < 2) return null;
  const cols = hist.map((h, i) => ({ v: h[m.hero], today: i === hist.length - 1, cls: "is-full", label: h.date.slice(8), title: `${h.date} · ${num(h[m.hero])}` }));
  return <div className="hh-chart"><p className="hh-cap"><b>Last {hist.length} days</b></p><Bars cols={cols} target={0} /></div>;
}

function Delta({ m }: { m: Metrics & { hero: string } }) {
  const now = m.summary?.[m.hero];
  const cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const then = [...(m.history ?? [])].reverse().find((h) => h.date <= cut && typeof h[m.hero] === "number")?.[m.hero];
  if (m.display?.format === "pts" || typeof now !== "number" || !then) return null;
  const pct = Math.round(((now - then) / then) * 100);
  return pct ? <em className={`hh-delta is-${pct > 0 ? "up" : "down"}`}>{pct > 0 ? "↑" : "↓"} {Math.abs(pct)}% vs last week</em> : null;
}

function Faces({ g, m }: { g: FocusGoal; m: Metrics }) {
  return <>{Object.entries(m.sources ?? {}).map(([k, v]) => {
    const p = v.profile ?? {}, dom = domainOf(k, p.url), name = p.name || NAMES[k] || k;
    const tip = v.ok ? [p.handle && `@${p.handle}`, name, p.followers != null && `${num(p.followers)} followers`].filter(Boolean).join(" · ")
      : `${name}: ${v.error === "not connected" ? "not connected" : "needs attention. Tap to fix"}`;
    const inner = <>{safe(p.avatar) ? <Img src={safe(p.avatar)} cls="hh-av" alt={name} /> : <span className="hh-av hh-initial">{(p.name || name)[0] || "?"}</span>}<Img src={logo(dom, 32)} cls="hh-badge" /></>;
    return v.ok ? <a key={k} className="hh-face" href={safe(p.url) || "#"} target="_blank" rel="noopener" title={tip}>{inner}</a>
      : <button key={k} type="button" className="hh-face is-off" title={tip}
          onClick={() => openChat(`My Focus tracker for "${g.title}" can't read ${NAMES[k] || k}: ${v.error || "unknown error"}. Fix it and re-run the tracker.`)}>{inner}</button>;
  })}</>;
}

function Best({ items }: { items: MetricsItem[] }) {
  const own = items.some((i) => i.value != null);
  const top = own ? items.slice(0, 3) : [...items].sort((a, b) => (b.impressions || 0) - (a.impressions || 0) || (b.engagement || 0) - (a.engagement || 0)).slice(0, 3);
  if (!top.length) return null;
  const tileNum = (n: number, unit: string) => unit === "$" ? fmtVal(n, "usd") : unit === "pts" ? <>{fmtVal(n, "pts")}<span>pts</span></> : <>{num(n)}{unit ? <span>{unit}</span> : null}</>;
  return (
    <div className="hh-best">{top.map((it, i) => {
      const n = own ? it.value : it.impressions ?? it.engagement;
      const unit = own ? it.unit || "" : it.impressions != null ? "views" : "engagements";
      return (
        <a key={i} className={`hh-tile${it.image ? " has-photo" : ""}`} href={safe(it.url) || "#"} target="_blank" rel="noopener">
          <Img src={safe(it.image) || logo(it.domain || domainOf(it.source ?? "", it.url), 64)} cls={it.image ? "hh-bg" : "hh-logo"} />
          <p>{it.text || it.source}</p>{n != null ? <b>{tileNum(n, unit)}</b> : null}
        </a>
      );
    })}</div>
  );
}

export function GoalHero({ g }: { g: FocusGoal }) {
  const s = g.signals ?? {}, t = g.tracker?.status === "active" ? g.tracker.metrics : undefined;
  const hero = t && (t.hero || Object.keys(t.labels || {}).find((k) => t.summary?.[k] != null));
  if (!t || !hero || t.summary?.[hero] == null) {
    const rest = [s.chats30 && `${s.chats30} chats this month`, s.openTasks && `${s.openTasks} open tasks`].filter(Boolean).join(" · ");
    return <section className="hhero"><div className="hh-top"><div><b className="hh-num">{hours(s.hours7)}</b><span className="hh-lab">In chats this week</span></div></div>{rest ? <p className="hh-roi">{rest}</p> : null}</section>;
  }
  const m = { ...t, hero }, sum = m.summary, live = Object.values(m.sources ?? {}).filter((v) => v.ok).length || 1;
  const out = Object.keys(m.labels || {}).filter((k) => k !== hero && /posts|engagement|customers|meetings|signups|new/.test(k) && sum[k] != null).slice(0, 2)
    .map((k) => `${num(sum[k])} ${/engagement/.test(k) ? "engagements" : m.labels[k].replace(/ this week$/i, "").toLowerCase()}`);
  return (
    <section className="hhero">
      <div className="hh-top">
        <div><b className="hh-num">{fmtVal(sum[hero], m.display?.format)}</b><span className="hh-lab">{m.display?.label || m.labels?.[hero] || hero}<Delta m={m} /></span></div>
        <div className="hh-faces"><Faces g={g} m={m} /></div>
      </div>
      <p className="hh-roi"><b>{hours(s.hours7)}</b> in chats <span aria-hidden="true">→</span> {m.display?.line || out.join(" · ") || "results"}</p>
      <Chart m={m} nSrc={live} /><Best items={m.items ?? []} />
      <p className="hh-foot">Updated {ago(m.updatedAt)}</p>
    </section>
  );
}
