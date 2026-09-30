const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MODS=[
['Value proposition',3,'Clear promise — “one operations platform for mid-market distributors” — but it sits below the fold and the hero has no proof point.'],
['ICP',2,'Copy targets “businesses of every size”, yet all 6 case studies are 200–1,000 employee distributors. Say that out loud.'],
['Personas',2,'Operations leaders get deep content. The CFO — who signs — has no page, no ROI calculator and no pricing logic.'],
['Competitive position',3,'Strong story vs. NetSuite on 6-week implementation. No comparison page, so buyers build it themselves.'],
['Market size',3,'~14,000 US mid-market distributors. SAM ≈ $2.1B at current ACV; the site only speaks to ~40% of it.'],
['Channels',2,'Organic drives 61% of traffic. Paid and partner motions are thin; no integration marketplace listings.'],
['90-day plan',null,'Ship a CFO ROI page (wk 1–3) → publish a NetSuite comparison (wk 3–5) → launch 2 partner listings (wk 6–10) → re-run this audit.']];
const MOVES=['Add a CFO ROI page with a payback calculator — highest impact, 2 weeks','Move the proof bar (logos + “live in 6 weeks”) into the hero','Publish a NetSuite vs. Northwind comparison page'];
const lvl=n=>n==null?'<span class="pill info">Plan</span>':`<span class="pill ${n<=2?'warn':''}">${['','Ad hoc','Emerging','Defined','Optimized'][n]} · ${n}/4</span>`;
function mod(m){return `<div class="card fade"><div class="row"><h3 class="grow">${esc(m[0])}</h3>${lvl(m[1])}</div><p class="muted">${esc(m[2])}</p></div>`}
function summary(site){const s=MODS.filter(m=>m[1]).map(m=>m[1]);const avg=(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1);
return `<h2>GTM maturity · ${esc(site)}</h2><div class="grid g4"><div class="card metric"><strong>${avg}/4</strong><span>Overall maturity</span></div><div class="card metric"><strong>2</strong><span>Strong modules</span></div><div class="card metric"><strong>3</strong><span>Gaps to close</span></div><div class="card metric"><strong>$2.1B</strong><span>Serviceable market</span></div></div>
<h2>Prioritized moves</h2><div class="grid">${MOVES.map((m,i)=>`<div class="card row"><span class="pill info">${i+1}</span><span class="grow">${esc(m)}</span></div>`).join('')}</div><h2>Modules</h2>`}
function done(site){$('#report').innerHTML=summary(site)+'<div class="grid">'+MODS.map(mod).join('')+'</div>'}
async function run(site){$('#run').disabled=true;$('#report').innerHTML=summary(site)+'<div class="grid" id="mods"></div>';const box=$('#mods');
for(let i=0;i<MODS.length;i++){$('#prog i').style.width=((i+1)/MODS.length*100)+'%';$('#progt').textContent=`Analyst reading ${site} · module ${i+1} of 7`;await sleep(420);box.insertAdjacentHTML('beforeend',mod(MODS[i]))}
$('#progt').textContent='Report complete · 7 of 7 modules';$('#run').disabled=false}
$('#run').onclick=()=>{const s=$('#url').value.trim()||'northwind-traders.com';run(s);if(!/northwind/.test(s))toast('Demo uses a sample analysis — install to audit any site')};
$$('[data-site]').forEach(b=>b.onclick=()=>{$$('[data-site]').forEach(x=>x.classList.toggle('on',x===b));$('#url').value=b.dataset.site;done(b.dataset.site)});
done('northwind-traders.com');
