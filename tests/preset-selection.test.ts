import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const CLI = join(import.meta.dirname, '../dist/cli/index.js');

function fixture(multi = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-presets-')));
  const state = join(root, 'state');
  const tree = join(root, 'tree'); mkdirSync(tree);
  writeFileSync(join(tree, 'seed.mjs'), `import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);db.exec('DROP TABLE IF EXISTS marker; CREATE TABLE marker(value TEXT)');
db.prepare('INSERT INTO marker VALUES (?)').run(process.argv[3]);db.close();\n`);
  writeFileSync(join(tree, 'server.mjs'), `import {createServer} from 'node:http';createServer((q,s)=>s.end('ready')).listen(Number(process.env.PORT),'127.0.0.1');\n`);
  const datastore = {driver:'sqlite',create:'node seed.mjs "{{ns}}" "{{preset}}"',template:true,presets:['dev','alternate'],default_preset:{session:'dev',run:'dev'}};
  writeFileSync(join(tree, 'stack.yaml'), JSON.stringify({name:'preset-selection',services:{web:{run:'node server.mjs',port:'web',env:{PORT:'{{ports.web}}'},ready:{http:'/',timeout:10}}},datastores:{main:datastore,...(multi?{audit:datastore}:{})},checks:{alternate:{env:{BACKLOT_DS_MAIN:'{{datastores.main.url}}'},run:`node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.BACKLOT_DS_MAIN);process.exit(d.prepare("SELECT value FROM marker").get().value==="alternate"?0:1)'`}}}));
  const env = {...process.env,BACKLOT_STATE_DIR:state,BACKLOT_POOL_MAX:'1',BACKLOT_POOL_MAX_TOTAL:'1'};
  const cli = (args:string[]) => new Promise<{code:number;json:any;stdout:string;stderr:string}>(resolve=>{
    execFile(process.execPath,[CLI,...args,'--json'],{cwd:tree,env,timeout:25000},(error,stdout,stderr)=>{
      let json;try{json=JSON.parse(stdout);}catch{json=null;}resolve({code:error?Number(error.code??1):0,json,stdout,stderr});
    });
  });
  const value = (ctx:any,name='main') => { const db=new DatabaseSync(ctx.datastores[name].url);try{return db.prepare('SELECT value FROM marker').get()!.value;}finally{db.close();} };
  const mutate = (ctx:any,name='main') => { const db=new DatabaseSync(ctx.datastores[name].url);db.exec("UPDATE marker SET value='user-data'");db.close(); };
  const cleanup = async()=>{
    if(existsSync(join(state,'daemon.pid'))){const pid=Number(readFileSync(join(state,'daemon.pid'),'utf8'));await cli(['daemon','stop']);for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}}
    rmSync(root,{recursive:true,force:true});
  };
  return {root,state,tree,env,cli,value,mutate,cleanup};
}

it('switches an existing lease to a selected preset and refuses unknown names before changing data',async()=>{
  const f=fixture();try{
    const first=await f.cli(['up']);expect(first.code,first.stdout).toBe(0);expect(f.value(first.json)).toBe('dev');
    const next=await f.cli(['up','--preset','alternate']);expect(next.code,next.stdout).toBe(0);expect(f.value(next.json)).toBe('alternate');
    expect(next.json.bindDiagnostics.reasons).toContain('datastore-preset-changed');
    expect(next.json.envId).toBe(first.json.envId);expect(next.json.datastores.main.preset).toBe('alternate');
    f.mutate(next.json);
    const invalid=await f.cli(['up','--preset','missing']);expect(invalid.code,invalid.stdout).toBe(1);expect(f.value(next.json)).toBe('user-data');
  }finally{await f.cleanup();}
},30000);

it('rejects an unknown preset on a fresh request',async()=>{const f=fixture();try{
  const invalid=await f.cli(['up','--preset','missing']);expect(invalid.code,invalid.stdout).toBe(1);
  expect((await f.cli(['status'])).json.envs).toHaveLength(0);
}finally{await f.cleanup();}},30000);

it('refuses --preset on an unsupported verb as a usage error without touching the daemon',async()=>{const f=fixture();try{
  for(const verb of ['ctx','sync']){
    const bad=await f.cli([verb,'--preset','alternate']);
    expect(bad.code,bad.stderr).toBe(64);expect(bad.stdout).toBe('');expect(bad.stderr).toContain('--preset is supported by up, run and reset-data');
  }
  expect(existsSync(join(f.state,'daemon.pid'))).toBe(false);
  const invalid=await f.cli(['up','--preset','missing']);expect(invalid.code,invalid.stdout).toBe(1);expect(invalid.json.error.class).toBe('work-error');
}finally{await f.cleanup();}},30000);

