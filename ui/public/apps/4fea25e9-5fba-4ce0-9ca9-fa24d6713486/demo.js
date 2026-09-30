const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PEOPLE=[['Maya Chen','Revenue','Northwind 40-seat expansion in legal; need the ROI one-pager signed off.'],['Priya Shah','Product','GA launch post is final; blocked on the launch-day customer quote.'],['Sam Ortiz','Sales','4 AE candidates shortlisted; Northwind security questionnaire due Friday.'],['Alex Rivera','Engineering','Memory graph v2 shipped to beta; p95 retrieval down 38%.']];
let topics=['Lock the GA launch-day customer quote','Q1 pipeline: $510K of $1.2M','AE hiring plan — 2 offers this month'];
const HIST=[['Yesterday','Northwind QBR recap; GA post outline approved; hiring loop agreed.'],['Monday','Weekly review: 74% of time on the three goals; Acme moved to procurement.'],['Last Friday','Beta feedback triage; pricing page test launched.']];
let timer=null,left=180,active=-1;
const fmt=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
function today(){return `<div class="row"><div class="grow"><h1>Daily leadership sync</h1><p class="muted">4 people · 12 minutes · click a person to start their timer</p></div><button id="end">End sync</button></div>
<div class="grid g2" style="margin-top:16px">${PEOPLE.map((p,i)=>`<div class="card" data-p="${i}" style="cursor:pointer;${i===active?'border-color:var(--cyan)':''}"><div class="row"><h3 class="grow">${esc(p[0])}</h3><span class="pill ${i===active?'info':''}" id="t${i}">${i===active?fmt(left):'3:00'}</span></div><small>${esc(p[1])}</small><p class="muted">${esc(p[2])}</p></div>`).join('')}</div>
<h2>Topic queue</h2><div class="grid" id="topics">${topics.map((t,i)=>`<div class="card row"><span class="pill info">${i+1}</span><span class="grow">${esc(t)}</span><button data-done="${i}">Done</button></div>`).join('')}</div>
<div class="row" style="margin-top:10px"><input id="nt" class="grow" placeholder="Add a topic…"><button id="add">Add</button></div>
<h2>Notes</h2><textarea id="notes" style="width:100%;min-height:90px">Decision: Priya owns the customer quote — due Thursday.
Maya to send Dana the ROI one-pager before her CFO sync.</textarea>`}
function history(){return `<h1>History</h1><div class="grid" style="margin-top:14px">${HIST.map(h=>`<div class="card"><small>${esc(h[0])}</small><p>${esc(h[1])}</p></div>`).join('')}</div>`}
function show(v){clearInterval(timer);active=-1;$$('[data-v]').forEach(b=>b.classList.toggle('on',b.dataset.v===v));$('#view').innerHTML=v==='today'?today():history();if(v==='today')wire()}
function wire(){$$('[data-p]').forEach(c=>c.onclick=()=>{clearInterval(timer);active=+c.dataset.p;left=180;$('#view').innerHTML=today();wire();
timer=setInterval(()=>{left=Math.max(0,left-1);const e=$('#t'+active);if(e)e.textContent=fmt(left);if(!left){clearInterval(timer);toast('Time’s up — next person')}},1000)});
$$('[data-done]').forEach(b=>b.onclick=()=>{topics.splice(+b.dataset.done,1);$('#view').innerHTML=today();wire()});
$('#add').onclick=()=>{const v=$('#nt').value.trim();if(!v)return;topics.push(v);$('#view').innerHTML=today();wire()};
$('#end').onclick=()=>{clearInterval(timer);toast('Demo — sync saved to history (sample only)')}}
$$('[data-v]').forEach(b=>b.onclick=()=>show(b.dataset.v));show('today');
