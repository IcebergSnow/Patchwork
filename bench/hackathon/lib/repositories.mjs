import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { command, repoName, runId, ownedDirectory, json, root, save, defaultOutput } from './common.mjs';
import { seedRepository, scenarioHash, seedInfo } from './scenario.mjs';

export async function api(endpoint, {method='GET',body,env=process.env}={}) {
  const args=['api','--hostname','github.com','--method',method,endpoint];
  if(body)args.push('--input','-');
  const text=await command('gh',args,{env,input:body&&JSON.stringify(body)});
  return text.trim()?JSON.parse(text):null;
}
export async function pages(endpoint, options) {
  const all=[];
  for(let page=1;;page++){
    const batch=await api(`${endpoint}${endpoint.includes('?')?'&':'?'}per_page=100&page=${page}`,options);
    if(!Array.isArray(batch))throw new Error('Unexpected GitHub list response.');
    all.push(...batch);if(batch.length<100)return all;
  }
}
export async function inspect(repo) {
  try { return await api(`/repos/${repoName(repo)}`); }
  catch(e){if(/HTTP 404/.test(e.message))return null;throw e;}
}
export async function assertNotSource(repo) {
  const pkg=await json(path.join(root,'packages/cli/package.json'));
  const source=pkg.repository.url.match(/github\.com\/([^/]+\/[^/]+?)\.git$/)?.[1];
  if(!source||repo.toLowerCase()===source.toLowerCase())throw new Error('Refusing the Patchwork source repository.');
}
export async function cleanSandbox(repo, expected, request=api) {
  repoName(repo);await assertNotSource(repo);
  const remote=await request(`/repos/${repo}`),user=await request('/user');
  if(remote.full_name.toLowerCase()!==repo.toLowerCase()||!remote.private||remote.owner.id!==user.id||!remote.permissions?.admin||remote.archived||remote.disabled||!remote.has_issues||remote.default_branch!=='main')
    throw new Error('Use an owned private sandbox with Issues enabled and main as default branch.');
  const [main,branches,issues,tags]=await Promise.all([
    request(`/repos/${repo}/git/ref/heads/main`),request(`/repos/${repo}/branches?per_page=100`),
    request(`/repos/${repo}/issues?state=all&per_page=1`),request(`/repos/${repo}/tags?per_page=1`),
  ]);
  if(main.object.sha!==expected.commit||branches.length!==1||branches[0].name!=='main'||issues.length||tags.length)
    throw new Error('Sandbox is not pristine. Refusing to rewrite main or erase history. Use fresh-pair --from-run RUN_ID --allow-create for a new pair at the original starter commit.');
  return {id:remote.id,repo:remote.full_name,userId:user.id,login:user.login,initialCommit:main.object.sha};
}
export async function setupRepositories(options, dependencies={api,inspect,command}) {
  if(!options['allow-create'])throw new Error('setup requires --allow-create; it never launches agents.');
  const user=await dependencies.api('/user');
  const names=[options['baseline-repo'],options['patchwork-repo']].map(name=>{
    const repo=repoName(name?.includes('/')?name:`${user.login}/${name||''}`);
    if(repo.split('/')[0].toLowerCase()!==user.login.toLowerCase())throw new Error('Setup creates repositories only under the authenticated personal account.');
    return repo;
  });
  if(new Set(names.map(n=>n.toLowerCase())).size!==2)throw new Error('Two distinct repositories are required.');
  for(const name of names)await assertNotSource(name);
  // Inspect BOTH before any mutation. Existing data is never overwritten,
  // initialized, reset, made private, or deleted by this command.
  const existing=await Promise.all(names.map(n=>dependencies.inspect(n)));
  if(options.fresh&&existing.some(Boolean))throw new Error('Fresh repository name collision; existing repositories were left untouched. No automatic retry.');
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'patchwork-setup-')));
  const output=path.resolve(options.output||defaultOutput);
  const setupId=`setup-${randomUUID()}`;
  const receipt=path.join(output,'setups',`${setupId}.json`);
  const result={setupId,createdAt:new Date().toISOString(),plannedRepositories:names,repositories:[],...(options.parentRun&&{parentRun:options.parentRun})};
  const persist=async()=>{await save(receipt,result);await save(path.join(output,'setup.json'),result);};
  try {
    result.commit=await seedRepository(dir);result.scenarioHash=await scenarioHash();
    if(options.expectedSeed&&(result.commit!==options.expectedSeed.commit||result.scenarioHash!==options.expectedSeed.hash))
      throw new Error('Starter changed since the original comparison. Refusing to create a different experiment; restore that starter version first.');
    // Older versions wrote only setup.json. Preserve that receipt before the
    // convenience latest pointer changes; run reports are never overwritten.
    const previous=await json(path.join(output,'setup.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(previous&&!previous.setupId)await save(path.join(output,'setups',`legacy-${randomUUID()}.json`),previous);
    await persist(); // journal before the first potentially uncertain creation
    for(let i=0;i<names.length;i++){
      const repo=names[i],condition=i?'patchwork':'baseline';
      if(existing[i]){
        result.repositories.push({repo,condition,action:'existing-untouched',id:existing[i].id,private:existing[i].private,defaultBranch:existing[i].default_branch});
        continue;
      }
      const created=await dependencies.api('/user/repos',{method:'POST',body:{name:repo.split('/')[1],private:true,has_issues:true,has_projects:false,has_wiki:false,description:'Isolated Patchwork booking simulator sandbox'}});
      if(!created.private||created.full_name.toLowerCase()!==repo.toLowerCase()||created.owner.id!==user.id)throw new Error('Unexpected repository creation result; refusing initialization.');
      result.repositories.push({repo,condition,action:'created',id:created.id,initialized:false});
      await persist();
      await (dependencies.command||command)('git',['-C',dir,'-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push',`https://github.com/${repo}.git`,'HEAD:refs/heads/main']);
      result.repositories.at(-1).initialized=true;
      if(options.fresh)await cleanSandbox(repo,{commit:result.commit},dependencies.api);
      await persist();
    }
    result.receipt=receipt;
    result.commands={baseline:`npm run sim -- trial --condition baseline --repo ${names[0]} --peer-repo ${names[1]} --sandbox-repo --allow-live`,patchwork:`npm run sim -- trial --condition patchwork --repo ${names[1]} --baseline-run BASELINE_RUN_ID --sandbox-repo --allow-live`};
    await persist();
    return result;
  } finally {await rm(dir,{recursive:true,force:true});}
}
export async function freshPair(options,dependencies={api,inspect,command}) {
  if(!options['allow-create'])throw new Error('fresh-pair requires --allow-create; it creates private repositories but never launches agents.');
  const output=path.resolve(options.output||defaultOutput),id=runId(options['from-run']);
  const dir=path.join(output,id);await ownedDirectory(dir,id);
  const m=await json(path.join(dir,'manifest.json'));
  if(m.version!==1||m.runId!==id||m.kind!=='comparison'||!['baseline','patchwork'].includes(m.condition)||!m.cleanup?.complete)
    throw new Error('Use a Phase 1 run with completed cleanup. No repository was changed.');
  if(!/^[a-f0-9]{40}$/.test(m.initialCommit||'')||!/^[a-f0-9]{64}$/.test(m.scenarioHash||''))throw new Error('Original starter identity is missing; refusing to guess.');
  const original=[repoName(m.condition==='baseline'?m.repo:m.peerRepo),repoName(m.condition==='patchwork'?m.repo:m.peerRepo)];
  if(original[0].toLowerCase()===original[1].toLowerCase())throw new Error('Original pair must contain two distinct repositories.');
  for(const repo of original)await assertNotSource(repo);
  const suffix=randomUUID().replaceAll('-','').slice(0,12);
  const names=original.map(repo=>`${repo.replace(/-sim-[a-f0-9]{12}$/,'')}-sim-${suffix}`);
  return setupRepositories({...options,fresh:true,parentRun:id,'baseline-repo':names[0],'patchwork-repo':names[1],expectedSeed:{commit:m.initialCommit,hash:m.scenarioHash}},dependencies);
}
export async function validatePair(baseline,patchwork){
  if(repoName(baseline).toLowerCase()===repoName(patchwork).toLowerCase())throw new Error('Conditions need distinct repositories.');
  const seed=await seedInfo();
  const repositories=await Promise.all([cleanSandbox(baseline,seed),cleanSandbox(patchwork,seed)]);
  return {seed,repositories};
}
