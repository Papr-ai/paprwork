const Data = {
  APP_ID: 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c',
  SRC_ID: '2cafb2e9-696b-42db-98fa-5d605977123c:Daily Brief Generator (2cafb2e9)',
  async query(sql) {
    const r = await fetch('/api/db/query', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({appId:this.APP_ID, sourceId:this.SRC_ID, sql})
    });
    return (await r.json())?.rows || [];
  },
  async load(date) {
    try {
      const sql = date
        ? `SELECT brief_json FROM briefs WHERE date='${date}' LIMIT 1`
        : `SELECT brief_json FROM briefs ORDER BY date DESC LIMIT 1`;
      const rows = await this.query(sql);
      if (rows[0]?.brief_json) return JSON.parse(rows[0].brief_json);
    } catch(e) {}
    return Data.sample();
  },
  async dates() {
    try {
      const rows = await this.query('SELECT DISTINCT date FROM briefs ORDER BY date DESC LIMIT 30');
      return rows.map(r => r.date);
    } catch(e) { return []; }
  },
  sample() {
    const d = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    return { hero:{date:d,title:'Daily Brief',subtitle:'5 meetings · 2 external',
      stats:[{value:'5',label:'meetings'},{value:'2',label:'external'},{value:'3',label:'action items'}]},
    sections:[
      {type:'timeline',title:'Today',items:[
        {time:'8:00',title:'Weekly Ops Review',tags:['internal']},
        {time:'9:30',title:'Papr Daily',tags:['internal']},
        {time:'11:30',title:'Papr × Techstars',tags:['internal']},
        {time:'12:00',title:'Eric Immermann & Zachary Fischer — Perficient',tags:['external'],
          detail:{Intel:'Large digital consultancy — potential channel partner.',
            Angle:'Position Papr as infra for their AI practice.',
            'The Ask':'Propose joint pilot with one enterprise client.'}},
        {time:'1:30',title:'Ajay Sharma',tags:['external'],
          detail:{Intel:'Discovery call. No prior history.',
            Angle:'Paprwork if non-technical, Memory if engineering leader.',
            'The Ask':'Qualify ICP fit. Book deep dive or demo.'}}]},
      {type:'priorities',title:'Focus This Week',items:[
        {rank:1,title:'Close Capital One → pilot',why:'Highest-leverage. Warm intro made. Demo Monday.'},
        {rank:2,title:'DeepTrust → enterprise tier',why:'Active customer. Partnership review Tuesday.'},
        {rank:3,title:'5 new discovery calls',why:'Pipeline building with better ICP targeting.'}]},
      {type:'tracker',title:'OKR Alignment',items:[
        {label:'Deep dive calls',current:2,target:5,unit:'calls',context:'Capital One Mon + DeepTrust Tue = 4'},
        {label:'Discovery calls',current:1,target:5,unit:'/week',context:'Ajay today, Firas Wed, 3 more needed'},
        {label:'Paprwork feedback',current:2,target:5,unit:'users',context:'Need 3 more sessions this week'}]},
      {type:'alerts',title:"Don't Forget",items:[
        {severity:'high',message:'Capital One demo Monday — prep agent memory walkthrough',action:'Build demo flow tonight'},
        {severity:'medium',message:'DeepTrust review dashboard exists — check before Tue',action:'Open Partnership Review app'}]},
      {type:'freeform',title:'My Take',
        content:'<strong>This week is about conversion, not discovery.</strong> Capital One is warm, DeepTrust is already using the product, Verify is in play. <em>Capital One is your best pilot shot.</em> Prep that demo tonight.'}
    ]};
  }
};