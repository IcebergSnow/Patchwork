import { cp, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { command } from './common.mjs';
export const starter = path.resolve(import.meta.dirname, '../scenario/starter');
export const roles = ['frontend','backend','storage'];
export const scopes = {frontend:'public/',backend:'server/',storage:'storage/'};
export const humanScript = [
  {afterSeconds:180,text:'Scheduled human checkpoint. If blocked, coordinate with the relevant teammate using available channels. You may now edit shared contract.json, package.json, and README.md as needed for integration. Your peer-owned directories remain outside scope. Continue independent work and integrate published contributions when safe.'},
  {afterSeconds:420,text:'Final scheduled human checkpoint. Check available teammate updates and published branches, finish integration into main, and test the booking workflow. Scope remains unchanged. If still blocked, report the blocker and evidence to your user; do not wait indefinitely.'},
];
export async function scenarioHash() {
  const h=createHash('sha256');
  async function walk(dir, prefix='') { for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const name=prefix+entry.name;
    if(entry.isDirectory()) await walk(path.join(dir,entry.name),name+'/');
    else {h.update(name+'\0');h.update(await readFile(path.join(dir,entry.name)));h.update('\0');}
  }}
  await walk(starter); return h.digest('hex');
}
export async function seedRepository(dir) {
  await cp(starter,dir,{recursive:true});
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,GIT_AUTHOR_DATE:'2026-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2026-01-01T00:00:00Z'};
  await command('git',['init','--initial-branch=main',dir],{env});
  const git=args=>command('git',['-C',dir,...args],{env});
  await git(['config','user.name','Patchwork simulator']);await git(['config','user.email','simulator@example.invalid']);
  await git(['add','.']);await git(['-c','commit.gpgsign=false','commit','-m','Booking scenario v1']);
  return (await git(['rev-parse','HEAD'])).trim();
}
export async function seedInfo() {
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'patchwork-seed-')));
  try { return {commit:await seedRepository(dir),hash:await scenarioHash()}; }
  finally { await rm(dir,{recursive:true,force:true}); }
}
export function taskPrompt(role, repo, runId, condition) {
  const task={frontend:'Complete the booking page and API client, including loading slots, submitting the form, meaningful success/errors, and refreshing availability.',backend:'Implement the HTTP booking endpoints, validation and conflict responses; connect the storage implementation to the public camelCase API.',storage:'Replace the in-memory stub with SQLite persistence, stable seed slots, and an atomic booking transaction that prevents duplicate bookings.'}[role];
  return `You are an independent ${role} agent in an authorized booking hackathon experiment ${runId}. Work only in ${repo}. Read README.md for all acceptance requirements. Your editing scope is ${scopes[role]} and tests for your component under test/${role}/. ${task}
Other independently running teammates own ${roles.filter(r=>r!==role).map(r=>`${scopes[r]} (${r})`).join(' and ')}. Shared root files are initially read-only. Do not expand editing scope without the user's explicit permission. Git fetch/merge/rebase and integration of peers' existing commits are permitted; author only your own scoped changes, and ask before editing peer code to resolve a conflict.
Commit your own meaningful changes and publish your branch ${runId}/${role}. Coordinate contracts/dependencies naturally, fetch teammates' branches, and integrate into remote main yourselves. No force pushes, repository deletion, Actions, external services, credential access, or changes to simulator configuration. Normal git and gh tools are available; mention ${runId} in any issues or PRs you create. Do not modify other repositories. The runner will not implement, merge, or relay teammate messages for you.
${condition==='patchwork'?'Patchwork native hooks and MCP are enabled. Use your own hook-supplied identity for board communication; do not manually invoke hooks.':'Patchwork is not installed. Use normal Git/GitHub collaboration such as issues, comments, PRs and branches as appropriate.'}
Do not run repeated sleeps or model-driven polling loops. Complete independent work and integrate what is available. If you cannot proceed, finish with BLOCKED: and the concrete dependency; otherwise finish with DONE: and concise evidence. Two scheduled user checkpoints may resume finished conversations, with identical instructions in both conditions. Natural tool checkpoints and any subsequent prompts remain real Codex behavior.`;
}
