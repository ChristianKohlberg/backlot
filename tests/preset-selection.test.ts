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
  writeFileSync(join(tree, 'stack.yaml'), JSON.stringify({name:'preset-selection',services:{web:{run:'node server.mjs',port:'web',env:{PORT:'{{ports.web}}'},ready:{http:'/',timeout:10}}},datastores:{main:datastore,...(multi?{audit:datastore}:{})}}));
  const env = {...process.env,BACKLOT_STATE_DIR:state,BACKLOT_POOL_MAX_TOTAL:'1'};
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
    expect(next.json.bindDiagnostics.reloaded).toEqual(['main']);
    expect(next.json.bindDiagnostics.reasons).toEqual([]);
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
  for(const verb of ['ctx','warm','help','--help','version','--version']){
    const bad=await f.cli([verb,'--preset','alternate']);
    expect(bad.code,bad.stderr).toBe(64);expect(bad.stdout).toBe('');expect(bad.stderr).toContain('--preset is supported by up, reset-data and db');
  }
  expect(existsSync(join(f.state,'daemon.pid'))).toBe(false);
  const invalid=await f.cli(['up','--preset','missing']);expect(invalid.code,invalid.stdout).toBe(1);expect(invalid.json.error.class).toBe('work-error');
}finally{await f.cleanup();}},30000);

it('creates an added datastore with its default and reloads only the one that is named',async()=>{const f=fixture();try{
  const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
  expect(first.json.bindDiagnostics.reloaded).toEqual(['main']);expect(first.json.datastores.main.preset).toBe('alternate');
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.audit=manifest.datastores.main;writeFileSync(path,JSON.stringify(manifest));
  f.mutate(first.json);
  const added=await f.cli(['up']);expect(added.code,added.stdout).toBe(0);
  expect(added.json.bindDiagnostics.reloaded).toEqual([]);
  expect(added.json.datastores.audit.preset).toBe('dev');expect(f.value(added.json,'audit')).toBe('dev');expect(f.value(added.json)).toBe('user-data');
  const changed=await f.cli(['up','--preset','audit=alternate']);expect(changed.code,changed.stdout).toBe(0);
  expect(changed.json.bindDiagnostics.reloaded).toEqual(['audit']);expect(f.value(changed.json,'audit')).toBe('alternate');expect(f.value(changed.json)).toBe('user-data');
}finally{await f.cleanup();}},30000);

