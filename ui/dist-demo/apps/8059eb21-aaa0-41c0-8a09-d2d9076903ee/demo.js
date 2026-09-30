const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let I=[
['Agents forget','r/LocalLLaMA',412,'Every new session my agent forgets the project conventions. I paste the same 2k-token preamble 20 times a day.','Validates Papr’s core promise: persistent memory across sessions.'],
['Context sprawl','r/SaaS',188,'Our customer context lives in HubSpot, Gong, Slack and Notion. No tool sees all of it, so every AI answer is half right.','Cross-tool memory is the buying trigger — lead with integrations.'],
['Agents forget','r/ChatGPTPro',236,'Custom GPT memory is a black box. I can’t see what it remembers or fix it when it’s wrong.','Inspectable, editable memory is a differentiator — show the graph.'],
['Trust & privacy','r/sales',97,'Legal won’t let us put deal notes into a chatbot that trains on them.','Lead security messaging with workspace scoping and no-training guarantees.'],
['Setup cost','r/LocalLLaMA',154,'I spent a weekend wiring a vector DB + reranker for memory and it still retrieves the wrong notes.','Position the Papr API as “memory in one call” for builders.'],
['Context sprawl','r/sales',121,'Prep for a renewal = 40 minutes digging through old emails and call notes.','Great fit for Meetings Manager + Focus daily brief story.']];
let theme='All';
function render(){const t={};I.forEach(x=>t[x[0]]=(t[x[0]]||0)+1);
$('#themes').innerHTML=['All',...Object.keys(t)].map(k=>`<button data-t="${esc(k)}" class="${k===theme?'on':''}">${esc(k)} <span>${k==='All'?I.length:t[k]}</span></button>`).join('');
$$('[data-t]').forEach(b=>b.onclick=()=>{theme=b.dataset.t;render()});$('#n').textContent=I.length;
$('#list').innerHTML=I.filter(x=>theme==='All'||x[0]===theme).map(x=>`<div class="card fade"><div class="row"><span class="pill info">${esc(x[0])}</span><small class="grow">${esc(x[1])} · ▲ ${x[2]}</small></div><blockquote>“${esc(x[3])}”</blockquote><p class="muted"><b style="color:var(--text)">So what:</b> ${esc(x[4])}</p></div>`).join('')}
$('#scan').onclick=async()=>{$('#scan').disabled=true;$('#scan').textContent='Scanning…';await sleep(1100);
I.unshift(['Trust & privacy','r/ChatGPTPro',64,'I want my assistant to remember my clients, but only mine — not my whole company’s.','Per-user ACLs on memory are a must-have for teams.']);theme='All';render();
$('#scan').disabled=false;$('#scan').textContent='Scan now';toast('Demo scan — 1 new insight (sample data)')};
render();
