const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const S=[
['Northwind loses 40 minutes on every renewal prep',['300 renewals a year × 40 minutes = 200 hours of AE time','Context is split across HubSpot, Gong, Slack and email','Two renewals slipped last quarter from missed history']],
['Why now: your agents forget',['Copilots answer from one session, not your customer history','Every rep re-pastes the same account context','Buyers now expect you to remember them']],
['Papr: one memory layer for the whole team',['Connects HubSpot, Gong, Slack and Notion into one memory','Agents and reps see the same cited account history','Permissions follow the source system']],
['Proof: Acme cut renewal prep by 62%',['Prep time fell from 38 to 14 minutes in 6 weeks','Net retention up 9 points in two quarters','Rolled out to 45 reps without new admin work']],
['Why Papr vs. building on a vector DB',['Memory graph, not just similarity search','Live in days, no retrieval pipeline to maintain','Workspace-scoped, never used for training']],
['Next step: a two-week pilot with the legal team',['Kickoff October 14 with 10 legal-team reps','Success = prep time under 15 minutes','Decision meeting with Dana October 28']]];
let CR=[['Pain quantification',4.5,'Hours and dollars are quantified on slide 1.'],['Proof relevance',2.5,'Acme is logistics, not distribution — add a distributor case.'],['Differentiation',3.5,'Slide 5 is strong; bring one line of it forward to slide 3.'],['CTA specificity',4.0,'Dates and owner are clear; add the success metric owner.']];
let cur=0;
const slideH=s=>`<h2 contenteditable="true" spellcheck="false">${esc(s[0])}</h2><ul>${s[1].map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`;
function render(){$('#thumbs').innerHTML=S.map((s,i)=>`<button data-s="${i}" class="${i===cur?'on':''}">${i+1}. ${esc(s[0])}</button>`).join('');$$('[data-s]').forEach(b=>b.onclick=()=>{cur=+b.dataset.s;render()});
$('#slide').innerHTML=slideH(S[cur]);const h=$('#slide h2');h.onblur=()=>{if(h.textContent.trim()&&h.textContent!==S[cur][0]){S[cur][0]=h.textContent.trim();render();toast('Demo — edits stay in this tab only')}};
$('#crit').innerHTML=CR.map(c=>`<div class="card" style="padding:12px 14px"><div class="row"><b class="grow" style="font-size:13px">${esc(c[0])}</b><span class="score">${c[1].toFixed(1)}</span></div><div class="bar" style="margin:6px 0"><i style="width:${c[1]*20}%"></i></div><p class="muted" style="font-size:12px">${esc(c[2])}</p></div>`).join('')}
function pres(){$('#pslide').innerHTML=slideH(S[cur]).replace('contenteditable="true"','');$('#pnum').textContent=(cur+1)+' / '+S.length}
function go(d){cur=Math.max(0,Math.min(S.length-1,cur+d));render();if($('#pres').classList.contains('open'))pres()}
$('#present').onclick=()=>{$('#pres').classList.add('open');pres()};$('#pclose').onclick=()=>$('#pres').classList.remove('open');$('#pprev').onclick=()=>go(-1);$('#pnext').onclick=()=>go(1);
addEventListener('keydown',e=>{if(document.activeElement&&document.activeElement.isContentEditable)return;if(e.key==='ArrowRight')go(1);if(e.key==='ArrowLeft')go(-1);if(e.key==='Escape')$('#pres').classList.remove('open')});
$('#draft').onclick=async()=>{const b=$('#draft');b.disabled=true;b.textContent='Agent drafting…';await sleep(1200);
S[3]=['Proof: Klein Supply, a distributor like Northwind, cut prep by 58%',['Renewal prep fell from 41 to 17 minutes','Adopted by 30 reps in the first month','Also: Acme Logistics cut prep 62% in 6 weeks']];cur=3;
CR[1]=['Proof relevance',4.5,'Distributor case study now leads the proof slide.'];render();b.disabled=false;b.textContent='Draft with agent';toast('Demo — agent rewrote slide 4 with a distributor proof point')};
$('#score').onclick=async()=>{const b=$('#score');b.disabled=true;b.textContent='Scoring…';await sleep(1100);const o=CR.reduce((a,c)=>a+c[1],0)/CR.length;$('#overall').textContent=o.toFixed(1);$('#when').textContent='Scored just now against the buyer scorecard';b.disabled=false;b.textContent='Score deck';render()};
render();
