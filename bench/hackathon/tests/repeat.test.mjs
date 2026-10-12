import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, newRun, json, save } from '../lib/common.mjs';
import { freshPair } from '../lib/repositories.mjs';
import { cleanupGitHub, repositoryAfterCleanup } from '../lib/phase1-cleanup.mjs';
import { seedInfo, seedRepository } from '../lib/scenario.mjs';

async function temp(t){const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'patchwork-repeat-test-')));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function previousRun(output){
  const run=await newRun({output,kind:'comparison',repo:'owner/baseline'}),seed=await seedInfo();
  Object.assign(run.manifest,{condition:'baseline',peerRepo:'owner/enabled',initialCommit:seed.commit,scenarioHash:seed.hash,cleanup:{complete:true,errors:[]}});
  await run.persist();return run;
}
function fakeSetup(seed,{collide=false,failPush=false}={}) {
  const repos=new Map(),mutations=[],pushes=[];
  return {repos,mutations,pushes,
    inspect:async()=>collide?{id:99}:null,
    api:async(route,options)=>{
      if(route==='/user')return {login:'owner',id:7};
      if(route==='/user/repos'){
        assert.equal(options.method,'POST');assert.equal(options.body.private,true);
        const repo=`owner/${options.body.name}`,remote={id:repos.size+1,full_name:repo,owner:{id:7},private:true,permissions:{admin:true},has_issues:true,default_branch:'main'};
        repos.set(repo,remote);mutations.push(repo);return remote;
      }
      if(route.endsWith('/git/ref/heads/main'))return {object:{sha:seed}};
      if(route.includes('/branches?'))return [{name:'main'}];
      if(route.includes('/issues?')||route.includes('/tags?'))return [];
      assert(repos.has(route.replace('/repos/','')),`Unexpected API access: ${route}`);return repos.get(route.replace('/repos/',''));
    },
    command:async(program,args)=>{assert.equal(program,'git');assert(args.includes('HEAD:refs/heads/main'));assert(!args.some(a=>a.startsWith('--force')));pushes.push(args);if(failPush)throw new Error('push interrupted');},
  };
}
test('repeated fresh pairs pin the original commit, automatically choose names and preserve all prior records',async t=>{
  const output=await temp(t),run=await previousRun(output),m=run.manifest;
  await writeFile(path.join(run.dir,'report.md'),'Original results must survive.');
  const before=await readFile(path.join(run.dir,'manifest.json'),'utf8');
  const legacy={commit:m.initialCommit,scenarioHash:m.scenarioHash,repositories:[{repo:m.repo},{repo:m.peerRepo}]};await save(path.join(output,'setup.json'),legacy);
  const deps=fakeSetup(m.initialCommit),options={output,'from-run':m.runId,'allow-create':true};
  const first=await freshPair(options,deps),firstBytes=await readFile(first.receipt,'utf8');
  const second=await freshPair(options,deps);
  assert.equal(first.commit,m.initialCommit);assert.equal(second.commit,m.initialCommit);assert.equal(first.scenarioHash,m.scenarioHash);
  assert.equal(new Set(deps.mutations).size,4);assert.equal(deps.pushes.length,4);
  assert(first.repositories.every(r=>r.initialized&&r.repo.includes('-sim-')));
  assert.match(first.commands.baseline,/--peer-repo owner\/enabled-sim-/);
  assert.equal(await readFile(first.receipt,'utf8'),firstBytes);assert.equal(await readFile(path.join(run.dir,'manifest.json'),'utf8'),before);
  assert.equal(await readFile(path.join(run.dir,'report.md'),'utf8'),'Original results must survive.');
  const files=await readdir(path.join(output,'setups'));assert.equal(files.length,3);assert.deepEqual(await json(path.join(output,'setups',files.find(n=>n.startsWith('legacy-')))),legacy);
});
test('fresh pair creation requires opt-in, finished cleanup and a verifiable original seed',async t=>{
  const output=await temp(t),run=await previousRun(output),m=run.manifest,deps=fakeSetup(m.initialCommit);
  await assert.rejects(freshPair({output,'from-run':m.runId},deps),/allow-create/);
  const options={output,'from-run':m.runId,'allow-create':true};
  m.version=2;await run.persist();await assert.rejects(freshPair(options,deps),/Phase 1 run/);m.version=1;
  m.cleanup.complete=false;await run.persist();await assert.rejects(freshPair(options,deps),/completed cleanup/);
  m.cleanup.complete=true;m.initialCommit='f'.repeat(40);await run.persist();await assert.rejects(freshPair(options,deps),/Starter changed/);
  m.initialCommit=null;await run.persist();await assert.rejects(freshPair(options,deps),/identity is missing/);
  assert.equal(deps.mutations.length,0);
});
test('collisions and partial creation never overwrite existing repositories or erase receipts',async t=>{
  const output=await temp(t),run=await previousRun(output),options={output,'from-run':run.manifest.runId,'allow-create':true};
  const collision=fakeSetup(run.manifest.initialCommit,{collide:true});await assert.rejects(freshPair(options,collision),/collision/);assert.equal(collision.mutations.length,0);
  const failed=fakeSetup(run.manifest.initialCommit,{failPush:true});await assert.rejects(freshPair(options,failed),/interrupted/);
  const receipt=await json(path.join(output,'setup.json'));assert.equal(receipt.repositories.length,1);assert.equal(receipt.repositories[0].initialized,false);assert.equal(receipt.plannedRepositories.length,2);
  assert.equal((await readdir(path.join(output,'setups'))).length,1);assert.equal(failed.mutations.length,1);
});
function stateApi({main='seed',issues=[],branches=[{name:'main',commit:{sha:main}}],tags=[]}={}) {
  return {api:async()=>({object:{sha:main}}),pages:async route=>route.endsWith('/branches')?branches:route.endsWith('/tags')?tags:issues};
}
test('cleanup completion and reusable starter state are separate; old board history disqualifies reuse',async()=>{
  const run={manifest:{repo:'owner/base',runId:'sim-test',initialCommit:'seed'}};
  const pristine=await repositoryAfterCleanup(run,stateApi());assert(pristine.atStarter&&pristine.reusable&&!pristine.resetPerformed);
  for(const state of [{main:'result'},{issues:[{number:1,state:'closed'}]},{branches:[{name:'main'},{name:'foreign'}]},{tags:[{name:'keep'}]}]){
    const result=await repositoryAfterCleanup(run,stateApi(state));assert.equal(result.reusable,false);assert.equal(result.resetPerformed,false);assert.match(result.nextCommand,/fresh-pair/);
  }
  await assert.rejects(repositoryAfterCleanup(run,{api:async()=>({}),pages:async()=>[]}),/verify main/);
});
test('main advanced by a real commit is retained; branch deletion uses the archived SHA and detects races',async t=>{
  const output=await temp(t),work=path.join(output,'work'),seed=await seedRepository(work);
  const git=args=>command('git',['-C',work,...args]);
  await writeFile(path.join(work,'result.txt'),'preserve experiment result');await git(['add','.']);await git(['-c','commit.gpgsign=false','commit','-m','experiment result']);
  const result=(await git(['rev-parse','HEAD'])).trim(),remote=path.join(output,'remote.git');
  await command('git',['clone','--bare',work,remote]);
  const run=await newRun({output,kind:'comparison',repo:'owner/base'}),m=run.manifest,name=`${m.runId}/frontend`;
  m.initialCommit=seed;m.repository={id:1,userId:7};m.cleanupBranchHeads={[name]:result};
  await command('git',['--git-dir',remote,'update-ref',`refs/heads/${name}`,result]);
  const head=()=>command('git',['--git-dir',remote,'rev-parse','main']);
  let race=false,deleteCalls=0;
  const deps={api:async route=>route==='/user'?{id:7}:route.endsWith('/git/ref/heads/main')?{object:{sha:(await head()).trim()}}:{id:1,full_name:m.repo},
    pages:async route=>route.endsWith('/branches')?(await command('git',['--git-dir',remote,'for-each-ref','--format=%(refname:strip=2) %(objectname)','refs/heads'])).trim().split('\n').filter(Boolean).map(line=>{const [name,sha]=line.split(' ');return {name,commit:{sha}};}):[],
    command:async(program,args)=>{deleteCalls++;if(race)await command('git',['--git-dir',remote,'update-ref',`refs/heads/${name}`,seed]);return command(program,args.map(a=>a===`https://github.com/${m.repo}.git`?remote:a));},
  };
  // A change that happened BEFORE cleanup must not be accepted as a new lease.
  await command('git',['--git-dir',remote,'update-ref',`refs/heads/${name}`,seed]);
  await assert.rejects(cleanupGitHub(run,deps),/changed after/);assert.equal(deleteCalls,0);
  await command('git',['--git-dir',remote,'update-ref',`refs/heads/${name}`,result]);race=true;
  await assert.rejects(cleanupGitHub(run,deps));assert.equal((await head()).trim(),result);
  await assert.rejects(cleanupGitHub(run,deps),/changed after/); // retry must retain original lease
  await command('git',['--git-dir',remote,'update-ref',`refs/heads/${name}`,result]);race=false;
  await cleanupGitHub(run,deps);await cleanupGitHub(run,deps);
  assert.equal((await head()).trim(),result);assert.equal(m.cleanup.repository.reusable,false);assert.equal(m.cleanup.repository.starterCommit,seed);
  assert.deepEqual(m.cleanup.repository.branches.map(b=>b.name),['main']);
});
