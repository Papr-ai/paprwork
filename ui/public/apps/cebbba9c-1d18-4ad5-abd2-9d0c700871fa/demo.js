const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const CO={
'Cloudline AI':{from:'Lead Prospector',done:true,c:[['Elena Rossi','Founder & CEO','elena@cloudline.ai','verified','cloudline.ai/about','Elena Rossi, founder and CEO, previously led ML at…'],['Raj Mehta','Head of Platform','raj.mehta@cloudline.ai','cited','github.com/cloudline-ai/agents','Maintainer: Raj Mehta (Platform team)'],['Chloe Nguyen','VP Customer Success','c.nguyen@cloudline.ai','inferred','email pattern · 2 verified addresses','first-initial.last@cloudline.ai']]},
'Stackwise':{from:'Lead Prospector',done:false,c:[['Theo Grant','VP Engineering','theo@stackwise.dev','verified','stackwise.dev/team','Theo Grant — VP Engineering'],['Mara Lopez','Chief Revenue Officer','mara.lopez@stackwise.dev','cited','techcrunch.com/2026/09/stackwise-series-b','“said CRO Mara Lopez”'],['Ben Adler','Staff ML Engineer','ben@stackwise.dev','inferred','email pattern · 1 verified address','first@stackwise.dev']]},
'Lumina Systems':{from:'Uploaded list',done:false,c:[['Nina Patel','VP Product','nina.patel@luminasys.com','verified','luminasys.com/leadership','Nina Patel, VP Product'],['Omar Haddad','CTO','omar@luminasys.com','cited','youtube.com/watch?v=lumina-ai-summit','Omar Haddad, CTO at Lumina Systems']]}};
let cur='Cloudline AI';
const conf=c=>`<span class="pill ${c==='verified'?'':c==='cited'?'info':'warn'}">${c}</span>`;
const rowH=x=>`<tr class="fade"><td><b>${esc(x[0])}</b><br><span class="muted">${esc(x[1])}</span></td><td>${esc(x[2])}</td><td>${conf(x[3])}</td><td><div class="src">${esc(x[4])}</div><span class="muted" style="font-size:12px">“${esc(x[5])}”</span></td></tr>`;
function nav(){$('#cos').innerHTML=Object.entries(CO).map(([k,v])=>`<button data-co="${esc(k)}" class="${k===cur?'on':''}">${esc(k)} <span>${v.done?v.c.length:'—'}</span></button>`).join('');$$('[data-co]').forEach(b=>b.onclick=()=>{cur=b.dataset.co;render()})}
function render(){nav();const v=CO[cur];
$('#view').innerHTML=`<div class="row"><div class="grow"><small>From ${esc(v.from)}</small><h1>${esc(cur)}</h1></div><button class="primary" id="enrich" ${v.done?'disabled':''}>${v.done?'Enriched':'Find contacts'}</button></div>
<div class="grid g3" style="margin:18px 0"><div class="card metric"><strong id="m1">${v.done?v.c.length:0}</strong><span>Reachable people</span></div><div class="card metric"><strong id="m2">${v.done?v.c.filter(x=>x[3]!=='inferred').length:0}</strong><span>Verified or cited</span></div><div class="card metric"><strong>100%</strong><span>With a source URL</span></div></div>
<div class="card" style="padding:4px 8px"><table class="table"><thead><tr><th>PERSON</th><th>CONTACT</th><th>CONFIDENCE</th><th>SOURCE</th></tr></thead><tbody id="rows">${v.done?v.c.map(rowH).join(''):'<tr><td colspan="4" class="muted">Not enriched yet — find contacts to see who is reachable.</td></tr>'}</tbody></table></div>`;
$('#enrich').onclick=async()=>{const b=$('#enrich');b.disabled=true;b.textContent='Searching sources…';$('#rows').innerHTML='';
for(const x of v.c){await sleep(550);$('#rows').insertAdjacentHTML('beforeend',rowH(x))}v.done=true;render();toast('Demo enrichment — sample contacts, nothing was looked up')}}
$('#upload').onclick=()=>toast('Demo — install to enrich your own CSV');render();
