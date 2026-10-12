import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, newRun, save } from '../lib/common.mjs';
import { seedInfo, seedRepository, starter, taskPrompt, humanScript, roles } from '../lib/scenario.mjs';
import { cleanSandbox, setupRepositories } from '../lib/repositories.mjs';
import { grade } from '../lib/grader.mjs';
import { matchBaseline, nextStage, scriptedResponse, trial, validHooks, sendPrompt, setupNormalGit, stopForEvent } from '../lib/trial.mjs';
import { cleanupGitHub, cleanupTrial } from '../lib/phase1-cleanup.mjs';
import { requestLine } from '../lib/gh-recorder.mjs';
import { gitEvidence, measurements, inScope } from '../lib/phase1-metrics.mjs';
import { compare, trialReport } from '../lib/trial-report.mjs';

async function temp(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'patchwork-phase1-test-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('starter commits and hashes are identical across independent initialization',async()=>{
  assert.deepEqual(await seedInfo(),await seedInfo());
});
test('setup inspects both existing repositories without writing or pushing',async t=>{
  const output=await temp(t),seen=[];
  const result=await setupRepositories({'allow-create':true,'baseline-repo':'owner/base','patchwork-repo':'owner/enabled',output},{
    api:async(endpoint,options)=>{assert.equal(options,undefined);assert.equal(endpoint,'/user');return {login:'owner',id:1};},
    inspect:async repo=>{seen.push(repo);return {id:seen.length,private:true,default_branch:'main'};},
  });
  assert.deepEqual(seen,['owner/base','owner/enabled']);assert(result.repositories.every(r=>r.action==='existing-untouched'));
  await assert.rejects(setupRepositories({}),/allow-create/);
});
function fakeRepo(changes={}) {
  return async route=>{
    if(route==='/user')return {id:1,login:'owner'};
    if(route.endsWith('/git/ref/heads/main'))return {object:{sha:changes.sha||'seed'}};
    if(route.includes('/branches?'))return changes.branches||[{name:'main'}];
    if(route.includes('/issues?'))return changes.issues||[];
    if(route.includes('/tags?'))return [];
    return {id:1,owner:{id:1},full_name:'owner/base',private:true,permissions:{admin:true},has_issues:true,default_branch:'main',...changes.remote};
  };
}
test('only pristine owned private repositories can be used; no reset path',async()=>{
  assert.equal((await cleanSandbox('owner/base',{commit:'seed'},fakeRepo())).initialCommit,'seed');
  for(const change of [{sha:'changed'},{branches:[{name:'main'},{name:'work'}]},{issues:[{state:'closed'}]},{remote:{private:false}},{remote:{owner:{id:2}}}])await assert.rejects(cleanSandbox('owner/base',{commit:'seed'},fakeRepo(change)));
});
test('live authorization is required before preparation; identical sequential controls enforced',async()=>{
  await assert.rejects(trial({condition:'baseline',repo:'owner/base'}),/allow-live/);
  const b={kind:'comparison',condition:'baseline',repo:'owner/base',peerRepo:'owner/enabled',cleanup:{complete:true},startedAt:'now',grade:{},model:'gpt-6-luna',reasoning:'low',runtimeSeconds:900,tokenBudget:1000000,scenarioHash:'hash',initialCommit:'seed',humanScript};
  matchBaseline(b,{repo:'owner/enabled'},{hash:'hash',commit:'seed'});
  for(const change of [{repo:'owner/base'},{repo:'owner/enabled',tokens:2000000},{repo:'owner/enabled',model:'expensive'}])assert.throws(()=>matchBaseline(b,change,{hash:'hash',commit:'seed'}));
  assert.throws(()=>matchBaseline({...b,cleanup:{complete:false}},{repo:'owner/enabled'},{hash:'hash',commit:'seed'}),/cleanup/);
});
test('scheduling needs no waiting model turns; user responses never grant peer scope',()=>{
  const agent={active:false,sent:new Set()};assert.equal(nextStage(agent,179),-1);assert.equal(nextStage(agent,180),0);
  agent.active=true;assert.equal(nextStage(agent,1000),null);agent.active=false;agent.sent.add(0);assert.equal(nextStage(agent,420),1);agent.sent.add(1);assert.equal(nextStage(agent,1000),-1);
  assert.deepEqual(scriptedResponse({questions:[{id:'q',question:'Expand scope?'}]}).answers.q.answers.length,1);
  for(const role of roles)for(const condition of ['baseline','patchwork']){
    const prompt=taskPrompt(role,'owner/repo','run',condition);assert(prompt.includes('No force pushes'));assert(prompt.includes('runner will not implement, merge'));
  }
});
test('native hook inventory must match enabled condition; baseline has none',()=>{
  assert(validHooks([],{hooks:'/expected'},false));assert(!validHooks([{eventName:'sessionStart'}],{},false));
  const hooks=[{eventName:'sessionStart',handlerType:'command'},{eventName:'userPromptSubmit',server:'patchwork',tool:'check_board'},{eventName:'postToolUse',server:'patchwork',tool:'check_board'}].map(h=>({...h,enabled:true,sourcePath:'/expected'}));
  assert(validHooks(hooks,{hooks:'/expected'},true));hooks[0].sourcePath='/other';assert(!validHooks(hooks,{hooks:'/expected'},true));
});
test('API counter retains verbs only; ignores credentials, URLs, headers and bodies',()=>{
  assert.equal(requestLine('> GET /repos/owner/repo?access_token=secret HTTP/2.0'),'GET');
  for(const text of ['> Authorization: Bearer secret','{"token":"secret"}','< HTTP/2.0 200 OK','POST fake'])assert.equal(requestLine(text),null);
});
test('instrumented gh preserves protocol stdout, counts requests, and never saves debug secrets',async t=>{
  const dir=await temp(t);const shared={runtime:path.join(dir,'runtime')};await mkdir(shared.runtime);await mkdir(path.join(dir,'gh'));
  const fake=path.join(dir,'real-gh');await writeFile(fake,`#!${process.execPath}\nprocess.stderr.write('> GET /user HTTP/2.0\\n> Authorization: secret-not-for-logs\\n< HTTP/2.0 200 OK\\n');process.stdout.write('{"ok":true}');`,{mode:0o700});
  const agent={base:dir,env:{PATH:process.env.PATH,HOME:dir}};await setupNormalGit(agent,shared,{github:'fake-test-token'},fake);
  assert.equal(await command(path.join(dir,'bin/gh'),['api','/user'],{env:{...process.env,...agent.env}}),'{"ok":true}');
  const log=await readFile(agent.apiLog,'utf8');assert(!log.includes('secret'));assert(!log.includes('fake-test-token'));assert.equal(JSON.parse(log).method,'GET');
  if(process.platform==='darwin')assert.equal((await command('/bin/zsh',['-lc','command -v gh'],{env:agent.env})).trim(),path.join(dir,'bin/gh'));
});
test('independent prompt submissions start concurrently with exact model/effort and no board dispatch',async()=>{
  const pending=[],calls=[];
  const agents=roles.map(id=>({id,threadId:id,model:'gpt-6-luna',reasoning:'low',client:{record:()=>{},call:(method,params)=>{calls.push({method,params});return new Promise(r=>pending.push(r));}}}));
  const all=Promise.all(agents.map(a=>sendPrompt(a,'task','initial')));
  assert.equal(calls.length,3);assert.equal(new Set(calls.map(c=>c.params.threadId)).size,3);
  assert(calls.every(c=>c.method==='turn/start'&&c.params.model==='gpt-6-luna'&&c.params.effort==='low'));
  pending.forEach(r=>r({}));await all;
});
test('token measurement uses cumulative totals once, includes cached input, keeps missing distinct',()=>{
  const es=[10,20].map((n,i)=>({timestamp:String(i),agent:'frontend',method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:n,cachedInputTokens:n-1}}}}));
  const result=measurements(es);assert.equal(result.tokens.reportedTotal,20);assert.equal(result.tokens.cachedInputTotal,19);assert.deepEqual(result.tokens.missingAgents,['backend','storage']);
});
test('live guard stops on aggregate tokens, unknown usage, provider/auth change without upgrading',()=>{
  const agents=roles.map(id=>({id}));
  const token=(id,n)=>({agent:id,method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{totalTokens:n,cachedInputTokens:n}}}});
  assert.equal(stopForEvent(token('frontend',40),agents,100),null);
  assert.equal(stopForEvent(token('frontend',40),agents,100),null);
  assert.equal(stopForEvent(token('backend',30),agents,100),null);
  assert.match(stopForEvent(token('storage',30),agents,100),/budget reached/);
  assert.match(stopForEvent(token('frontend',undefined),agents,100),/unavailable/);
  assert.match(stopForEvent({method:'account/updated',params:{subscriptionVerified:false}},agents,100),/authentication changed/);
  assert.match(stopForEvent({method:'model/rerouted'},agents,100),/substitution refused/);
});
test('scope attribution covers peer edits and explicitly authorized shared files',async t=>{
  assert(inScope('frontend','public/app.js',false));assert(!inScope('frontend','server/app.mjs',true));assert(!inScope('frontend','package.json',false));assert(inScope('frontend','package.json',true));
  const dir=await temp(t),seed=await seedRepository(dir);const git=args=>command('git',['-C',dir,...args]);
  await git(['config','user.email','frontend@simulator.invalid']);await writeFile(path.join(dir,'server/violation.txt'),'bad scope');await git(['add','.']);await git(['-c','commit.gpgsign=false','commit','-m','test scope']);
  const m=await gitEvidence(dir,seed,['HEAD']);assert.equal(m.scopeViolations.length,1);assert.deepEqual(m.scopeViolations[0].outOfScope,['server/violation.txt']);
});
test('cleanup closes only owned artifacts and deletes role branches with a SHA lease',async t=>{
  const output=await temp(t),run=await newRun({repo:'owner/base',output,kind:'comparison'}),m=run.manifest;
  m.repository={id:1,userId:7};const item={id:2,number:4,title:m.runId,body:'',user:{id:7},state:'open'};let branches=[{name:'main'},{name:`${m.runId}/frontend`,commit:{sha:'abc'}}],writes=0,deletes=0;
  const deps={api:async(route,options)=>{if(route==='/user')return {id:7};if(route==='/repos/owner/base')return {id:1,full_name:'owner/base'};if(options){writes++;item.state='closed';}return item;},
    pages:async route=>route.endsWith('/branches')?branches:route.endsWith('/comments')?[]:[item],
    command:async(program,args)=>{assert.equal(program,'git');assert(args.includes(`--force-with-lease=refs/heads/${m.runId}/frontend:abc`));assert(!args.includes(':refs/heads/main'));deletes++;branches=[{name:'main'}];}};
  await cleanupGitHub(run,deps);await cleanupGitHub(run,deps);assert.equal(writes,1);assert.equal(deletes,1);
  branches.push({name:'unrelated',commit:{sha:'xyz'}});await assert.rejects(cleanupGitHub(run,deps),/Unrecognized branch/);
  item.user.id=99;await assert.rejects(cleanupGitHub(run,deps),/Unrecognized issue/);
});
test('local cleanup is repeatable and reports retain incomplete Phase 0',async t=>{
  const output=await temp(t),run=await newRun({repo:'owner/base',output,kind:'comparison'}),m=run.manifest;
  m.condition='baseline';m.temp=path.join(output,'owned');await save(path.join(m.temp,'.patchwork-sim-owner.json'),{runId:m.runId});
  await cleanupTrial(run);await cleanupTrial(run);assert(m.cleanup.complete);await assert.rejects(readFile(path.join(m.temp,'.patchwork-sim-owner.json')),{code:'ENOENT'});
  await trialReport(run);assert.match(await readFile(path.join(run.dir,'report.md'),'utf8'),/Phase 0 remains \*\*INCONCLUSIVE\*\*/);
  await assert.rejects(compare(run,run,output),/matching sequential/);
});

