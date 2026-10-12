import path from 'node:path';
import { lstat, rm } from 'node:fs/promises';
import { command, ownedDirectory, redact, save } from './common.mjs';
import { api, pages } from './repositories.mjs';
import { cleanup } from './preflight.mjs';
import { roles } from './scenario.mjs';

export async function captureCollaboration(run) {
  const m=run.manifest,issues=await pages(`/repos/${m.repo}/issues?state=all`),records=[];
  for(const issue of issues)records.push({issue,comments:await pages(`/repos/${m.repo}/issues/${issue.number}/comments`)});
  await save(path.join(run.dir,'collaboration-before-cleanup.json'),JSON.parse(redact(records)));
  m.collaboration={capturedAt:new Date().toISOString(),issues:records.filter(r=>r.issue.number!==m.board&&!r.issue.pull_request).map(({issue,comments})=>({number:issue.number,url:issue.html_url,state:issue.state,comments:comments.length})),
    comments:records.reduce((n,r)=>n+r.comments.length,0),note:'State captured BEFORE simulator cleanup. Issue closure is not proof of a fixed dependency; inspect code, comments and native MCP results.'};
  await run.persist();
}

export async function cleanupGitHub(run, deps={api,pages,command}) {
  const m=run.manifest;
  if(!m.repository)return;
  const [remote,user]=await Promise.all([deps.api(`/repos/${m.repo}`),deps.api('/user')]);
  if(remote.id!==m.repository.id||user.id!==m.repository.userId||remote.full_name.toLowerCase()!==m.repo.toLowerCase())throw new Error('Cleanup repository/account changed; refusing remote mutations.');
  const issues=await deps.pages(`/repos/${m.repo}/issues?state=all`),artifacts=[];
  for(const issue of issues){
    const comments=await deps.pages(`/repos/${m.repo}/issues/${issue.number}/comments`);
    artifacts.push({issue,comments});
    if(issue.number===m.board)continue; // production cleanup handles registrations and board
    if(issue.user?.id!==m.repository.userId||!`${issue.title}\n${issue.body}`.includes(m.runId))
      throw new Error(`Unrecognized issue #${issue.number}; preserved for inspection.`);
    if(comments.some(c=>c.user?.id!==m.repository.userId))throw new Error(`Unrelated comments on #${issue.number}; preserved.`);
    if(issue.state!=='closed')await deps.api(`/repos/${m.repo}/${issue.pull_request?'pulls':'issues'}/${issue.number}`,{method:'PATCH',body:{state:'closed'}});
    if((await deps.api(`/repos/${m.repo}/issues/${issue.number}`)).state!=='closed')throw new Error(`Issue #${issue.number} remains open.`);
  }
  await save(path.join(run.dir,'collaboration.json'),JSON.parse(redact(artifacts)));
  const branches=await deps.pages(`/repos/${m.repo}/branches`);
  m.removedBranches||=[];
  for(const b of branches){
    if(b.name==='main')continue;
    if(!roles.some(r=>b.name===`${m.runId}/${r}`))throw new Error(`Unrecognized branch ${b.name}; preserved.`);
    // The lease checks the observed SHA atomically; a concurrent update cannot
    // be silently deleted. Never reset, rewrite, merge, or delete main.
    await deps.command('git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push',`--force-with-lease=refs/heads/${b.name}:${b.commit.sha}`,`https://github.com/${m.repo}.git`,`:refs/heads/${b.name}`]);
    m.removedBranches.push(b.name);await run.persist();
  }
}
export async function cleanupTrial(run,clients=[]) {
  const errors=[];
  // Reuse production retirement and PID-ownership recovery before any remote
  // deletion. Keep local recovery state until ALL cleanup has succeeded.
  await cleanup(run,clients,{retainTemporary:true});
  errors.push(...run.manifest.cleanup.errors);
  if(errors.length)return;
  try{await cleanupGitHub(run);}catch(e){errors.push(redact(e.message));}
  if(!errors.length&&run.manifest.temp)try{
    const exists=await lstat(run.manifest.temp).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(exists){await ownedDirectory(run.manifest.temp,run.manifest.runId);await rm(run.manifest.temp,{recursive:true});}
  }catch(e){errors.push(redact(e.message));}
  run.manifest.cleanup.errors=errors;
  run.manifest.cleanup.complete=run.manifest.cleanup.errors.length===0;
  run.manifest.cleanup.finishedAt=new Date().toISOString();
  run.manifest.cleanup.retained='Private repositories, published main, closed GitHub audit history and local redacted reports are intentionally retained. Fresh repositories are required for another pair.';
  await run.persist();
}
