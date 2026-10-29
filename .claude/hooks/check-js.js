#!/usr/bin/env node
// After Claude edits a .js file in app/, run a syntax check. server.js restarts itself on
// every change, so a typo there takes the whole board down. Exit code 2 hands the error
// back to Claude so it fixes it right away.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
let body = '';
process.stdin.on('data', c => { body += c; });
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(body); } catch (e) { process.exit(0); }
  const f = (ev.tool_input || {}).file_path;
  if (!f || !/\.js$/.test(f)) process.exit(0);
  const abs = path.resolve(ev.cwd || process.cwd(), f);
  try { execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { process.stderr.write(`Syntax error in ${path.basename(abs)}. Fix it now: the board restarts from this file.\n${String(e.stderr || '').slice(0, 1500)}\n`); process.exit(2); }
  process.exit(0);
});
