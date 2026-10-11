/**
 * Card frame styles — the Prototyper "app card in chat" look (ca-acard):
 * squircle app tile + name + one quiet meta line, content, one accent "Open in {App}".
 * Host variables (MCP Apps hostContext.styles.variables) win; fallbacks are Papr Liquid Glass.
 */
export const CARD_CSS = `
:root{color-scheme:light dark;
--pc-fg:var(--color-text-primary,#14161a);--pc-mu:var(--color-text-secondary,#6b7280);
--pc-bd:var(--color-border-primary,rgba(15,23,42,.09));--pc-bg:var(--color-background-primary,#fff);
--pc-soft:var(--color-background-secondary,rgba(15,23,42,.04));--pc-ac:#0161E0;--pc-ac-bg:rgba(1,97,224,.09);--pc-err:#d92d20;
--pc-tint:#0161E0;--pc-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.06)}
[data-theme=dark]{--pc-fg:var(--color-text-primary,rgba(255,255,255,.92));--pc-mu:var(--color-text-secondary,rgba(255,255,255,.58));
--pc-bd:var(--color-border-primary,rgba(255,255,255,.1));--pc-bg:var(--color-background-primary,#1c1d21);
--pc-soft:var(--color-background-secondary,rgba(255,255,255,.06));--pc-ac:#3b8bff;--pc-ac-bg:rgba(59,139,255,.14);--pc-err:#ff8a80;
--pc-shadow:0 1px 2px rgba(0,0,0,.3)}
*{box-sizing:border-box}
body{margin:0;padding:2px;font:14px/1.5 var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif);
color:var(--pc-fg);background:transparent;-webkit-font-smoothing:antialiased}
.pc{border:1px solid var(--pc-bd);border-radius:18px;overflow:hidden;background:var(--pc-bg);box-shadow:var(--pc-shadow)}
.pc-h{display:flex;align-items:center;gap:10px;padding:10px 12px}
.pc-tile{position:relative;overflow:hidden;width:30px;height:30px;flex:none;border-radius:23%;display:grid;place-items:center;
color:#fff;font:700 11.5px/1 inherit;letter-spacing:.02em;
background:linear-gradient(150deg,color-mix(in srgb,var(--pc-tint) 45%,#0b0b24) 0%,var(--pc-tint) 58%,color-mix(in srgb,var(--pc-tint) 72%,#fff) 100%);
box-shadow:0 1px 2px rgba(0,0,0,.16),0 3px 10px color-mix(in srgb,var(--pc-tint) 26%,transparent)}
.pc-tile::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
background:linear-gradient(165deg,rgba(255,255,255,.32),rgba(255,255,255,0) 46%);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.28)}
.pc-tile img{width:62%;height:62%;display:block;filter:brightness(0) invert(1)}
.pc-t{min-width:0;display:flex;align-items:baseline;gap:8px;flex:1}
.pc-t b{font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-meta{margin-left:auto;font-size:12px;color:var(--pc-mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-b{padding:2px 14px 12px;min-height:40px}
.pc-b:empty{display:none}
.pc-pic{display:block;margin:0 -14px 2px;background:#05070a}
.pc-pic img,.pc-pic video{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.pc-flag{margin:10px 0 0;font-size:13.5px;line-height:1.45;color:var(--pc-mu)}.pc-flag b{color:var(--pc-fg);font-weight:600}
.pc-mu{color:var(--pc-mu);margin:0}.pc-err{color:var(--pc-err);margin:0}
.pc-f{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:0 12px 12px}
.pc-note{font-size:12px;color:var(--pc-mu);margin-right:auto}
.pc-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pc-act:empty{display:none}
.pc-confirm{font-size:12.5px;color:var(--pc-fg)}
.pc-btn{height:30px;min-width:64px;padding:0 14px;border:0;border-radius:999px;font:600 13px/1 inherit;letter-spacing:-.005em;cursor:pointer;
background:var(--pc-ac);color:#fff;transition:transform .15s ease,filter .15s ease}
.pc-btn:hover{filter:brightness(1.08)}.pc-btn:active{transform:scale(.96)}
.pc-btn:disabled{opacity:.45;cursor:default;transform:none;filter:none}
.pc-ghost{background:var(--pc-ac-bg);color:var(--pc-ac)}
.pc-kv{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:6px 14px;margin:0}
.pc-kv dt{color:var(--pc-mu);font-size:12.5px}.pc-kv dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.pc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.pc-tbl th{text-align:left;color:var(--pc-mu);font-weight:500;padding:4px 8px 6px 0;border-bottom:1px solid var(--pc-bd)}
.pc-tbl td{padding:7px 8px 7px 0;border-bottom:1px solid var(--pc-bd);overflow-wrap:anywhere}
.pc-tbl tr:last-child td{border-bottom:0}
.pc-form{display:grid;gap:10px}.pc-form label{display:grid;gap:4px;font-size:12.5px;color:var(--pc-mu)}
.pc-form input,.pc-form select,.pc-form textarea{font:inherit;color:var(--pc-fg);background:var(--pc-soft);border:1px solid var(--pc-bd);
border-radius:10px;padding:8px 10px;min-height:36px}
.pc-form .pc-check{display:flex;align-items:center;gap:8px;color:var(--pc-fg)}.pc-form .pc-check input{min-height:auto}
.pc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.pc-chip{border:1px solid var(--pc-bd);background:var(--pc-soft);color:var(--pc-fg);border-radius:999px;padding:5px 11px;font:500 12.5px/1.3 inherit;cursor:pointer}
.pc-chip:hover{border-color:var(--pc-ac);color:var(--pc-ac)}
`;
