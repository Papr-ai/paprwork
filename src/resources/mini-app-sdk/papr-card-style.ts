/**
 * Card frame — the Prototyper "Claude × Papr" card (cw-card.ts / cw-card.css / brand.css):
 * the app's own icon in a glass tile with the Papr seal on its corner, name over a provenance
 * line, "Built on Papr" signed once on the right, one body, one footer with one gradient action.
 * Everything inside .pc is Papr's surface, so it keeps Papr's tokens in light and dark.
 * Shared by the card kit (per-app cards) and the generic papr_open_app card.
 */

/** Papr mark with its own gradient (cards are standalone documents, no shared <defs>). */
export const PAPR_SEAL =
  '<svg class="seal-mk" viewBox="0 0 105 124" fill="none" aria-hidden="true"><defs><linearGradient id="pcGrad" x1="17" y1="89" x2="69" y2="36" gradientUnits="userSpaceOnUse"><stop stop-color="#0060E0"/><stop offset=".6" stop-color="#00ACFA"/><stop offset="1" stop-color="#0BCDFF"/></linearGradient></defs><path d="M27.9998 101.5C-11.5 158 6.99988 51 43.4008 60.5002C99.2884 75.0861 115.18 20.7781 83.6804 8.27816C40.2693 -8.94844 51.9998 65 27.9998 101.5Z" stroke="url(#pcGrad)" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Header + body + footer. Ids are what the kit and the generic card fill in. */
export function frameHtml(): string {
  return `<section class="pc" aria-label="Papr app card">
<header class="pc-h"><span class="pt"><span class="pt-ic" id="pc-tile">P</span><span class="pt-seal" title="Built on Papr">${PAPR_SEAL}</span></span>
<div class="pc-id"><b id="pc-title">Papr</b><em id="pc-sub">Papr app</em></div><span class="pc-by">Built on ${PAPR_SEAL}<b>Papr</b></span></header>
<main class="pc-b" id="pc-body"><p class="pc-mu">Loading…</p></main>
<footer class="pc-f" id="pc-f"><span class="pc-note" id="pc-note"></span><span class="pc-acts"><button class="pc-open" id="pc-open" hidden>Open in Papr</button>
<span class="pc-act" id="pc-act"></span></span></footer></section>`;
}

