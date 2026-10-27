/**
 * Styles + a tiny script for the apps.papr.ai Discover page. Values follow the desktop
 * (CatalogAppDetails.css, CatalogFeatured.css, AppsHome.css .ah-drop, DefaultCover.css).
 */
export const DISCOVER_CSS = `
:root{--bg:#f5f5f7;--card:#fff;--pop:#fff;--tx:#1d1d1f;--tx2:#6e6e73;--tx3:#8e8e93;--line:rgba(10,16,32,.08);--acc:#0060e0;--chip:rgba(0,0,0,.06);--drop:url(/discover/_/drop-light.png)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c10;--card:#16171c;--pop:#1c1d22;--tx:#f5f5f7;--tx2:#a1a1a6;--tx3:#8e8e93;--line:rgba(255,255,255,.09);--acc:#3b8bff;--chip:rgba(255,255,255,.09);--drop:url(/discover/_/drop-dark.png)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body.lock{overflow:hidden}a{color:inherit;text-decoration:none}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px clamp(16px,4vw,40px);background:color-mix(in srgb,var(--bg) 80%,transparent);backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);border-bottom:.5px solid var(--line)}
.logo{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:18px;letter-spacing:-.02em}
.tabs{display:flex;gap:4px;margin-left:8px}.tabs a{height:30px;display:inline-flex;align-items:center;padding:0 12px;border-radius:15px;font-size:14px;font-weight:550;color:var(--tx2)}
.tabs a:hover{color:var(--tx);background:var(--chip)}.tabs a.on{color:var(--tx);background:var(--chip)}
.right{margin-left:auto;display:flex;align-items:center;gap:12px}.link{font-size:14px;font-weight:550;color:var(--tx2)}.link:hover{color:var(--tx)}
.acct{position:relative}.acct__btn{list-style:none;width:32px;height:32px;border-radius:50%;overflow:hidden;display:grid;place-items:center;cursor:pointer;font-size:13px;font-weight:700;color:#fff;background:linear-gradient(135deg,#0060e0,#00acfa);box-shadow:0 0 0 .5px var(--line)}
.acct__btn::-webkit-details-marker{display:none}.acct__btn img{width:100%;height:100%;object-fit:cover}.acct[open] .acct__btn,.acct__btn:hover{box-shadow:0 0 0 2px color-mix(in srgb,var(--acc) 45%,transparent)}
.acct__menu{position:absolute;right:0;top:calc(100% + 8px);min-width:220px;padding:6px;border-radius:14px;background:var(--pop);box-shadow:0 0 0 .5px var(--line),0 12px 36px rgba(0,0,0,.18);display:grid;animation:pop .14s ease-out}
.acct__who{display:grid;gap:1px;padding:8px 10px 8px}.acct__who b{font-size:14px}.acct__who small{font-size:12.5px;color:var(--tx3);overflow:hidden;text-overflow:ellipsis}
.acct__menu a{padding:8px 10px;border-radius:8px;font-size:14px}.acct__menu a:hover{background:var(--chip)}.acct__menu hr{width:100%;margin:4px 0;border:0;border-top:.5px solid var(--line)}
main{max-width:1180px;margin:0 auto;padding:28px clamp(16px,4vw,40px) 48px}
.h1{margin:0;font-size:clamp(30px,4vw,40px);letter-spacing:-.03em}.sub{margin:4px 0 22px;color:var(--tx2)}
.btn{flex:none;height:30px;display:inline-flex;align-items:center;justify-content:center;padding:0 16px;border:0;border-radius:999px;font:inherit;font-size:13.5px;font-weight:650;color:var(--acc);background:var(--chip);cursor:pointer;white-space:nowrap}
.btn:hover{background:color-mix(in srgb,var(--tx) 10%,transparent)}
.btn--solid{color:#fff;background:var(--acc)}.btn--solid:hover{background:var(--acc);filter:brightness(1.08)}
.btn--w{background:#fff;color:#0060e0}.btn--w:hover{background:#fff;filter:brightness(.95)}
.btn--lg{height:44px;min-width:110px;padding:0 24px;font-size:16px;border-radius:14px}
.get{height:32px;font-size:14px}
.gl{flex:none;display:grid;place-items:center;overflow:hidden;border-radius:50%}
.gl--img img{width:100%;height:100%;object-fit:cover}
.drop{background:var(--drop) center/cover no-repeat;color:rgba(55,65,88,.78)}
.drop>img{width:46%;height:46%}.drop--l{font-weight:650}
.ink-d{display:none}@media (prefers-color-scheme:dark){.drop{color:rgba(210,218,232,.9)}.ink-l{display:none}.ink-d{display:block}}
.feat{position:relative;display:block;height:clamp(260px,32vw,380px);border-radius:26px;overflow:hidden;color:#fff;margin:4px 0 24px;background:#000;isolation:isolate;box-shadow:0 1px 2px rgba(0,0,0,.12),0 18px 50px rgba(0,0,0,.22)}
.feat__shot{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top}
.feat__big{position:absolute;inset:0;display:grid;place-items:center end;padding-right:9%;background:radial-gradient(80% 110% at 88% 0%,color-mix(in srgb,#0060e0 70%,transparent),transparent 62%),linear-gradient(150deg,color-mix(in srgb,#0060e0 42%,#06061a),color-mix(in srgb,#0060e0 80%,#000))}
.feat__txt{position:absolute;inset:auto 0 0;display:grid;gap:14px;padding:90px 28px 20px;background:linear-gradient(transparent,rgba(0,0,0,.38) 38%,rgba(0,0,0,.82))}
.feat__k{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.88)}
.feat__h{max-width:560px;font-size:clamp(24px,3vw,34px);line-height:1.1;letter-spacing:-.025em;font-weight:700;text-shadow:0 6px 28px rgba(0,0,0,.45);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.feat__app{display:flex;align-items:center;gap:12px;max-width:520px;padding:10px 12px;border-radius:18px;background:rgba(16,16,22,.46);border:.5px solid rgba(255,255,255,.16);backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6)}
.feat__app small{color:rgba(255,255,255,.84)!important}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 20px}.pills button{height:30px;padding:0 14px;border:0;border-radius:15px;background:var(--chip);color:var(--tx);font:inherit;font-size:13.5px;font-weight:550;cursor:pointer}
.pills button.on{background:var(--tx);color:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:28px 22px}
.card{display:flex;flex-direction:column;gap:12px;min-width:0}.card[hidden]{display:none}
.ban{position:relative;display:block;aspect-ratio:16/10;border-radius:20px;overflow:hidden;background:var(--card);box-shadow:0 0 0 1px var(--line);transition:transform .2s,box-shadow .2s}
.card:hover .ban{transform:translateY(-2px);box-shadow:0 0 0 1px var(--line),0 14px 36px rgba(10,16,32,.12)}
.ban__img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:top center}
.dcover{position:absolute;inset:0;container-type:inline-size;display:grid;place-items:center;padding:0 7%;text-align:center;background:radial-gradient(90% 120% at 15% 0%,#3d8bff 0%,transparent 60%),linear-gradient(135deg,#0060e0,#0047a8)}
.dcover b{font-size:clamp(15px,5.2cqw,30px);font-weight:700;letter-spacing:-.02em;line-height:1.15;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row{display:flex;align-items:center;gap:12px;min-width:0;padding:0 2px}.row__main{flex:1;min-width:0;display:flex;align-items:center;gap:12px}.row__act{flex:none;display:flex;gap:6px}.card__ban{display:block}
.tx{flex:1;min-width:0;display:grid;gap:2px}.tx b{font-size:15px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tx small{font-size:12.5px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main.narrow{max-width:960px}.mh1{margin:0 0 14px;font-size:22px;font-weight:650;letter-spacing:-.015em}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 22px}.chips button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;border:0;border-radius:15px;cursor:pointer;font:inherit;font-size:13px;font-weight:550;color:var(--tx2);background:var(--chip)}
.chips button:hover{color:var(--tx)}.chips button.on{color:#fff;background:var(--acc)}.chips__sep{width:1px;height:18px;margin:0 4px;background:var(--line)}
.mrows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 28px}.mnone{font-size:13px;color:var(--tx2)}
.mrow{position:relative;display:flex;align-items:center;min-width:0;border-radius:14px;transition:background .15s}.mrow[hidden]{display:none}.mrow:hover{background:color-mix(in srgb,var(--tx) 4%,transparent)}
.mrow__main{flex:1;min-width:0;display:flex;align-items:center;gap:14px;padding:10px 172px 10px 8px;border-radius:14px}
.mrow__txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.mrow__t{display:flex;align-items:center;gap:6px;min-width:0}
.mrow__t b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:650;line-height:1.3}.mrow__mark{flex:none;display:inline-flex;color:var(--tx3)}
.mrow__d{font-size:13.5px;line-height:1.4;color:var(--tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mrow__s{font-size:12.5px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrow__act{position:absolute;top:50%;right:10px;transform:translateY(-50%);display:flex;align-items:center;gap:6px}
.mrow__info{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:var(--tx2);opacity:0;transition:opacity .15s}.mrow:hover .mrow__info,.mrow__info:focus-visible{opacity:1}.mrow__info:hover{background:var(--chip);color:var(--tx)}
@media (max-width:760px){.mrows{grid-template-columns:1fr}}@media (hover:none){.mrow__info{opacity:1}}
.nprog{position:fixed;top:0;left:0;right:0;height:2.5px;z-index:100;pointer-events:none;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,#0060e0,#00acfa);opacity:0}
body.is-nav .nprog{opacity:1;animation:nprog 8s cubic-bezier(.1,.6,.2,1) forwards}@keyframes nprog{0%{transform:scaleX(0)}15%{transform:scaleX(.45)}100%{transform:scaleX(.92)}}
body.is-nav main{opacity:.6;transition:opacity .2s .15s}
.btn.is-busy{pointer-events:none;opacity:.75}.btn.is-busy::after{content:"";width:11px;height:11px;margin-left:7px;border-radius:50%;border:1.6px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(1turn)}}
.empty{display:grid;justify-items:center;gap:6px;padding:64px 16px;text-align:center;color:var(--tx2)}.empty h2{margin:0;color:var(--tx);font-size:21px}.empty p{margin:0 0 12px}
.foot{max-width:1180px;margin:0 auto;padding:24px clamp(16px,4vw,40px) 40px;color:var(--tx3);font-size:13px;border-top:.5px solid var(--line)}.foot a:hover{color:var(--tx)}
.modal{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px 16px;background:rgba(6,8,14,.5);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:fade .15s ease-out}
.modal[hidden]{display:none}
.modal__card{position:relative;display:flex;flex-direction:column;width:min(880px,100%);max-height:calc(100vh - 48px);overflow:hidden;border-radius:26px;background:var(--pop);box-shadow:0 30px 90px rgba(0,0,0,.35);animation:pop .2s cubic-bezier(.2,.8,.2,1)}
.modal__scroll{min-height:0;overflow-y:auto;overscroll-behavior:contain;outline:none}
.modal__x{position:absolute;top:14px;right:14px;z-index:4;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;color:#fff;background:rgba(20,20,26,.55);backdrop-filter:blur(16px)}
.modal__x:hover{background:rgba(20,20,26,.75)}
.page{padding:24px 28px 36px;display:grid;gap:28px}.hero{display:grid;gap:22px}
.hero__media .ban{aspect-ratio:16/10;border-radius:18px}.hero__media .ban__img{object-position:center}
.id{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.id__t{flex:1 1 0;min-width:220px}
.id__t h1{margin:0;font-size:32px;font-weight:700;letter-spacing:-.028em;line-height:1.1}.id__t p{margin:4px 0 0;font-size:18px;color:var(--tx2);letter-spacing:-.01em}
.cta{display:flex;gap:8px;align-items:center}
.cta .btn--solid{background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 85%,#fff),var(--acc));box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 1px 2px rgba(1,97,224,.3),0 6px 16px rgba(1,97,224,.22)}
.facts{list-style:none;margin:0;padding:14px 0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.facts li{display:grid;justify-items:center;gap:3px;min-width:0;padding:0 8px;text-align:center;border-left:1px solid var(--line)}.facts li:first-child{border-left:0}
.facts b{max-width:100%;font-size:17px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.facts span{font-size:11.5px;color:var(--tx3);text-transform:uppercase;letter-spacing:.05em}
.sec h2{margin:0 0 14px;font-size:21px;font-weight:700;letter-spacing:-.018em}.desc{margin:0;max-width:760px;font-size:16px;line-height:1.55;color:var(--tx2);white-space:pre-line}
.shots{display:grid;grid-auto-flow:column;grid-auto-columns:min(420px,78%);gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px}
.shots figure{margin:0;display:grid;gap:8px;scroll-snap-align:start}.shots img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:16px;background:var(--chip)}.shots figcaption{font-size:13px;color:var(--tx2)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.list{margin:0;padding:0;list-style:none;display:grid;gap:10px;font-size:15px;color:var(--tx2)}.list li{display:flex;align-items:center;gap:9px;min-width:0}
.list code{font-size:13px;padding:2px 8px;border-radius:6px;background:var(--chip)}.note{margin:0;font-size:13px;color:var(--tx3)}
@keyframes fade{from{opacity:0}}@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.985)}}
@media (max-width:760px){.modal{place-items:end center;padding:0}.modal__card{width:100%;max-height:94vh;border-radius:24px 24px 0 0}.page{padding:16px 16px 32px;gap:22px}.id__t h1{font-size:26px}.cta{width:100%}.cta .btn{flex:1}
.facts{grid-auto-flow:row;grid-template-columns:repeat(3,1fr);row-gap:12px}.facts li:nth-child(4){border-left:0}.two{grid-template-columns:1fr}}
@media (max-width:640px){.feat{height:auto;aspect-ratio:4/5}.feat__big{place-items:start center;padding:14% 0 0}.grid{grid-template-columns:1fr}.get{display:none}.tabs{margin-left:0}.logo span{display:none}}
@media (prefers-reduced-motion:reduce){.modal,.modal__card{animation:none}}
`;

