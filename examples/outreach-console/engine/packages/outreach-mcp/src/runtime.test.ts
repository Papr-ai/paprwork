import { expect, it } from 'vitest';
import { bootstrapWorkspace, authenticate, createEngine, prepareOperation } from '@splitin/outreach-core';
import { openSqliteDatabase } from '@splitin/outreach-store-sqlite';
import { invokeTool } from './tools';
function fixture() {
 const db = openSqliteDatabase(':memory:');
 const engine = createEngine({db, adapters:[], secrets:{get:async()=>{throw Error('secret');}},workerId:'review',now:()=>1000});
 bootstrapWorkspace(db,{workspaceId:'w',name:'w',adminRef:'test:u',adminName:'u'},1000);
 const auth = ()=>authenticate(db,'w','test:u','mcp','review');
 db.exec("INSERT INTO campaigns (id,workspace_id,name,purpose,status,created_at,updated_at) VALUES ('c','w','c','manual_correspondence','active',0,0)");
 const op=prepareOperation(engine,auth(),{kind:'campaign.pause',targetId:'c',reason:'approved reason'});
 const args={operationId:op.operationId,operationHash:op.operationHash};
 return {db,engine,auth,args};
}
it('simultaneous confirmations consume exactly once',async()=>{
 const f=fixture(); let confirmations=0; let release!:()=>void; const gate=new Promise<void>(r=>release=r);
 const context={engine:f.engine,authenticate:f.auth,confirm:async()=>{confirmations++;if(confirmations===2)release();await gate;return true;}};
 try {const results=await Promise.allSettled([invokeTool(context,'outreach_commit',f.args),invokeTool(context,'outreach_commit',f.args)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);}
 finally{f.db.close();}
});
it('rejects stored payload mutation under unchanged hash',async()=>{
 const f=fixture();
 try {await expect(invokeTool({engine:f.engine,authenticate:f.auth,confirm:async()=>{f.db.prepare('UPDATE prepared_operations SET payload=? WHERE id=?').run(JSON.stringify({kind:'campaign.pause',targetId:'c',reason:'unapproved replacement'}),f.args.operationId);return true;}},'outreach_commit',f.args)).rejects.toThrow('integrity');
 expect(f.db.prepare('SELECT paused_reason FROM campaigns WHERE id=?').get<{paused_reason:string}>('c')?.paused_reason).toBeNull();}
 finally{f.db.close();}
});

import { makeDomainEnv, PLAYBOOK } from './runtime.test-util';
import { createCampaign } from '@splitin/outreach-core';
it.each([false,true])('headless activation fails closed without unsubscribe runtime (explicit token %s)',async(explicitToken)=>{
 const f=await makeDomainEnv();
 try{
 f.contact('recipient@example.org',{firstName:'Recipient'});
 if(explicitToken)f.engine.db.prepare("UPDATE templates SET body_text=body_text || ?, required_tokens = ? WHERE name='intro'").run(' {{unsubscribe_url}}', '["first_name","unsubscribe_url"]');
 const campaign=createCampaign(f.engine,f.admin,{name:'review',playbook:PLAYBOOK.replace('approval: first_batch_then_campaign','approval: none').replace('unsubscribe: link', explicitToken ? 'unsubscribe: reply' : 'unsubscribe: link'),providerAccountId:f.accountId});
 const headless=createEngine({db:f.engine.db,adapters:[],secrets:{get:async()=>{throw Error('secret');}},workerId:'mcp',now:f.now});
 const context={engine:headless,authenticate:()=>authenticate(f.engine.db,'ws','test:admin','mcp','review'),confirm:async()=>true};
 const op=await invokeTool(context,'outreach_campaign_prepare',{campaignId:campaign.campaignId}) as {operationId:string;operationHash:string};
 await expect(invokeTool(context,'outreach_commit',{operationId:op.operationId,operationHash:op.operationHash})).rejects.toThrow();
 expect(f.engine.db.prepare('SELECT status FROM campaigns WHERE id=?').get<{status:string}>(campaign.campaignId)?.status).toBe('draft');
 expect(f.engine.db.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE campaign_id=?').get<{n:number}>(campaign.campaignId)?.n).toBe(0);
 expect(f.engine.db.prepare('SELECT COUNT(*) AS n FROM scheduled_actions WHERE campaign_id=?').get<{n:number}>(campaign.campaignId)?.n).toBe(0);
 expect(f.engine.db.prepare('SELECT committed_at FROM prepared_operations WHERE id=?').get<{committed_at:number|null}>(op.operationId)?.committed_at).toBeNull();
 }finally{f.engine.db.close();}
});

import { prepareActivation, commitActivation } from '@splitin/outreach-core';
it('manual completion rolls back when next email needs unavailable unsubscribe runtime',async()=>{
 const f=await makeDomainEnv();
 try{
 f.contact('recipient@example.org');
 const playbook=PLAYBOOK.replace('approval: first_batch_then_campaign','approval: none').split('  steps:')[0]+`  steps:
    - { id: social, type: manual.task, channel: linkedin, template: social@1 }
    - { id: intro, type: email.send, template: intro@1 }
`;
 const campaign=createCampaign(f.engine,f.admin,{name:'manual review',playbook,providerAccountId:f.accountId});
 const activation=prepareActivation(f.engine,f.admin,campaign.campaignId);
 commitActivation(f.engine,f.admin,{campaignId:campaign.campaignId,operationHash:activation.operationHash});
 const action=f.engine.db.prepare('SELECT id,enrollment_id FROM scheduled_actions WHERE campaign_id=?').get<{id:string;enrollment_id:string}>(campaign.campaignId)!;
 f.engine.db.prepare("INSERT INTO manual_tasks(id,workspace_id,action_id,enrollment_id,channel,draft_text,status,created_at) VALUES('task','ws',?,?,'linkedin','draft','open',?)").run(action.id,action.enrollment_id,f.now());
 const headless=createEngine({db:f.engine.db,adapters:[],secrets:{get:async()=>{throw Error('secret');}},workerId:'mcp',now:f.now});
 const context={engine:headless,authenticate:()=>authenticate(f.engine.db,'ws','test:admin','mcp','review'),confirm:async()=>true};
 const op=await invokeTool(context,'outreach_task_done',{taskId:'task',outcome:'done'}) as {operationId:string;operationHash:string};
 await expect(invokeTool(context,'outreach_commit',{operationId:op.operationId,operationHash:op.operationHash})).rejects.toThrow();
 expect(f.engine.db.prepare("SELECT status FROM manual_tasks WHERE id='task'").get<{status:string}>()?.status).toBe('open');
 expect(f.engine.db.prepare("SELECT COUNT(*) AS n FROM scheduled_actions WHERE campaign_id=? AND kind='email.send'").get<{n:number}>(campaign.campaignId)?.n).toBe(0);
 expect(f.engine.db.prepare('SELECT committed_at FROM prepared_operations WHERE id=?').get<{committed_at:number|null}>(op.operationId)?.committed_at).toBeNull();
 }finally{f.engine.db.close();}
});
