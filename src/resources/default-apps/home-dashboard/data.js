const Data = {
  APP_ID: 'bbb7e17e-c810-47ef-b9ce-c8a83c0cd16c',
  LEGACY_JOB_ID: '2cafb2e9-696b-42db-98fa-5d605977123c',
  _jobId: null,
  todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },
  async resolveJobId() {
    if (this._jobId) return this._jobId;
    if (typeof App !== 'undefined' && App.JOB_ID) {
      this._jobId = App.JOB_ID;
      return this._jobId;
    }
    try {
      const r = await fetch('default-job-id.txt');
      if (r.ok) {
        const id = (await r.text()).trim();
        if (id) {
          this._jobId = id;
          return id;
        }
      }
    } catch (e) { /* bundled file added on install */ }
    this._jobId = this.LEGACY_JOB_ID;
    return this._jobId;
  },
  async getSrcId() {
    const jobId = await this.resolveJobId();
    const short = jobId.slice(0, 8);
    return `${jobId}:Daily Brief Generator (${short})`;
  },
  async query(sql) {
    const r = await fetch('/api/db/query', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ appId: this.APP_ID, sql })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'Database query failed');
    return data?.rows || [];
  },
  async load(date) {
    try {
      const sql = date
        ? `SELECT brief_json FROM briefs WHERE date='${date}' AND brief_json IS NOT NULL LIMIT 1`
        : `SELECT brief_json FROM briefs WHERE brief_json IS NOT NULL ORDER BY date DESC LIMIT 1`;
      const rows = await this.query(sql);
      if (rows[0]?.brief_json) return JSON.parse(rows[0].brief_json);
    } catch(e) {}
    return Data.sample();
  },
  async dates() {
    try {
      const rows = await this.query('SELECT DISTINCT date FROM briefs WHERE brief_json IS NOT NULL ORDER BY date DESC LIMIT 30');
      return rows.map(r => r.date);
    } catch(e) { return []; }
  },
  sample() {
    const d = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    return { 
      _isSample: true, // Mark this as sample data
      hero:{date:d,title:'Welcome to Paprwork',subtitle:'Your AI assistant is ready',
      stats:[{value:'✓',label:'account'},{value:'✓',label:'API key'},{value:'∞',label:'possibilities'}]},
    sections:[
      {type:'priorities',title:'Next Steps',items:[
        {rank:1,title:'Tell me what you need help with',why:'Open chat and describe your workflow. I\'ll help you set up integrations, create jobs, or build apps — just ask.'},
        {rank:2,title:'Connect your tools (optional)',why:'Want calendar, LinkedIn, or email in your brief? Just ask me: "Connect my Google Calendar" or "Track my LinkedIn activity".'},
        {rank:3,title:'Create your first mini-app',why:'Once you have some jobs running, we can build custom dashboards to visualize your data. Ask me: "Create a dashboard for my sales pipeline".'}]},
      {type:'timeline',title:'What Happens Next',items:[
        {time:'After we chat',title:'I understand your context',tags:['milestone'],
          detail:{
            What:'Every conversation helps me learn your goals, priorities, and workflow.',
            Memory:'I remember past discussions and use them to make better recommendations.',
            Better:'The more we talk, the more helpful I become. Think of me as your chief of staff.'}},
        {time:'After 1st job',title:'Automation kicks in',tags:['milestone'],
          detail:{
            What:'Jobs run in the background without you thinking about them.',
            Examples:'Sync calendar every 15 min, track LinkedIn weekly, pull CRM data daily.',
            Power:'Jobs can query APIs, process data, and feed other jobs. Chain them together for complex workflows.'}},
        {time:'After 1st app',title:'You get a custom dashboard',tags:['milestone'],
          detail:{
            What:'Mini-apps visualize your data and let you take actions.',
            Examples:'Sales pipeline tracker, meeting prep dashboard, weekly review.',
            This:'This home dashboard is a mini-app. You can create specialized ones for any workflow.'}}]},
      {type:'alerts',title:'Quick Actions',items:[
        {severity:'info',message:'Click "Generate My Real Brief" above',action:'Creates your first personalized brief from our conversation so far'},
        {severity:'info',message:'Open chat and say hi',action:'Try: "What can you help me with?" or "I want to automate my [workflow]"'}]},
      {type:'freeform',title:'How This Works',
        content:'<strong>You\'re not configuring software — you\'re talking to an assistant.</strong> No forms, no settings screens, no complex setup. Just tell me what you need: <em>"Sync my calendar"</em>, <em>"Track LinkedIn connections"</em>, <em>"Build a sales dashboard"</em>. I\'ll create the jobs, apps, and automations. <strong>Everything happens through conversation.</strong>'}
    ]};
  }
};
