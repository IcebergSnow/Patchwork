import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorize, command, delay, json, newRun, redact, repoName, save } from './common.mjs';
import { roles, humanScript, taskPrompt, seedInfo } from './scenario.mjs';
import { cleanSandbox, validatePair } from './repositories.mjs';
import { prepareRuntime, prepareAgent, configureMcpEnvironment, loadCredentials, chatState } from './environment.mjs';
import { agentAuthentication, codexAuthentication, AUTH_CONFIG } from './auth.mjs';
import { Codex } from './codex.mjs';
import { cleanupTrial, captureCollaboration } from './phase1-cleanup.mjs';
import { grade } from './grader.mjs';
import { lines, measurements, gitEvidence } from './phase1-metrics.mjs';
import { trialReport } from './trial-report.mjs';

export const phase0Evidence={status:'INCONCLUSIVE',promptRoundTrip:'verified',postToolUse:'receiver delivery and acknowledgment verified; sender return delivery unverified',progression:'Phase 1 explicitly authorized despite the remaining Phase 0 limitation'};
export const responseText='Stay within your current user-authorized scope. Coordinate dependencies using available teammate channels and continue independent work. Report concrete blockers to your user. No additional peer-directory scope is authorized by this scripted response; the scheduled checkpoint may authorize shared root files.';
export function scriptedResponse(params) {
  return {answers:Object.fromEntries((params.questions||[]).map(q=>[q.id,{answers:[responseText]}]))};
}
export function nextStage(agent,elapsed,script=humanScript) {
  if(agent.active)return null;
  return script.findIndex((s,i)=>!agent.sent.has(i)&&elapsed>=s.afterSeconds);
}
export function stopForEvent(event,agents,budget) {
  if(event.method==='thread/tokenUsage/updated'){
    const total=event.params.tokenUsage?.total?.totalTokens;
    if(!Number.isSafeInteger(total)||total<0)return 'Codex token accounting is unavailable.';
    const agent=agents.find(a=>a.id===event.agent);if(agent)agent.tokens=total;
    if(agents.reduce((n,a)=>n+(a.tokens||0),0)>=budget)return 'Reported aggregate token budget reached.';
  }
  if(event.method==='model/rerouted')return 'Model substitution refused.';
  if(event.method==='account/updated'&&!event.params.subscriptionVerified)return 'Subscription authentication changed.';
  return null;
}
export function matchBaseline(baseline, options, seed) {
  if(baseline.kind!=='comparison'||baseline.condition!=='baseline'||!baseline.cleanup.complete||!baseline.startedAt||!baseline.grade)
    throw new Error('A finished, graded baseline with completed cleanup is required first.');
  if(baseline.peerRepo?.toLowerCase()!==options.repo.toLowerCase()||baseline.repo.toLowerCase()===options.repo.toLowerCase())throw new Error('Use the distinct enabled repository authorized by the baseline.');
  for(const [key,value] of Object.entries({model:options.model||'gpt-6-luna',reasoning:options.reasoning||'low',runtimeSeconds:Number(options.seconds||900),tokenBudget:Number(options.tokens||1000000),scenarioHash:seed.hash,initialCommit:seed.commit}))
    if(baseline[key]!==value)throw new Error(`Comparison controls differ: ${key}.`);
  if(JSON.stringify(baseline.humanScript)!==JSON.stringify(humanScript))throw new Error('Scripted human responses differ.');
}
export async function setupNormalGit(agent,shared,credentials,realGh) {
  const helper=path.join(shared.runtime,'gh-recorder.mjs');
  await cp(path.join(import.meta.dirname,'gh-recorder.mjs'),helper);
  const bin=path.join(agent.base,'bin');await mkdir(bin,{recursive:true});
  agent.apiLog=path.join(agent.base,'github-api.jsonl');
  await writeFile(path.join(bin,'gh'),`#!${process.execPath}\nimport {runGh} from ${JSON.stringify(pathToFileURL(helper).href)};runGh(${JSON.stringify(realGh)},${JSON.stringify(agent.apiLog)},process.argv.slice(2));\n`,{mode:0o700});
  agent.env.PATH=bin+path.delimiter+agent.env.PATH;
  // macOS /etc/zprofile runs path_helper, which otherwise moves the real gh
  // ahead of our counter. Only these disposable homes receive profile files.
  const shellBin="'"+bin.replaceAll("'","'\\''")+"'";
  for(const file of ['.zprofile','.bash_profile'])await writeFile(path.join(agent.env.HOME,file),`export PATH=${shellBin}:"$PATH"\n`,{mode:0o600});
  // Codex excludes GH_TOKEN from model-run shell environments. A private,
  // disposable gh credential file lets ordinary git/gh work in BOTH conditions.
  await writeFile(path.join(agent.base,'gh/hosts.yml'),`github.com:\n    oauth_token: ${JSON.stringify(credentials.github)}\n    git_protocol: https\n`,{mode:0o600});
}
async function install(run,a,shared) {
  const m=run.manifest;m.installAttempted=true;await run.persist();
  await command(process.execPath,[shared.entry,'connect','--repo',m.repo,'--client','codex','--create-board','--name',`${m.runId}/${a.id}`],{cwd:a.work,env:a.env,timeout:120000});
  const dir=path.join(a.base,'patchwork/connections');
  const names=(await readdir(dir)).filter(n=>n.endsWith('.json')&&!n.includes('.sessions.'));
  if(names.length!==1)throw new Error('Expected one isolated Patchwork connection.');
  a.connection=path.join(dir,names[0]);const connection=await json(a.connection);
  if(m.board&&m.board!==connection.board)throw new Error('Agents connected to different boards.');
  m.board=connection.board;m.createdBoard=true;
  m.agents.find(v=>v.id===a.id).connection=a.connection;
  if(!m.resources.some(r=>r.type==='board'))m.resources.push({type:'board',number:m.board,url:connection.boardUrl});
  await run.persist();await configureMcpEnvironment(a);
}
export function validHooks(hooks,agent,enabled) {
  if(!enabled)return hooks.length===0;
  return hooks.length===3&&hooks.every(h=>h.sourcePath===agent.hooks&&h.enabled)&&
    hooks.some(h=>h.eventName==='sessionStart'&&h.handlerType==='command')&&
    ['userPromptSubmit','postToolUse'].every(event=>hooks.some(h=>h.eventName===event&&h.server==='patchwork'&&h.tool==='check_board'));
}
async function launch(run,a,creds,options,onEvent) {
  const m=run.manifest,enabled=m.condition==='patchwork';
  await agentAuthentication(a,creds.codex,{patchwork:enabled});
  const c=new Codex({command:'/usr/bin/sandbox-exec',args:['-f',a.profile,options.codex||'codex','-c',`projects.${JSON.stringify(a.work)}.trust_level="trusted"`,'app-server','--stdio'],
    cwd:a.work,env:a.env,log:path.join(run.dir,`${a.id}.jsonl`),agent:a.id,runId:m.runId,condition:m.condition,
    onEvent,onRequest:params=>{const result=scriptedResponse(params);c.record('runner/humanResponse',{questions:params.questions,result});return result;}});
  a.client=c;m.agents.find(v=>v.id===a.id).pid=c.child.pid;await run.persist();
  await c.initialize();const saved=m.agents.find(v=>v.id===a.id);
  saved.authentication=await codexAuthentication(c,a);
  let cursor,model;do{const catalog=await c.call('model/list',{limit:100,...(cursor&&{cursor})});model||=catalog.data.find(v=>v.model===m.model||v.id===m.model);cursor=catalog.nextCursor;}while(cursor&&!model);
  if(!model?.supportedReasoningEfforts?.some(e=>e.reasoningEffort===m.reasoning))throw new Error(`Exact model/effort unavailable: ${m.model}/${m.reasoning}. No fallback.`);
  const hooks=(await c.call('hooks/list',{cwds:[a.work]})).data.flatMap(v=>v.hooks);
  if(!validHooks(hooks,a,enabled))throw new Error('Unexpected native hook configuration.');
  saved.hookInventory=hooks;
  const result=await c.call('thread/start',{model:m.model,modelProvider:'openai',cwd:a.work,approvalPolicy:'never',sandbox:'danger-full-access',allowProviderModelFallback:false,config:{...AUTH_CONFIG,...(enabled&&{bypass_hook_trust:true})}});
  if(result.thread.modelProvider!=='openai')throw new Error('Unexpected model provider.');
  a.threadId=result.thread.id;saved.threadId=a.threadId;a.sent=new Set();a.active=false;a.model=m.model;a.reasoning=m.reasoning;
  const servers=await c.call('mcpServerStatus/list',{threadId:a.threadId});
  if(enabled){const tools=servers.data.find(s=>s.name==='patchwork')?.tools||{};if(servers.data.length!==1||!['post_message','acknowledge_request','check_board'].every(t=>t in tools))throw new Error('Unexpected or missing Patchwork MCP tools.');}
  else if(servers.data.length)throw new Error('Baseline unexpectedly loaded MCP servers.');
  await run.persist();
}
export async function sendPrompt(a,text,stage) {
  a.active=true;
  a.client.record('runner/prompt',{stage,text});
  await a.client.call('turn/start',{threadId:a.threadId,model:a.model,effort:a.reasoning,input:[{type:'text',text,text_elements:[]}]});
}
async function snapshot(run,agents) {
  const m=run.manifest;
  // Preserve each agent's authored/unmerged work before deleting environments.
  for(const a of agents){
    const git=args=>command('git',['-C',a.work,...args],{env:a.env});
    await git(['bundle','create',path.join(run.dir,`${a.id}.bundle`),'--all']);
    await writeFile(path.join(run.dir,`${a.id}-uncommitted.patch`),redact(await git(['diff','HEAD'])),{mode:0o600});
    m.agents.find(v=>v.id===a.id).worktreeStatus=await git(['status','--short']);
  }
  const candidate=path.join(m.temp,'submission');await mkdir(candidate);
  await command('git',['init',candidate]);
  await command('git',['-C',candidate,'-c','credential.helper=','-c','credential.helper=!gh auth git-credential','fetch','--no-tags',`https://github.com/${m.repo}.git`,'+refs/heads/*:refs/remotes/origin/*']);
  m.submittedCommit=(await command('git',['-C',candidate,'rev-parse','refs/remotes/origin/main'])).trim();
  // Checkout is solely a grading snapshot. No remote code write/merge occurs.
  await command('git',['-C',candidate,'checkout','--detach',m.submittedCommit]);
  for(const a of agents)await command('git',['-C',candidate,'fetch',path.join(run.dir,`${a.id}.bundle`),`+refs/heads/*:refs/remotes/saved-${a.id}/*`]);
  const sharedAt=Object.fromEntries(m.humanPrompts.filter(p=>p.stage===0).map(p=>[p.agent,p.time]));
  m.git=await gitEvidence(candidate,m.initialCommit,['--all'],sharedAt);
  m.integrated=await gitEvidence(candidate,m.initialCommit,[m.submittedCommit],sharedAt);
  m.integration={allRolesCommitted:roles.every(r=>m.git.commits.some(c=>c.role===r)),allRolesOnMain:roles.every(r=>m.integrated.commits.some(c=>c.role===r)),main:m.submittedCommit};
  await command('git',['-C',candidate,'bundle','create',path.join(run.dir,'submission.bundle'),'--all']);
  await run.persist();m.grade=await grade(candidate,path.join(m.temp,'grading'));await run.persist();
}
export async function trial(options,baseline) {
  authorize(options);repoName(options.repo);
  if(!['baseline','patchwork'].includes(options.condition))throw new Error('--condition must be baseline or patchwork.');
  const run=await newRun({...options,kind:'comparison',seconds:options.seconds||900,tokens:options.tokens||1000000});
  const m=run.manifest,agents=[],clients=()=>agents.map(a=>a.client).filter(Boolean);
  run.persist=()=>save(path.join(run.dir,'manifest.json'),JSON.parse(redact(m)));
  Object.assign(m,{condition:options.condition,phase0Evidence,phase0Complete:false,humanScript,humanPrompts:[],initialIssueIds:[],initialLabelIds:[],limitations:[
    'Single-account macOS process isolation; not a hostile-code security boundary or a test of Windows/multi-account permissions.',
    'GitHub credentials have the existing account permissions, not repository-scoped tokens. Agents are instructed to access only the authorized sandbox.',
    'No automatic repairs, merges, model upgrades, live retries, or delivery simulation.',
    'Reported token threshold includes cached input; in-flight calls can overshoot. Codex allowance is not convertible to a guaranteed percentage.',
    'Phase 0 remains INCONCLUSIVE; actual native-hook events in this trial are reported separately.',
    'One sequential pair is exploratory evidence, not a statistically reliable causal result.',
  ]});
  console.log(`Run ${m.runId} (${m.condition})`);
  let sleepGuard,watchdog,stopReason,interrupted=false;
  const stop=reason=>{stopReason||=reason;for(const c of clients())void c.stop();};
  const interrupt=()=>{interrupted=true;stop('Interrupted by user or process shutdown.');};
  process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  try{
    const creds=await loadCredentials();m.authentication={source:'chatgpt',verified:true};
    const seed=await seedInfo();m.scenarioHash=seed.hash;m.initialCommit=seed.commit;
    if(m.condition==='baseline'){
      repoName(options['peer-repo']);const pair=await validatePair(m.repo,options['peer-repo']);m.repository=pair.repositories[0];m.peerRepository=pair.repositories[1];m.peerRepo=options['peer-repo'];
    }else{
      if(!baseline)throw new Error('--baseline-run is required for enabled trials.');
      matchBaseline(baseline,options,seed);m.baselineRun=baseline.runId;m.peerRepo=baseline.repo;m.repository=await cleanSandbox(m.repo,seed);
      if(m.repository.id!==baseline.peerRepository.id)throw new Error('Enabled repository ID changed since baseline.');
    }
    m.codexVersion=(await command(options.codex||'codex',['--version'])).trim();
    if(baseline&&baseline.codexVersion!==m.codexVersion)throw new Error('Codex version differs from baseline.');
    const realGh=(await command('/usr/bin/which',['gh'])).trim();
    await run.persist();const shared=await prepareRuntime(run);
    for(const id of roles){
      if(interrupted)throw new Error(stopReason);
      const a=await prepareAgent(run,id,shared,creds,{seedCommit:seed.commit});agents.push(a);
      await setupNormalGit(a,shared,creds,realGh);
      if(m.condition==='patchwork')await install(run,a,shared);
      await agentAuthentication(a,creds.codex,{patchwork:m.condition==='patchwork'});
    }
    // Each process can read its own project but not either teammate's checkout.
    for(const a of agents)for(const other of agents.filter(b=>b!==a))await command('/usr/bin/sandbox-exec',['-f',a.profile,process.execPath,'-e',`try{require('fs').readFileSync(${JSON.stringify(path.join(other.work,'README.md'))});process.exit(2)}catch(e){if(!['EPERM','EACCES'].includes(e.code))process.exit(3)}`],{cwd:a.work,env:a.env});
    // caffeinate exits if this runner dies; its bounded timeout is a second guard.
    sleepGuard=spawn('/usr/bin/caffeinate',['-i','-s','-t',String(m.runtimeSeconds+120),'-w',String(process.pid)],{stdio:'ignore'});
    sleepGuard.on('error',()=>stop('macOS sleep prevention failed.'));
    sleepGuard.on('exit',()=>{if(!m.endedAt)stop('macOS sleep prevention exited early.');});
    m.sleepPrevention={pid:sleepGuard.pid,method:'caffeinate -i -s',limits:'Prevents idle sleep; lid closure/manual sleep can still interrupt the trial.'};
    await delay(100);if(stopReason)throw new Error(stopReason);
    m.startedAt=new Date().toISOString();const started=Date.now();
    watchdog=setInterval(()=>{if(Date.now()-started>=m.runtimeSeconds*1000)stop('Runtime budget reached.');},200);
    await run.persist();
    for(const a of agents){
      if(stopReason)throw new Error(stopReason);
      await launch(run,a,creds,options,e=>{
        if(e.method==='turn/completed'){
          a.active=false;
          if(e.params.turn?.status==='failed')stop('A Codex turn failed; see native event log.');
        }
        const reason=stopForEvent(e,agents,m.tokenBudget);if(reason)stop(reason);
      });
    }
    if(stopReason)throw new Error(stopReason);
    await Promise.all(agents.map(a=>sendPrompt(a,taskPrompt(a.id,m.repo,m.runId,m.condition)+'\nDo not start nested agents or model processes, change authentication, or edit .codex/.git configuration.', 'initial')));
    while(!stopReason){
      if(clients().some(c=>c.exit))throw new Error('Codex exited unexpectedly.');
      for(const a of agents){if(stopReason)break;const stage=nextStage(a,(Date.now()-started)/1000);if(stage!==null&&stage>=0){
        a.sent.add(stage);m.humanPrompts.push({agent:a.id,stage,time:new Date().toISOString()});await run.persist();
        if(stopReason)break;
        await sendPrompt(a,humanScript[stage].text,stage);
      }}
      if(agents.every(a=>!a.active&&a.sent.size===humanScript.length))break;
      await delay(200);
    }
    m.stopReason=stopReason||'All agents completed after both scripted checkpoints.';
  }catch(e){m.blocker=redact(e.message);m.stopReason=stopReason||m.blocker;}
  finally{
    clearInterval(watchdog);m.endedAt=new Date().toISOString();if(sleepGuard)sleepGuard.kill('SIGTERM');
    for(const c of clients())try{await c.stop();}catch(e){m.blocker||=redact(e.message);}
    m.elapsedSeconds=m.startedAt?(Date.parse(m.endedAt)-Date.parse(m.startedAt))/1000:0;
    m.measurements=JSON.parse(redact(measurements(clients().flatMap(c=>c.events))));
    for(const a of agents){
      const saved=m.agents.find(v=>v.id===a.id);
      try{const chats=await chatState(a);saved.chatIds=chats.map(c=>c.id);saved.nativeRegistrations=chats.filter(c=>c.registered).map(c=>c.id);
        const counts=await lines(a.apiLog);saved.githubApiRequests=counts.length;
        saved.githubLiveRequests=counts.filter(c=>m.startedAt&&c.timestamp>=m.startedAt&&c.timestamp<=m.endedAt).length;
        await save(path.join(run.dir,`${a.id}-api.json`),counts);
      }catch(e){m.blocker||=redact(e.message);}
    }
    m.nativeEvidence={sessions:m.agents.map(a=>({agent:a.id,threadId:a.threadId,chatIds:a.chatIds||[]})),
      hooks:m.measurements.timeline.filter(e=>e.method==='hook/completed').map(e=>({agent:e.agent,time:e.time,...e.params})),
      mcpCalls:m.measurements.communication};
    if(m.startedAt&&agents.length===3){
      try{await captureCollaboration(run);}catch(e){m.blocker||=redact(e.message);}
      try{await snapshot(run,agents);}catch(e){m.blocker||=redact(e.message);}
    }
    m.githubApi={agentRequests:m.agents.reduce((n,a)=>n+(a.githubApiRequests||0),0),liveRequests:m.agents.reduce((n,a)=>n+(a.githubLiveRequests||0),0),coverage:'Actual HTTP requests made through instrumented gh in agent environments, including isolated installation, Patchwork hooks/MCP and GitHub CLI. liveRequests excludes pre-launch installation. Host-side setup/cleanup, git transport, absolute-path gh and direct HTTP are excluded.'};
    try{await cleanupTrial(run,clients());}catch(e){m.cleanup={complete:false,errors:[redact(e.message)]};}
    const independent=new Set(m.agents.map(a=>a.threadId).filter(Boolean)).size===3;
    const registered=m.condition==='baseline'||m.agents.every(a=>a.nativeRegistrations?.length===1)&&new Set(m.agents.flatMap(a=>a.nativeRegistrations)).size===3;
    const nativeStart=m.condition==='baseline'||roles.every(id=>m.nativeEvidence.hooks.some(e=>e.agent===id&&e.run?.eventName==='sessionStart'&&e.run?.status==='completed'));
    m.validCondition=independent&&registered&&nativeStart&&m.measurements.tokens.missingAgents.length===0;
    m.status=m.blocker||!m.validCondition||!m.cleanup.complete?'INCONCLUSIVE':m.grade?.allPassed&&m.integration?.allRolesOnMain?'PASS':'FAIL';
    await run.persist();await trialReport(run);
    process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    console.log(`${m.status}: ${path.join(run.dir,'report.md')}`);
  }
  return run;
}
