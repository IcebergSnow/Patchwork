import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
const wrangler = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url).pathname;
await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'patchwork', '--local']);
const server = spawn(process.execPath, [wrangler, 'dev', '--ip', '127.0.0.1', '--port', '8791'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview stopped: ${output}`);
    try { ready = (await fetch('http://127.0.0.1:8791/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Starting. */ }
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error(`Preview did not become ready: ${output}`);
  await run(process.execPath, ['--import', 'tsx', 'scripts/smoke.ts'], { ...process.env, PATCHWORK_BASE_URL: 'http://127.0.0.1:8791' });
} catch (error) {
  console.error(output);
  throw error;
} finally {
  server.kill('SIGTERM');
}
