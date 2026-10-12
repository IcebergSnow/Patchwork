#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { connect } from '../lib/connect.js';

async function pairingCode() {
  if (!process.stdin.isTTY) throw new Error('Enter your pairing code in an interactive terminal. Codes are never accepted as command-line arguments.');
  process.stdout.write('Pairing code (hidden): ');
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  rl.on('SIGINT', () => controller.abort());
  try { return (await rl.question('', { signal: controller.signal })).trim(); }
  finally { rl.close(); process.stdout.write('\n'); }
}

try {
  let args;
  try { args = parseArgs({ allowPositionals: true, options: { server: { type: 'string' }, 're-pair': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }); }
  catch { throw new Error('Invalid arguments. Use patchwork --help.'); }
  if (args.values.help) {
    console.log('Usage: patchwork connect --server https://your-patchwork.example [--re-pair]\nRun inside your project’s Git worktree. Node.js 22.13+ and Git are required.\nA room member supplies the single-use pairing code. Reruns repair the saved connection.\nUse --re-pair only to replace a connection, such as after token revocation.');
  } else {
    if (args.positionals.length !== 1 || args.positionals[0] !== 'connect' || !args.values.server) throw new Error('Use: patchwork connect --server https://your-patchwork.example');
    await connect({ server: args.values.server, rePair: args.values['re-pair'], pairingCode });
  }
} catch (error) {
  // Expected messages are local constants. OS/parser/remote details could contain secrets.
  const message = error?.code || error?.name === 'AbortError' ? 'Installation interrupted or a local file could not be updated. Check permissions and rerun.' : error.message;
  console.error(message || 'Installation failed. Rerun to repair the saved connection.');
  process.exitCode = 1;
}
