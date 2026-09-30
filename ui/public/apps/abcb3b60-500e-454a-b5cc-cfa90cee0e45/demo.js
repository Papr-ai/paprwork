const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const METRICS=[['78','SEO score / 100'],['48','Pages crawled'],['3','Redirect chains'],['2.4 MB','Heaviest page']];
const F=[
['bad','Critical','5 pages have no canonical tag','/blog/agent-memory, /blog/memory-moat, /docs/quickstart, /docs/api, /pricing?ref=x — duplicate URLs split ranking signals.'],
['warn','High','3 redirect chains (2+ hops)','/docs → /docs/ → /docs/overview (301, 301). Each hop costs crawl budget and ~120 ms.'],
['warn','High','7 images over 400 KB','hero-memory.png (1.8 MB), graph-demo.gif (1.2 MB)… Convert to AVIF/WebP and lazy-load below the fold.'],
['warn','Medium','JSON-LD missing on 17 of 48 pages','Blog posts lack Article schema; /pricing lacks Product + Offer schema.'],
['info','Low','12 titles over 60 characters','Titles truncate in results, e.g. “Papr — The Memory Layer for AI Agents, Teams and Every App You…”.'],
['ok','Pass','Status codes clean','46 × 200, 2 × 301, 0 × 4xx/5xx. robots.txt and sitemap.xml valid.']];
const PLAN=['Add self-referencing canonicals to all 48 templates — 1 hour, biggest win','Collapse /docs redirect chain to a single 301','Compress the 7 heavy images (−4.9 MB total)','Add Article + Product JSON-LD to blog and pricing templates'];
const pill=(k,t)=>`<span class="pill ${k==='ok'?'':k}">${t}</span>`;
function render(){$('#metrics').innerHTML=METRICS.map(m=>`<div class="card metric fade"><strong>${m[0]}</strong><span>${m[1]}</span></div>`).join('');
$('#findings').innerHTML=F.map((f,i)=>`<div class="card fade" data-f="${i}" style="cursor:pointer"><div class="row">${pill(f[0],f[1])}<h3 class="grow">${esc(f[2])}</h3><span class="muted">▾</span></div><p class="muted ev" hidden>${esc(f[3])}</p></div>`).join('');
$('#plan').innerHTML=PLAN.map((p,i)=>`<div class="card row fade"><span class="pill info">${i+1}</span><span class="grow">${esc(p)}</span></div>`).join('');
$$('[data-f]').forEach(c=>c.onclick=()=>{const e=c.querySelector('.ev');e.hidden=!e.hidden})}
$('#run').onclick=async()=>{const s=$('#url').value.trim()||'papr.ai';$('#run').disabled=true;['#metrics','#findings','#plan'].forEach(x=>$(x).innerHTML='');
for(let i=1;i<=48;i+=3){$('#pb').style.width=(i/48*100)+'%';$('#pt').textContent=`Crawling ${s} · page ${i} of 48`;await sleep(45)}
$('#pb').style.width='100%';$('#pt').textContent='Crawled 48 of 48 pages · rendered with a headless browser';render();$('#run').disabled=false;
if(!/papr\.ai/.test(s))toast('Demo shows a sample crawl — install to audit your own site')};
render();