export const CARD_CSS = `
:root{color-scheme:light dark;--pc-ac:#0161e0;--pc-glass:rgba(255,255,255,.78);--pc-bd:rgba(1,97,224,.14);--pc-fg:#0b1220;--pc-mu:#5b6475;
--pc-soft:rgba(1,97,224,.06);--pc-ac-bg:rgba(1,97,224,.09);--pc-cta:linear-gradient(135deg,#0161e0,#0a8ff0);--pc-err:#d92d20;--pc-pad:16px}
[data-theme=dark]{--pc-ac:#0ccdff;--pc-glass:rgba(28,33,44,.82);--pc-bd:rgba(12,205,255,.16);--pc-fg:#eef3fb;--pc-mu:#98a3b8;
--pc-soft:rgba(12,205,255,.07);--pc-ac-bg:rgba(12,205,255,.12);--pc-err:#ff8a80}
*{box-sizing:border-box}
body{margin:0;padding:2px 2px 14px;font:14px/1.5 var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif);
color:var(--pc-fg);background:transparent;-webkit-font-smoothing:antialiased}
@keyframes pc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pc{border-radius:18px;background:var(--pc-glass);color:var(--pc-fg);border:1px solid var(--pc-bd);backdrop-filter:blur(24px) saturate(1.4);
overflow:hidden;box-shadow:0 1px 0 rgba(255,255,255,.6) inset,0 1px 2px rgba(10,16,32,.06),0 10px 14px -12px rgba(1,50,120,.28);animation:pc-in .5s ease both}
[data-theme=dark] .pc{box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 1px 2px rgba(0,0,0,.3),0 10px 14px -12px rgba(0,0,0,.6)}
.pc-h{display:flex;align-items:center;gap:12px;padding:12px 16px 13px;border-bottom:1px solid var(--pc-bd);font-size:13px}
.pt{position:relative;display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border-radius:28%;color:#0a1020;
background:linear-gradient(160deg,#fff 0%,#eef3fa 100%);box-shadow:inset 0 1px 0 #fff,0 0 0 1px rgba(1,60,140,.1),0 4px 12px rgba(1,50,120,.12)}
.pt::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(180deg,rgba(255,255,255,.38),rgba(255,255,255,0) 50%)}
.pt-ic{position:relative;z-index:1;display:grid;place-items:center;width:62%;height:62%;font:700 12px/1 inherit;color:var(--pc-ac)}
.pt-ic img{width:100%;height:100%;display:block}
.pt-seal{position:absolute;z-index:2;right:-24%;bottom:-24%;width:62%;height:62%;border-radius:50%;display:grid;place-items:center;
background:#fff;box-shadow:0 0 0 1.5px #fff,0 2px 6px rgba(1,40,110,.28)}
.seal-mk{width:62%;height:62%;display:block}
[data-theme=dark] .pt{color:#f2f5fa;background:linear-gradient(160deg,#2a3140,#1b2130);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 0 0 1px rgba(255,255,255,.08),0 4px 12px rgba(0,0,0,.3)}
[data-theme=dark] .pt-ic img{filter:invert(1)}
[data-theme=dark] .pt-seal{background:#1b2130;box-shadow:0 0 0 1.5px #1b2130,0 2px 6px rgba(0,0,0,.4)}
.pc-id{display:grid;gap:2px;line-height:1.2;min-width:0}
.pc-id b{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-id em{font-style:normal;font-size:11.5px;color:var(--pc-mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-by{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--pc-mu);white-space:nowrap}
.pc-by .seal-mk{width:11px;height:13px}
.pc-by b{font-weight:600;background:linear-gradient(135deg,#00c6ff,#0161e0);-webkit-background-clip:text;background-clip:text;color:transparent}
.pc-b{padding:var(--pc-pad);display:grid;grid-template-columns:minmax(0,1fr);gap:14px;min-height:40px;min-width:0}
.pc-b>*{min-width:0}
.pc-b:empty{display:none}
.pc-pic{display:block;margin:calc(-1 * var(--pc-pad)) calc(-1 * var(--pc-pad)) 0;background:#05070a}
.pc-pic img,.pc-pic video{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.pc-flag{margin:0;font-size:14px;line-height:1.55;color:var(--pc-mu)}.pc-flag b{color:var(--pc-fg);font-weight:600}
.pc-mu{color:var(--pc-mu);margin:0}.pc-err{color:var(--pc-err);margin:0}
.pc-f{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--pc-bd);font-size:12px;color:var(--pc-mu)}
.pc-note{margin-right:auto;min-width:0}.pc-f.pc-f-off{display:none}
.pc-acts{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pc-open{all:unset;box-sizing:border-box;cursor:pointer;white-space:nowrap;padding:8px 14px;border-radius:999px;font-size:13px;font-weight:600;
color:var(--pc-ac);border:1px solid var(--pc-bd);transition:background .15s ease}
.pc-open:hover{background:var(--pc-soft)}.pc-open[hidden]{display:none}.pc-open[disabled]{opacity:.6;cursor:progress}
.pc-open.pc-solid{color:#fff;border-color:transparent;background:var(--pc-cta);box-shadow:0 4px 14px rgba(1,97,224,.28)}
.pc-open:focus-visible{outline:2px solid var(--pc-ac);outline-offset:2px}
.pc-open.pc-quiet{padding:0;border:0;color:var(--pc-mu);font-size:12px;font-weight:500;opacity:.85}.pc-open.pc-quiet:hover{background:none;opacity:1;color:var(--pc-fg)}
.pc-act{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pc-act:empty{display:none}
.pc-confirm{font-size:12.5px;color:var(--pc-fg)}
.pc-btn{all:unset;box-sizing:border-box;cursor:pointer;white-space:nowrap;padding:9px 16px;border-radius:999px;font-size:13px;font-weight:600;
color:#fff;background:var(--pc-cta);box-shadow:0 4px 14px rgba(1,97,224,.28);transition:transform .15s ease}
.pc-btn:hover{transform:translateY(-1px)}.pc-btn:active{transform:scale(.97)}
.pc-btn:focus-visible,.pc-ghost:focus-visible,.pc-chip:focus-visible{outline:2px solid var(--pc-ac);outline-offset:2px}
.pc-btn[disabled]{opacity:.45;cursor:default;transform:none;box-shadow:none}
.pc-btn.pc-ghost{padding:0;background:none;box-shadow:none;color:var(--pc-mu);font-size:12px;font-weight:500;opacity:.85}
.pc-btn.pc-ghost:hover{opacity:1;color:var(--pc-fg);transform:none}
.pc-kv{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:6px 14px;margin:0}
.pc-kv dt{color:var(--pc-mu);font-size:12.5px}.pc-kv dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.pc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.pc-tbl th{text-align:left;color:var(--pc-mu);font-weight:500;padding:4px 8px 6px 0;border-bottom:1px solid var(--pc-bd)}
.pc-tbl td{padding:7px 8px 7px 0;border-bottom:1px solid var(--pc-bd);overflow-wrap:anywhere}
.pc-tbl tr:last-child td{border-bottom:0}
.pc-form{display:grid;gap:10px}.pc-form label{display:grid;gap:6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--pc-mu)}
.pc-form input,.pc-form select,.pc-form textarea{font:15px/1.5 inherit;letter-spacing:0;text-transform:none;color:var(--pc-fg);background:var(--pc-soft);
border:1px solid var(--pc-bd);border-radius:12px;padding:9px 12px;min-height:38px}
.pc-form .pc-check{display:flex;align-items:center;gap:8px;color:var(--pc-fg);text-transform:none;letter-spacing:0;font-size:13px;font-weight:500}
.pc-form .pc-check input{min-height:auto}
.pc-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pc-chips small{width:100%;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--pc-mu)}
.pc-chip{all:unset;cursor:pointer;font-size:13px;padding:5px 11px;border-radius:999px;background:var(--pc-soft);border:1px solid var(--pc-bd);color:var(--pc-fg)}
.pc-chip:hover{border-color:var(--pc-ac);color:var(--pc-ac)}
.pc-nest{display:block;width:100%;border:0;background:transparent}
`;
