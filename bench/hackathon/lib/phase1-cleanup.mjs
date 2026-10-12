import path from 'node:path';
import { lstat, rm } from 'node:fs/promises';
import { command, ownedDirectory, redact, save } from './common.mjs';
import { api, pages } from './repositories.mjs';
import { cleanup } from './preflight.mjs';
import { roles } from './scenario.mjs';

export async function repositoryAfterCleanup(run,deps={api,pages}) {
  const m=run.manifest;
  const [main,branches,issues,tags]=await Promise.all([
    deps.api(`/repos/${m.repo}/git/ref/heads/main`),deps.pages(`/repos/${m.repo}/branches`),
    deps.pages(`/repos/${m.repo}/issues?state=all`),deps.pages(`/repos/${m.repo}/tags`),
  ]);
  if(!main?.object?.sha)throw new Error('Could not verify main after cleanup.');
  const atStarter=main.object.sha===m.initialCommit;
  const reusable=atStarter&&branches.length===1&&branches[0].name==='main'&&issues.length===0&&tags.length===0;
  return {verifiedAt:new Date().toISOString(),starterCommit:m.initialCommit,currentMain:main.object.sha,atStarter,reusable,
    resetPerformed:false,branches:branches.map(b=>({name:b.name,sha:b.commit?.sha})),issues:issues.map(i=>({number:i.number,state:i.state,url:i.html_url})),tags:tags.map(t=>t.name),
    reason:reusable?'Already pristine; no reset needed.':!atStarter?'Main advanced or changed. Resetting it would rewrite history and is refused.':'GitHub history or other refs remain; this repository is not a clean experiment.',
    nextCommand:`npm run sim -- fresh-pair --from-run ${m.runId} --allow-create`};
}

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
    const expected=m.cleanupBranchHeads?.[b.name];
    if(!expected||b.commit.sha!==expected)throw new Error(`Branch ${b.name} has no matching saved run snapshot or changed after it; preserved. Refusing to refresh the deletion lease from current remote state.`);
    // The lease checks the observed SHA atomically; a concurrent update cannot
    // be silently deleted. Never reset, rewrite, merge, or delete main.
    await deps.command('git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push',`--force-with-lease=refs/heads/${b.name}:${expected}`,`https://github.com/${m.repo}.git`,`:refs/heads/${b.name}`]);
    m.removedBranches.push(b.name);await run.persist();
  }
  m.cleanup.repository=await repositoryAfterCleanup(run,deps);
  if(m.cleanup.repository.branches.some(b=>roles.some(r=>b.name===`${m.runId}/${r}`)))throw new Error('A run branch remains or was recreated; refusing to delete it again without a matching run snapshot.');
  await run.persist();
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
  run.manifest.cleanup.retained='Repositories and submitted main commits remain on GitHub, together with closed issues/PRs/boards, comments, retired registration records and labels. Local reports, logs and bundles remain. Cleanup never rewrites main or erases history; fresh-pair automatically prepares the next comparison at the original starter commit.';
  await run.persist();
}