// Reference implementation is only a grader fixture, never shipped into agent
// workspaces or the GitHub starter. It proves the checks can pass end to end.
async function reference(dir){
  await cp(starter,dir,{recursive:true});
  await writeFile(path.join(dir,'storage/db.mjs'),`import {DatabaseSync} from 'node:sqlite';import {mkdirSync} from 'node:fs';import path from 'node:path';
export function createStore(file){mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);db.exec('CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, slotId TEXT UNIQUE, name TEXT)');
const ids=['s1','s2','s3'];return {listSlots:()=>ids.map((slotId,i)=>({slotId,label:(i+9)+':00',available:!db.prepare('SELECT id FROM bookings WHERE slotId=?').get(slotId)})),listBookings:()=>db.prepare('SELECT * FROM bookings ORDER BY id').all(),book:(slotId,name)=>{if(!ids.includes(slotId)||typeof name!=='string'||!name.trim())throw Object.assign(Error('Invalid booking'),{status:400});try{const r=db.prepare('INSERT INTO bookings(slotId,name) VALUES(?,?)').run(slotId,name);return {id:Number(r.lastInsertRowid),slotId,name};}catch{throw Object.assign(Error('Unavailable'),{status:409});}},close:()=>db.close()};}`);
  await writeFile(path.join(dir,'server/app.mjs'),`import http from 'node:http';import {readFile} from 'node:fs/promises';import {createStore} from '../storage/db.mjs';
export function createServer({dbPath}){const store=createStore(dbPath),server=http.createServer(async(req,res)=>{const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};try{if(req.url==='/api/slots')return send(200,{slots:store.listSlots()});if(req.url==='/api/bookings'){if(req.method==='GET')return send(200,{bookings:store.listBookings()});let body='';for await(const c of req)body+=c;let value;try{value=JSON.parse(body);}catch{throw Object.assign(Error('JSON'),{status:400});}return send(201,{booking:store.book(value.slotId,value.name)});}const files={'/':'index.html','/app.js':'app.js','/api.mjs':'api.mjs'};if(!files[req.url])return send(404,{error:'Not found'});res.writeHead(200,{'Content-Type':req.url==='/'?'text/html':'text/javascript'});res.end(await readFile(new URL('../public/'+files[req.url],import.meta.url)));}catch(e){send(e.status||500,{error:e.message});}});server.on('close',()=>store.close());return server;}`);
  await writeFile(path.join(dir,'public/app.js'),`import {loadSlots,createBooking} from './api.mjs';const slot=document.querySelector('#slot'),name=document.querySelector('#name'),message=document.querySelector('#message');async function refresh(){slot.replaceChildren(...(await loadSlots()).filter(s=>s.available).map(s=>new Option(s.label,s.slotId)));}document.querySelector('#booking-form').addEventListener('submit',async e=>{e.preventDefault();try{await createBooking(slot.value,name.value);message.textContent='Booked';await refresh();}catch(e){message.textContent=e.message;}});refresh().catch(e=>message.textContent=e.message);`);
  await writeFile(path.join(dir,'public/api.mjs'),`export async function loadSlots(){return (await (await fetch('/api/slots')).json()).slots;}export async function createBooking(slotId,name){const r=await fetch('/api/bookings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slotId,name})});const body=await r.json();if(!r.ok)throw Error(body.error);return body.booking;}`);
}
test('external grader rejects unfinished starter and passes real SQLite/HTTP/client integration',{skip:process.platform!=='darwin',timeout:60000},async t=>{
  const dir=await temp(t),candidate=path.join(dir,'candidate');await cp(starter,candidate,{recursive:true});
  const initial=await grade(candidate,path.join(dir,'initial'));assert.equal(initial.allPassed,false);assert(initial.passed<8);assert.equal(initial.checks.find(c=>c.name==='frontend page and module wiring').pass,false);
  await reference(candidate);const done=await grade(candidate,path.join(dir,'complete'));assert.equal(done.allPassed,true,JSON.stringify(done));assert.equal(done.passed,8);
});
