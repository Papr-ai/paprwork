/** Your three: the goals Pen picked (or you chose), one row each, under "Do this first". Port of three.js section(). */
import type { FocusState } from "./focusApi";
import { goalSub, hours } from "./fmt";
import { ChevIcon } from "./icons";

export function YourThree({ data, onOpen, onEdit }: { data: FocusState | null; onOpen: (id: string) => void; onEdit: () => void }) {
  if (!data?.three?.length) return null;
  const pick = data.source === "pen" && !data.confirmed;
  return (
    <section className="hthree">
      <header>
        <h2 className="section-title">
          Priority goals {pick ? <em className="t3pick" title="Pen picked these from your goals and activity. Edit any time.">Pen&apos;s picks</em> : null}
        </h2>
        <button type="button" className="t3link" onClick={onEdit}>Edit</button>
      </header>
      {data.three.map((g, i) => {
        const s = g.signals ?? {};
        const meta = (s.hours7 ?? 0) >= 0.1 ? `${hours(s.hours7)} this week` : s.chats30 ? `${s.chats30} chats` : "";
        const sub = goalSub(g);
        return (
          <button key={g.id} type="button" className="t3row" onClick={() => onOpen(g.id)}>
            <i>{i + 1}</i>
            <span><b>{g.title}</b>{sub ? <em>{sub}</em> : null}</span>
            <small>{meta}</small>
            <ChevIcon className="t3chev" />
          </button>
        );
      })}
      {data.alignedPct == null ? null : (
        <p className="t3aligned">
          <span className="t3bar"><i style={{ width: `${Math.min(100, data.alignedPct)}%` }} /></span>
          <b>{data.alignedPct}%</b> of this week&apos;s chat time went to these
        </p>
      )}
    </section>
  );
}
