import { readFile } from 'node:fs/promises';
import { command } from './common.mjs';
import { roles, scopes } from './scenario.mjs';

export async function lines(file) {
  try {return (await readFile(file,'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
}
export function measurements(events, expected=roles) {
  const byAgent=Object.fromEntries(expected.map(id=>[id,{reportedTokens:null,cachedInputTokens:null}]));
  const timeline=[],conflicts=[],blockers=[],communication=[];
  for(const e of events.sort((a,b)=>a.timestamp.localeCompare(b.timestamp))) {
    if(e.method==='thread/tokenUsage/updated' && byAgent[e.agent]){
      const total=e.params.tokenUsage?.total;
      if(Number.isFinite(total?.totalTokens))byAgent[e.agent]={reportedTokens:total.totalTokens,cachedInputTokens:total.cachedInputTokens??null};
    }
    const item=e.params?.item;
    if(e.method==='item/completed'&&item?.type==='commandExecution'&&/CONFLICT \(|Automatic merge failed|non-fast-forward|fetch first/i.test(item.aggregatedOutput||''))conflicts.push({agent:e.agent,time:e.timestamp,itemId:item.id,excerpt:(item.aggregatedOutput||'').slice(-1500)});
    if(e.method==='item/completed'&&item?.type==='agentMessage'&&/BLOCKED:/.test(item.text||''))blockers.push({agent:e.agent,time:e.timestamp,itemId:item.id,text:item.text});
    if(e.method==='item/completed'&&item?.type==='mcpToolCall'&&item.server==='patchwork')communication.push({agent:e.agent,time:e.timestamp,itemId:item.id,tool:item.tool,status:item.status,result:item.result,error:item.error});
    if(['hook/completed','runner/prompt','runner/humanResponse','runner/stop','turn/completed','error'].includes(e.method)||e.method==='item/completed'&&['mcpToolCall','agentMessage'].includes(item?.type))timeline.push({agent:e.agent,time:e.timestamp,method:e.method,params:e.params});
  }
  return {tokens:{byAgent,reportedTotal:Object.values(byAgent).reduce((n,v)=>n+(v.reportedTokens||0),0),cachedInputTotal:Object.values(byAgent).reduce((n,v)=>n+(v.cachedInputTokens||0),0),missingAgents:expected.filter(id=>byAgent[id].reportedTokens===null)},conflicts,blockers,communication,timeline,
    humanInterventions:events.filter(e=>e.method==='runner/humanResponse').length,
    scheduledPrompts:events.filter(e=>e.method==='runner/prompt'&&e.params.stage!=='initial').length};
}
export function inScope(role,file,sharedAllowed) {
  return file.startsWith(scopes[role])||file.startsWith(`test/${role}/`)||sharedAllowed&&['contract.json','package.json','README.md'].includes(file);
}
export async function gitEvidence(work,seed,refs,sharedAt={}) {
  const git=args=>command('git',['-C',work,...args]);
  const raw=await git(['log','--no-merges','--format=%H|%ae|%aI',...refs,'--not',seed]);
  const commits=[];
  for(const row of raw.trim().split('\n').filter(Boolean)){
    const [sha,email,time]=row.split('|'),role=roles.find(r=>email===`${r}@simulator.invalid`);
    const files=(await git(['diff-tree','--no-commit-id','--name-only','-r',sha])).trim().split('\n').filter(Boolean);
    const sharedAllowed=role&&sharedAt[role]&&Date.parse(time)>=Date.parse(sharedAt[role]);
    const patch=await git(['show','--pretty=format:','--no-ext-diff',sha]);
    const patchId=(await command('git',['patch-id','--stable'],{input:patch})).split(' ')[0].trim();
    commits.push({sha,email,role:role||'unknown',time,files,patchId,outOfScope:role?files.filter(f=>!inScope(role,f,sharedAllowed)):null});
  }
  const files=new Map();for(const c of commits)for(const f of c.files){if(!files.has(f))files.set(f,new Set());files.get(f).add(c.role);}
  return {commits,scopeViolations:commits.filter(c=>c.outOfScope?.length),unattributed:commits.filter(c=>c.role==='unknown').length,
    overlappingFiles:[...files].filter(([,r])=>r.size>1).map(([file,r])=>({file,authors:[...r]})),
    duplicatePatches:commits.filter((c,i)=>c.patchId&&commits.slice(0,i).some(p=>p.patchId===c.patchId)).map(c=>c.sha),
    limitations:['Commit attribution and timestamps are agent-reported, not tamper-proof. Scope flags cover authored committed changes; uncommitted changes are archived for review.', 'File overlap may be legitimate integration; it is not automatically wasted work. Conflicts count only observed command output.']};
}
