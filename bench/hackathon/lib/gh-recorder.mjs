import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// GH_DEBUG can contain credentials and bodies. Only a verb/status counter is
// retained; debug output is never forwarded or saved. stdout stays untouched.
export function requestLine(line) {
  const match=line.match(/^> (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ HTTP\//);
  return match ? match[1] : null;
}
export function runGh(realGh, log, args) {
  const child=spawn(realGh,args,{env:{...process.env,GH_DEBUG:'api'},stdio:['pipe','pipe','pipe']});
  process.stdin.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(process.stdout);
  let status;
  createInterface({input:child.stderr}).on('line',line=>{
    const method=requestLine(line);
    if(method) appendFileSync(log,JSON.stringify({timestamp:new Date().toISOString(),method})+'\n',{mode:0o600});
    const match=line.match(/^< HTTP\/\S+ (\d+)/);if(match)status=Number(match[1]);
  });
  child.on('error',()=>{process.stderr.write('GitHub CLI could not start.\n');process.exitCode=1;});
  child.on('close',code=>{if(code)process.stderr.write(`GitHub CLI failed${status?` (HTTP ${status})`:''}.\n`);process.exitCode=code??1;});
}