it('keeps what each store holds on warm up, reset, pristine, daemon restart and a fresh holder',async()=>{
  const f=fixture();try{
    const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
    f.mutate(first.json);
    const same=await f.cli(['up']);expect(same.code,same.stdout).toBe(0);expect(f.value(same.json)).toBe('user-data');expect(same.json.datastores.main.preset).toBe('alternate');
    expect(same.json.bindDiagnostics.reuse).toBe('reused');
    const reset=await f.cli(['reset-data']);expect(reset.code,reset.stdout).toBe(0);expect(f.value(reset.json)).toBe('alternate');
    const pristine=await f.cli(['up','--pristine']);expect(pristine.code,pristine.stdout).toBe(0);expect(f.value(pristine.json)).toBe('alternate');
    const pid=Number(readFileSync(join(f.state,'daemon.pid'),'utf8'));await f.cli(['daemon','stop']);
    for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
    const restarted=await f.cli(['up']);expect(restarted.code,restarted.stdout).toBe(0);expect(restarted.json.datastores.main.preset).toBe('alternate');expect(f.value(restarted.json)).toBe('alternate');
    await f.cli(['release']);
    // A fresh holder does not reset the data to the default (decision 0034).
    const fresh=await f.cli(['up','--holder','new']);expect(fresh.code,fresh.stdout).toBe(0);expect(f.value(fresh.json)).toBe('alternate');expect(fresh.json.datastores.main.preset).toBe('alternate');
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

it('treats an empty presets catalog like an omitted one',async()=>{const f=fixture();try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));manifest.datastores.main.presets=[];writeFileSync(path,JSON.stringify(manifest));
  const declared=await f.cli(['up']);expect(declared.code,declared.stdout).toBe(0);expect(f.value(declared.json)).toBe('dev');expect(declared.json.datastores.main.preset).toBe('dev');
  const bad=await f.cli(['up','--preset','alternate']);expect(bad.code,bad.stdout).toBe(1);expect(f.value(declared.json)).toBe('dev');
  await f.cli(['release']);
  delete manifest.datastores.main.default_preset;writeFileSync(path,JSON.stringify(manifest));
  // The held preset left the catalog: the data is still KEPT, never reset behind the caller's back…
  const implicit=await f.cli(['up']);expect(implicit.code,implicit.stdout).toBe(0);expect(f.value(implicit.json)).toBe('dev');expect(implicit.json.datastores.main.preset).toBe('dev');
  // …and a reset, which restores anyway, restores the default the catalog now offers.
  const reset=await f.cli(['reset-data']);expect(reset.code,reset.stdout).toBe(0);expect(f.value(reset.json)).toBe('default');expect(reset.json.datastores.main.preset).toBe('default');
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

it('keeps what the store holds for a fresh holder through an early upkeep failure and retry',async()=>{const f=fixture();try{
  const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
  await f.cli(['release']);
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));
  manifest.upkeep=[{when:'seed.mjs',run:'exit 1'}];writeFileSync(path,JSON.stringify(manifest));
  const failed=await f.cli(['up','--holder','next']);expect(failed.code,failed.stdout).toBe(1);
  const actual=await f.cli(['ctx','--holder','next']);expect(actual.json.datastores.main.preset).toBe('alternate');
  expect(f.value(first.json)).toBe('alternate');
  delete manifest.upkeep;writeFileSync(path,JSON.stringify(manifest));
  const retry=await f.cli(['up','--holder','next']);expect(retry.code,retry.stdout).toBe(0);
  expect(retry.json.envId).toBe(first.json.envId);expect(retry.json.datastores.main.preset).toBe('alternate');expect(f.value(retry.json)).toBe('alternate');
}finally{await f.cleanup();}},30000);

it('does not remember a --preset whose bind failed: a pristine retry restores what the store held',async()=>{const f=fixture();try{
  const first=await f.cli(['up']);expect(first.code,first.stdout).toBe(0);
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));
  manifest.upkeep=[{when:'seed.mjs',run:'exit 1'}];writeFileSync(path,JSON.stringify(manifest));
  const failed=await f.cli(['up','--pristine','--preset','alternate']);expect(failed.code,failed.stdout).toBe(1);
  const pid=Number(readFileSync(join(f.state,'daemon.pid'),'utf8'));await f.cli(['daemon','stop']);
  for(let i=0;i<200;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}
  delete manifest.upkeep;writeFileSync(path,JSON.stringify(manifest));
  const retry=await f.cli(['up']);expect(retry.code,retry.stdout).toBe(0);
  expect(retry.json.datastores.main.preset).toBe('dev');expect(f.value(retry.json)).toBe('dev');
  const explicit=await f.cli(['up','--preset','alternate']);expect(explicit.code,explicit.stdout).toBe(0);expect(f.value(explicit.json)).toBe('alternate');
}finally{await f.cleanup();}},30000);

it('validates a reusing up, and keeps the data when the preset it holds leaves the catalog',async()=>{const f=fixture();try{
  const path=join(f.tree,'stack.yaml');const manifest=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(join(f.tree,'content.txt'),'original');
  const first=await f.cli(['up','--preset','alternate']);expect(first.code,first.stdout).toBe(0);
  const projected=await f.cli(['up']);expect(projected.code,projected.stdout).toBe(0);expect(projected.json.bindDiagnostics.reuse).toBe('reused');
  f.mutate(first.json);
  manifest.datastores.main.default_preset.session='missing';writeFileSync(path,JSON.stringify(manifest));
  writeFileSync(join(f.tree,'content.txt'),'changed');
  const invalid=await f.cli(['up']);expect(invalid.code,invalid.stdout).toBe(1);expect(invalid.json.error.message).toContain('missing');
  expect(f.value(first.json)).toBe('user-data');
  manifest.datastores.main.default_preset.session='dev';manifest.datastores.main.presets=['dev'];writeFileSync(path,JSON.stringify(manifest));
  const synced=await f.cli(['up']);expect(synced.code,synced.stdout).toBe(0);
  expect(synced.json.bindDiagnostics.reasons).toContain('manifest-changed');
  expect(synced.json.datastores.main.preset).toBe('alternate');expect(f.value(synced.json)).toBe('user-data');
}finally{await f.cleanup();}},30000);
