import { afterAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { statSync } from 'node:fs';
import { confirmedMissing } from '../src/core/existence.js';
import { makeCtx, sleep, waitFor, type Ctx } from './support/context.js';

const contexts: Ctx[] = [];
afterAll(() => { for (const c of contexts) c.dispose(); });
const SERVER = `import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
const srv=createServer((req,res)=>{
 if(req.url==='/events') {
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  const t=setInterval(()=>res.write('data: hello\\n\\n'),150);
  res.on('close',()=>clearInterval(t));
 } else res.end('ok');
});
srv.on('upgrade',(req,s)=>{
 const key=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');
 const t=setInterval(()=>s.write(Buffer.from([0x81,2,104,105])),150);
 s.on('error',()=>{}); s.on('close',()=>clearInterval(t));
});
srv.listen(Number(process.env.PORT),'127.0.0.1');`;
async function setup() {
 const c=makeCtx({BACKLOT_SERVICE_IDLE_MS:'1200'}); contexts.push(c);
 const wt=c.worktree({'runly.yml':`name: traffic
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`, 'server.mjs':SERVER});
 const up=await c.cli(['up','--json'],wt);
 expect(up.code,up.stderr+up.stdout).toBe(0);
 expect(up.json.lease.expiresAt).toBeNull();
 const running=()=>Object.keys(c.journal().allEnvs()[0]?.servicePids??{}).length;
 return {c,wt,up,running};
}
describe('proxy activity boundaries',()=>{
 it.each(['websocket','events'])('server-only %s traffic keeps an unleased environment awake',async(kind)=>{
  const {c,wt,up,running}=await setup();
  expect((await c.cli(['release','--json'],wt)).code).toBe(0);
  expect(await waitFor(()=>running()===0,10_000)).toBe(true);
  const s=connect(Number(new URL(up.json.urls.web).port),'127.0.0.1');
  s.on('error',()=>{});
  let received=0;s.on('data',b=>received+=b.length);
  try {
   await new Promise<void>(resolve=>s.once('connect',resolve));
   s.write(kind==='websocket' ? 'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n' : 'GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n');
   expect(await waitFor(()=>received>200,10_000)).toBe(true);
   const before=received;
   await sleep(3000);
   expect(received).toBeGreaterThan(before);
   expect(running()).toBe(1);
   expect(c.journal().allLeases()).toHaveLength(0);
  } finally {s.destroy();}
  expect(await waitFor(()=>running()===0,10_000)).toBe(true);
  expect(c.journal().allEnvs()).toHaveLength(1);
 },30_000);
 it('a silent open socket does not keep services awake',async()=>{
  const {up,running}=await setup();
  const s=connect(Number(new URL(up.json.urls.web).port),'127.0.0.1');s.on('error',()=>{});
  try {await new Promise<void>(resolve=>s.once('connect',resolve));expect(await waitFor(()=>running()===0,10_000)).toBe(true);}
  finally{s.destroy();}
 },20_000);
 it('a silent exec heartbeats faster than a short idle override',async()=>{
  const {c,wt,running}=await setup();
  const command=c.cli(['exec','--','node','-e','setTimeout(()=>{},4000)'],wt);
  await sleep(2500);expect(running()).toBe(1);
  expect((await command).code).toBe(0);
  expect(await waitFor(()=>running()===0,10_000)).toBe(true);
 },20_000);
});
it('only confirmed absence permits worktree cleanup',()=>{
 for(const code of ['EACCES','EIO','ESTALE','ENOENT','ENOTDIR']) {
  const stat=(()=>{throw Object.assign(new Error(code),{code});}) as typeof statSync;
  expect(confirmedMissing('/unused',stat)).toBe(['ENOENT','ENOTDIR'].includes(code));
 }
 expect(confirmedMissing(import.meta.dirname)).toBe(false);
});