it('labels a preset as changed only against a previously recorded selection',async()=>{const f=fixture();try{
  const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
  expect(first.json.bindDiagnostics.reasons).not.toContain('datastore-preset-changed');expect(first.json.datastores.main.preset).toBe('alternate');
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.audit=manifest.datastores.main;writeFileSync(path,JSON.stringify(manifest));
  f.mutate(first.json);
  const added=await f.cli(['up']);expect(added.code,added.stdout).toBe(0);
  expect(added.json.bindDiagnostics.reasons).not.toContain('datastore-preset-changed');
  expect(added.json.datastores.audit.preset).toBe('dev');expect(f.value(added.json,'audit')).toBe('dev');expect(f.value(added.json)).toBe('user-data');
  const changed=await f.cli(['up','--preset','audit=alternate']);expect(changed.code,changed.stdout).toBe(0);
  expect(changed.json.bindDiagnostics.reasons).toContain('datastore-preset-changed');expect(f.value(changed.json,'audit')).toBe('alternate');expect(f.value(changed.json)).toBe('user-data');
}finally{await f.cleanup();}},30000);


it('retains selection on warm up, sync, reset and daemon restart; a fresh holder gets the default',async()=>{
  const f=fixture();try{
    const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
    f.mutate(first.json);
    const same=await f.cli(['up']);expect(same.code,same.stdout).toBe(0);expect(f.value(same.json)).toBe('user-data');expect(same.json.datastores.main.preset).toBe('alternate');
    expect(same.json.bindDiagnostics.reuse).toBe('reused');
    const synced=await f.cli(['sync']);expect(synced.code,synced.stdout).toBe(0);expect(f.value(synced.json)).toBe('user-data');
    const reset=await f.cli(['reset-data']);expect(reset.code,reset.stdout).toBe(0);expect(f.value(reset.json)).toBe('alternate');
    const pristine=await f.cli(['up','--pristine']);expect(pristine.code,pristine.stdout).toBe(0);expect(f.value(pristine.json)).toBe('alternate');
    const pid=Number(readFileSync(join(f.state,'daemon.pid'),'utf8'));await f.cli(['daemon','stop']);
    for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
    const restarted=await f.cli(['up']);expect(restarted.code,restarted.stdout).toBe(0);expect(restarted.json.datastores.main.preset).toBe('alternate');expect(f.value(restarted.json)).toBe('alternate');
    await f.cli(['release']);
    const fresh=await f.cli(['up','--holder','new']);expect(fresh.code,fresh.stdout).toBe(0);expect(f.value(fresh.json)).toBe('dev');expect(fresh.json.datastores.main.preset).toBe('dev');
  }finally{await f.cleanup();}
},30000);

it('selects individual datastores and rejects ambiguous or duplicate choices',async()=>{
  const f=fixture(true);try{
    const first=await f.cli(['up']);expect(first.code,first.stdout).toBe(0);f.mutate(first.json,'audit');
    const next=await f.cli(['up','--preset','main=alternate']);expect(next.code,next.stdout).toBe(0);expect(f.value(next.json)).toBe('alternate');expect(f.value(next.json,'audit')).toBe('user-data');
    for(const args of [['alternate'],['main=dev','main=alternate'],['nope=dev']]){
      const bad=await f.cli(['up',...args.flatMap(v=>['--preset',v])]);expect(bad.code,bad.stdout).toBe(1);expect(f.value(next.json,'audit')).toBe('user-data');
    }
    const both=await f.cli(['up','--preset','main=dev','--preset','audit=alternate']);expect(both.code,both.stdout).toBe(0);expect(f.value(both.json)).toBe('dev');expect(f.value(both.json,'audit')).toBe('alternate');
    const reset=await f.cli(['reset-data','--preset','main=alternate']);expect(reset.code,reset.stdout).toBe(0);expect(f.value(reset.json)).toBe('alternate');
  }finally{await f.cleanup();}
},30000);

it('uses the selected preset for synchronous and detached checks',async()=>{
  const f=fixture();try{
    const run=await f.cli(['run','alternate','--preset','alternate']);expect(run.code,JSON.stringify(run)).toBe(0);
    const detached=await f.cli(['run','alternate','--preset','alternate','--detach']);expect(detached.code,detached.stdout).toBe(0);
    let job;
    for(let i=0;i<100;i++){job=await f.cli(['job',detached.json.jobId]);if(job.json.state==='done')break;await new Promise(r=>setTimeout(r,100));}
    expect(job!.json.state).toBe('done');expect(job!.json.verdict.ok).toBe(true);
    const invalid=await f.cli(['run','alternate','--preset','missing','--detach']);expect(invalid.code,invalid.stdout).toBe(1);
  }finally{await f.cleanup();}
},30000);

function mcp(f:ReturnType<typeof fixture>){
  const p=spawn(process.execPath,[join(import.meta.dirname,'../dist/mcp/index.js')],{cwd:f.tree,env:f.env,stdio:['pipe','pipe','ignore']});
  let buf='';let id=0;const pending=new Map<number,(v:any)=>void>();
  p.stdout.on('data',d=>{buf+=String(d);let n;while((n=buf.indexOf('\n'))>=0){const line=buf.slice(0,n);buf=buf.slice(n+1);if(line.trim()){const v=JSON.parse(line);pending.get(v.id)?.(v);}}});
  const call=(name:string,args:unknown)=>new Promise<any>((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(new Error('MCP request timed out')),15000);pending.set(n,v=>{clearTimeout(timer);pending.delete(n);resolve(v);});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method:'tools/call',params:{name,arguments:args}})+'\n');});
  const close=async()=>{p.kill();await new Promise<void>(resolve=>p.once('exit',()=>resolve()));};
  return {call,close};
}

