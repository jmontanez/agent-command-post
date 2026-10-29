#!/usr/bin/env node
// Blocks Claude from editing or wiping the command post's live records: state.json,
// history.jsonl and the runs/ logs in the data folder. config.json stays editable so
// projects can still be added. Exit code 2 tells Claude Code to stop the action and
// shows Claude the reason.
'use strict';
const path = require('path');
let body = '';
process.stdin.on('data', c => { body += c; });
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(body); } catch (e) { process.exit(0); }
  const root = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
  const PROTECTED = ['state.json', 'history.jsonl'].map(f => path.join(root, f));
  const RUNS = path.join(root, 'runs') + path.sep;
  const block = why => { process.stderr.write(`Blocked by command post guard: ${why} These are the user's live records of agent work. Change them only through server.js, or ask the user first.\n`); process.exit(2); };
  const t = ev.tool_input || {};
  if (ev.tool_name === 'Bash') {
    const cmd = String(t.command || '');
    if (/(state\.json|history\.jsonl|\bruns\/)/.test(cmd) && /(\brm\b|\bmv\b|\btruncate\b|\bsed\s+-i|\bshred\b|>\s*\S*(state\.json|history\.jsonl)|\btee\b)/.test(cmd))
      block('that command would change or delete state.json, history.jsonl or runs/.');
    process.exit(0);
  }
  const f = t.file_path || t.notebook_path;
  if (!f) process.exit(0);
  const abs = path.resolve(ev.cwd || root, f);
  if (PROTECTED.includes(abs) || abs.startsWith(RUNS)) block(`${path.basename(abs)} is protected.`);
  process.exit(0);
});
