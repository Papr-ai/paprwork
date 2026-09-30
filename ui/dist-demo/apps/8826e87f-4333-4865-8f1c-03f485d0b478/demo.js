const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>e.classList.remove('show'),2300)}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ICPS={papr:{name:'AI-native B2B teams',sub:'50–500 people · building agents',leads:[
['Cloudline AI','cloudline.ai','Hiring',92,'Hiring 3 AI platform engineers for agent memory','You’ll own long-term memory and retrieval for our customer-facing agents.','cloudline.ai/careers/ai-platform','2 days ago','Actively staffing the exact problem Papr solves — memory is on their roadmap now.'],
['Stackwise','stackwise.dev','Funding',88,'Raised a $24M Series B to expand AI copilots','We are doubling down on copilots that remember every customer interaction.','techcrunch.com/2026/09/stackwise-series-b','5 days ago','Fresh budget earmarked for copilots with memory; buying window is open.'],
['Lumina Systems','luminasys.com','Pain signal',84,'VP Product posted about agents losing context','Our agents are brilliant for one session and amnesiac the next.','linkedin.com/posts/nina-patel-lumina','1 week ago','Public, first-person pain from the likely economic buyer.'],
['Vertex Labs','vertexlabs.io','Tech change',79,'Replacing their homegrown RAG pipeline','We’re sunsetting our in-house vector pipeline in Q4.','vertexlabs.io/blog/infra-2027','1 week ago','Rip-and-replace decision is already made; Papr competes for the replacement.'],
['Harbor Health','harborhealth.com','Launch',74,'Launched an AI care-navigation assistant','The assistant picks up where your last conversation left off.','harborhealth.com/newsroom/care-navigator','2 weeks ago','Continuity is the product promise — they need durable memory to keep it.']]},
revops:{name:'RevOps leaders',sub:'Mid-market distributors',leads:[
['Klein Supply','kleinsupply.co','Pain signal',81,'RevOps lead asked for renewal prep tooling','Renewal prep still means digging through a year of emails and call notes.','reddit.com/r/revops/comments/klein','3 days ago','Describes the Meetings + Focus story almost word for word.'],
['Beacon Freight','beaconfreight.com','Hiring',77,'Hiring a Head of AI Operations','Build durable context across our dispatcher and customer agents.','beaconfreight.com/jobs/head-ai-ops','4 days ago','New owner for AI tooling — first 90 days is when they buy.']]}};
const NEW=['Orbit Analytics','orbitanalytics.com','Funding',86,'Raised $18M to build an analyst agent','Our analyst agent needs to remember every question a customer has asked.','orbitanalytics.com/blog/series-a','just now','Memory is named as the core requirement in the launch post.'];
let icp='papr',sig='All',sel=0;
const list=()=>ICPS[icp].leads.filter(l=>sig==='All'||l[2]===sig);
function render(){const I=ICPS[icp],L=list();
$('#icps').innerHTML=Object.entries(ICPS).map(([k,v])=>`<button data-icp="${k}" class="${k===icp?'on':''}">${esc(v.name)} <span>${v.leads.length}</span></button>`).join('');
const sigs={};I.leads.forEach(l=>sigs[l[2]]=(sigs[l[2]]||0)+1);
$('#sigs').innerHTML=['All',...Object.keys(sigs)].map(s=>`<button data-sig="${esc(s)}" class="${s===sig?'on':''}">${esc(s)} <span>${s==='All'?I.leads.length:sigs[s]}</span></button>`).join('');
$('#icpname').textContent=I.name+' · '+I.sub;
const avg=Math.round(I.leads.reduce((a,l)=>a+l[3],0)/I.leads.length);
$('#metrics').innerHTML=[[I.leads.length,'Leads'],[I.leads.filter(l=>/day|just/.test(l[7])).length,'New this week'],[avg,'Avg fit score'],['100%','With a cited source']].map(m=>`<div class="card metric"><strong>${m[0]}</strong><span>${m[1]}</span></div>`).join('');
$('#leads').innerHTML=L.map((l,i)=>`<div class="card ${i===sel?'sel':''} fade" data-i="${i}" style="cursor:pointer"><div class="row"><h3 class="grow">${esc(l[0])} <span class="muted" style="font-weight:400">· ${esc(l[1])}</span></h3><span class="pill info">${esc(l[2])}</span><span class="score">${l[3]}</span></div><p>${esc(l[4])}</p><small>${esc(l[7])}</small></div>`).join('')||'<p class="muted">No leads for this signal.</p>';
const d=L[sel];$('#detail').innerHTML=d?`<small>Why now</small><h2 style="margin-top:6px">${esc(d[0])}</h2><blockquote>“${esc(d[5])}”</blockquote><div class="src">${esc(d[6])}</div><p class="muted" style="margin-top:12px">${esc(d[8])}</p><h2>Fit</h2><div class="bar"><i style="width:${d[3]}%"></i></div><p class="muted" style="font-size:12px">${d[3]} / 100 against the ${esc(ICPS[icp].name)} profile</p><button class="primary" id="send" style="width:100%;margin-top:18px">Send to Contact Enrichment</button><button id="dismiss" style="width:100%;margin-top:8px">Not a fit</button>`:'';
$$('[data-icp]').forEach(b=>b.onclick=()=>{icp=b.dataset.icp;sig='All';sel=0;render()});$$('[data-sig]').forEach(b=>b.onclick=()=>{sig=b.dataset.sig;sel=0;render()});
$$('[data-i]').forEach(c=>c.onclick=()=>{sel=+c.dataset.i;render()});
$('#send')&&($('#send').onclick=()=>toast('Demo — '+d[0]+' queued for Contact Enrichment'));$('#dismiss')&&($('#dismiss').onclick=()=>toast('Demo — feedback tunes future searches'))}
$('#find').onclick=async()=>{const b=$('#find');b.disabled=true;b.textContent='Searching signals…';await sleep(1300);
if(!ICPS.papr.leads.some(l=>l[0]===NEW[0]))ICPS.papr.leads.unshift(NEW);icp='papr';sig='All';sel=0;render();b.disabled=false;b.textContent='Find new leads';toast('Demo search — 1 new cited lead (sample data)')};
render();
