/**
 * Card frame styles. Host variables (MCP Apps hostContext.styles.variables) win;
 * fallbacks follow Papr Liquid Glass so cards read as Papr in light and dark.
 */
export const CARD_CSS = `
:root{color-scheme:light dark;
--pc-fg:var(--color-text-primary,#14161a);--pc-mu:var(--color-text-secondary,#5b6475);
--pc-bd:var(--color-border-primary,rgba(15,23,42,.1));--pc-bg:var(--color-background-primary,transparent);
--pc-soft:var(--color-background-secondary,rgba(15,23,42,.04));--pc-ac:#0161E0;--pc-err:#d92d20}
[data-theme=dark]{--pc-fg:var(--color-text-primary,rgba(255,255,255,.92));--pc-mu:var(--color-text-secondary,rgba(255,255,255,.6));
--pc-bd:var(--color-border-primary,rgba(255,255,255,.1));--pc-soft:var(--color-background-secondary,rgba(255,255,255,.05));--pc-err:#ff8a80}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif);color:var(--pc-fg);background:var(--pc-bg)}
.pc{border:1px solid var(--pc-bd);border-radius:16px;overflow:hidden}
.pc-h{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--pc-bd)}
.pc-tile{width:30px;height:30px;flex:none;border-radius:9px;display:grid;place-items:center;color:#fff;font:700 11.5px/1 inherit;
background:linear-gradient(135deg,#00C6FF,#0161E0 55%,#4f46e5)}
.pc-t{min-width:0}.pc-t b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-t em{font-style:normal;font-size:11.5px;color:var(--pc-mu)}
.pc-by{margin-left:auto;font-size:11px;color:var(--pc-mu);white-space:nowrap}
.pc-by b{background:linear-gradient(135deg,#00C6FF,#0161E0);-webkit-background-clip:text;background-clip:text;color:transparent}
.pc-b{padding:14px;min-height:56px}
.pc-mu{color:var(--pc-mu);margin:0}.pc-err{color:var(--pc-err);margin:0}
.pc-f{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--pc-bd)}
.pc-note{font-size:12px;color:var(--pc-mu);margin-right:auto}
.pc-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-confirm{font-size:12.5px;color:var(--pc-fg)}
.pc-btn{height:36px;padding:0 16px;border:0;border-radius:999px;color:#fff;font:600 13.5px inherit;cursor:pointer;
background:linear-gradient(135deg,#0161E0,#4f46e5)}
.pc-btn:disabled{opacity:.5;cursor:default}
.pc-ghost{background:transparent;color:var(--pc-fg);border:1px solid var(--pc-bd)}
.pc-kv{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:6px 14px;margin:0}
.pc-kv dt{color:var(--pc-mu);font-size:12.5px}.pc-kv dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.pc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.pc-tbl th{text-align:left;color:var(--pc-mu);font-weight:500;padding:4px 8px 6px 0;border-bottom:1px solid var(--pc-bd)}
.pc-tbl td{padding:6px 8px 6px 0;border-bottom:1px solid var(--pc-bd);overflow-wrap:anywhere}
.pc-form{display:grid;gap:10px}.pc-form label{display:grid;gap:4px;font-size:12.5px;color:var(--pc-mu)}
.pc-form input,.pc-form select,.pc-form textarea{font:inherit;color:var(--pc-fg);background:var(--pc-soft);border:1px solid var(--pc-bd);
border-radius:10px;padding:8px 10px;min-height:36px}
.pc-form .pc-check{display:flex;align-items:center;gap:8px;color:var(--pc-fg)}.pc-form .pc-check input{min-height:auto}
`;