/** Category pills + open/close the details modal without a page load (links still work without JS). */
export const DISCOVER_JS = `(function(){
var m=document.querySelector('.modal'),sc=m&&m.querySelector('.modal__scroll'),closeTo=m?m.dataset.close:'/';
document.querySelectorAll('.chips button').forEach(function(b){b.onclick=function(){document.querySelectorAll('.chips button').forEach(function(x){x.classList.toggle('on',x===b)});var f=b.dataset.f,k=f.slice(0,4),v=f.slice(4),n=0;document.querySelectorAll('.mrow').forEach(function(r){var ok=!f||(k==='who:'?r.dataset.who===v:r.dataset.cat===v);r.hidden=!ok;if(ok)n++});var z=document.querySelector('.mnone');if(z)z.hidden=n>0}});
document.addEventListener('click',function(e){document.querySelectorAll('details.acct[open]').forEach(function(d){if(!d.contains(e.target))d.removeAttribute('open')})});
document.querySelectorAll('.pills button').forEach(function(b){b.onclick=function(){document.querySelectorAll('.pills button').forEach(function(x){x.classList.toggle('on',x===b)});var c=b.dataset.c;document.querySelectorAll('.card').forEach(function(k){k.hidden=!!c&&k.dataset.cat!==c})}});
function open(id,href,push){var t=document.getElementById(id);if(!t||!m)return false;sc.innerHTML='';sc.appendChild(t.content.cloneNode(true));m.hidden=false;document.body.classList.add('lock');sc.scrollTop=0;sc.focus({preventScroll:true});var h=sc.querySelector('h1');if(h){document.title=h.textContent+' · Papr Work apps'}if(push)history.pushState({d:id},'',href);return true}
function close(push){if(!m||m.hidden)return;m.hidden=true;document.body.classList.remove('lock');sc.querySelectorAll('video').forEach(function(v){v.pause()});if(push)history.pushState({},'',closeTo)}
document.addEventListener('click',function(e){if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;var a=e.target.closest('[data-d]');if(a&&open(a.dataset.d,a.getAttribute('href'),true)){e.preventDefault();return}
if(e.target.closest('.modal__x')||e.target===m){e.preventDefault();close(true)}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){document.querySelectorAll('details.acct[open]').forEach(function(d){d.removeAttribute('open')});close(true)}});
document.addEventListener('click',function(e){if(e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;var a=e.target.closest('a[href]');if(!a||a.hasAttribute('data-d'))return;var h=a.getAttribute('href');if(!h||h[0]==='#')return;
if(a.target==='_blank'){var b=a.classList.contains('btn')?a:a.closest('.mrow')&&a.closest('.mrow').querySelector('.mrow__act .btn');if(b){b.classList.add('is-busy');setTimeout(function(){b.classList.remove('is-busy')},1800)}return}
document.body.classList.add('is-nav')});
window.addEventListener('pageshow',function(){document.body.classList.remove('is-nav');document.querySelectorAll('.btn.is-busy').forEach(function(b){b.classList.remove('is-busy')})});
window.addEventListener('popstate',function(e){var d=e.state&&e.state.d;if(d)open(d,null,false);else close(false)});
if(m&&!m.hidden)document.body.classList.add('lock');
})();`;
