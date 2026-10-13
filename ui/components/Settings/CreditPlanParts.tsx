/**
 * Building blocks for the credits plan cards — the same pieces as the Papr Unit
 * Economics pricing page: ticked bullets, an (i) tooltip, the collapsible
 * "Replaces $X/mo" strip and the collapsible Expert Builder add-on.
 */

import { useState } from "react";
import {
  PAPR_EXPERT_BUILDS,
  PAPR_EXPERT_BUILD_CONTACT,
  formatUsd,
  type PaprExpertBuildSize,
} from "../../../src/core/types/paprCreditPlans";
import {
  replacedToolsFor,
  replacedTotal,
  toolFaviconUrl,
} from "../../../src/core/types/paprPlanReplaces";

const Tick = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3.2L13 5" />
  </svg>
);

const Chevron = () => (
  <svg className="cpc-chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Features({ items }: { items: readonly string[] }) {
  return (
    <ul className="cpc-feat">
      {items.map((t) => (
        <li key={t}><Tick /><span>{t}</span></li>
      ))}
    </ul>
  );
}

/** (i) with a hover/focus bubble. Clicks are swallowed so it never toggles a <details>. */
export function Tip({ text }: { text: string }) {
  return (
    <span className="cpc-tip" tabIndex={0} data-tip={text} role="note" aria-label={text}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>i</span>
  );
}

function ToolLogo({ domain, name, className }: { domain: string; name: string; className: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={className} title={name}>
      {failed ? name.charAt(0) : (
        <img src={toolFaviconUrl(domain)} alt={name} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** "Replaces $X/mo" — collapsed by default; opens to every tool, its price and the Papr equivalent. */
export function ReplacesStrip({ tier }: { tier: number }) {
  const tools = replacedToolsFor(tier);
  if (tools.length === 0) return null;
  const rest = tools.length - 3;
  return (
    <details className="cpc-save">
      <summary>
        <b>Replaces {formatUsd(replacedTotal(tier))}/mo</b>
        <span className="cpc-save-i">
          {tools.slice(0, 3).map((t) => (
            <ToolLogo key={t.job} domain={t.domain} name={t.tools.split(" / ")[0] ?? t.tools} className="cpc-logo" />
          ))}
          {rest > 0 ? <span className="cpc-logo cpc-more">+{rest}</span> : null}
          <Chevron />
        </span>
      </summary>
      <div className="cpc-save-b">
        {tools.map((t) => (
          <div className="cpc-save-r" key={t.job}>
            <ToolLogo domain={t.domain} name={t.tools.split(" / ")[0] ?? t.tools} className="cpc-save-l" />
            <u>{t.job}</u>
            <Tip text={`Instead of ${t.tools}. ${t.papr}`} />
            <em>{formatUsd(t.monthly)}</em>
          </div>
        ))}
      </div>
    </details>
  );
}

/** Expert Builder — the done-for-you service. Collapsed by default, one compact row per size. */
export function ExpertBuilder(props: {
  canBuy: boolean;
  pendingSize: PaprExpertBuildSize | null;
  onBuy: (size: PaprExpertBuildSize) => void;
}) {
  return (
    <details className="cpc-addon">
      <summary>
        <span><em>Add-on</em>Expert Builder</span>
        <b>From $500<Chevron /></b>
      </summary>
      <div className="cpc-addon-b">
        <p>A Papr engineer builds your app. One-time.</p>
        {PAPR_EXPERT_BUILDS.map((b) => (
          <div className="cpc-addon-r" key={b.size}>
            <u>{b.name}</u>
            <Tip text={b.description} />
            {b.price === null ? (
              <a className="cpc-mini" href={PAPR_EXPERT_BUILD_CONTACT}>Contact us</a>
            ) : (
              <button type="button" className="cpc-mini" disabled={!props.canBuy}
                onClick={() => props.onBuy(b.size as PaprExpertBuildSize)}>
                {props.pendingSize === b.size ? "Opening…" : formatUsd(b.price)}
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