it('accepts and validates preset maps through MCP',async()=>{
  const f=fixture();const m=mcp(f);
  try{
    const response=await m.call('backlot_up',{cwd:f.tree,holder:'mcp',presets:{main:'alternate'}});
    expect(response.result?.isError,JSON.stringify(response)).not.toBe(true);
    const context=JSON.parse(response.result.content[0].text);expect(f.value(context)).toBe('alternate');expect(context.datastores.main.preset).toBe('alternate');
    const invalid=await m.call('backlot_up',{cwd:f.tree,holder:'mcp',presets:{main:'missing'}});expect(invalid.result.isError).toBe(true);expect(f.value(context)).toBe('alternate');
  }finally{await m.close();await f.cleanup();}
},30000);

it('journals a detached run failure as a job verdict unless explicit presets are refused up front',async()=>{const f=fixture();const m=mcp(f);try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.main.default_preset.run='missing';writeFileSync(path,JSON.stringify(manifest));
  const detached=await f.cli(['run','alternate','--detach']);expect(detached.code,detached.stdout).toBe(0);expect(typeof detached.json.jobId).toBe('string');
  let job;
  for(let i=0;i<100;i++){job=await f.cli(['job',detached.json.jobId]);if(job.json.state==='done')break;await new Promise(r=>setTimeout(r,100));}
  expect(job!.json.state).toBe('done');expect(job!.json.verdict.ok).toBe(false);expect(job!.json.verdict.failure.class).toBe('work-error');expect(job!.json.verdict.failure.message).toContain('missing');
  const refused=await m.call('backlot_run_detach',{cwd:f.tree,check:'alternate',presets:{main:'missing'}});expect(refused.result.isError,JSON.stringify(refused)).toBe(true);
  expect((await f.cli(['job','ls'])).json.jobs.filter((j:any)=>j.id!==detached.json.jobId)).toHaveLength(0);
  expect((await f.cli(['status'])).json.envs).toHaveLength(0);
}finally{await m.close();await f.cleanup();}},30000);

it('treats an empty presets catalog like an omitted one',async()=>{const f=fixture();try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.main.presets=[];writeFileSync(path,JSON.stringify(manifest));
  const declared=await f.cli(['up']);expect(declared.code,declared.stdout).toBe(0);expect(f.value(declared.json)).toBe('dev');expect(declared.json.datastores.main.preset).toBe('dev');
  const bad=await f.cli(['up','--preset','alternate']);expect(bad.code,bad.stdout).toBe(1);expect(f.value(declared.json)).toBe('dev');
  await f.cli(['release']);
  delete manifest.datastores.main.default_preset;writeFileSync(path,JSON.stringify(manifest));
  const implicit=await f.cli(['up']);expect(implicit.code,implicit.stdout).toBe(0);expect(f.value(implicit.json)).toBe('default');expect(implicit.json.datastores.main.preset).toBe('default');
}finally{await f.cleanup();}},30000);


it('rejects invalid declared defaults before allocating an environment',async()=>{const f=fixture();try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.main.default_preset.session='missing';writeFileSync(path,JSON.stringify(manifest));
  const invalid=await f.cli(['up']);expect(invalid.code,invalid.stdout).toBe(1);expect((await f.cli(['status'])).json.envs).toHaveLength(0);
}finally{await f.cleanup();}},30000);

it('preserves manifest-declared defaults when the optional catalog is omitted',async()=>{const f=fixture();try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));delete manifest.datastores.main.presets;writeFileSync(path,JSON.stringify(manifest));
  const up=await f.cli(['up']);expect(up.code,up.stdout).toBe(0);expect(f.value(up.json)).toBe('dev');
  const bad=await f.cli(['up','--preset','alternate']);expect(bad.code,bad.stdout).toBe(1);expect(f.value(up.json)).toBe('dev');
}finally{await f.cleanup();}},30000);


it('reports a completed preset restore even when a later datastore fails',async()=>{const f=fixture(true);try{
  const first=await f.cli(['up']);expect(first.code,first.stdout).toBe(0);
  const seed=join(f.tree,'seed.mjs');writeFileSync(seed,"if(process.argv[2].includes('audit-alternate'))process.exit(1);\n"+readFileSync(seed,'utf8'));
  const failed=await f.cli(['up','--preset','main=alternate','--preset','audit=alternate']);expect(failed.code,failed.stdout).toBe(1);
  const ctx=await f.cli(['ctx']);expect(ctx.code,ctx.stdout).toBe(0);expect(ctx.json.datastores.main.preset).toBe('alternate');expect(f.value(ctx.json)).toBe('alternate');
  expect(ctx.json.datastores.audit.preset).toBe('dev');expect(f.value(ctx.json,'audit')).toBe('dev');
}finally{await f.cleanup();}},30000);
