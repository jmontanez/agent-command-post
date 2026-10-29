#!/usr/bin/env node
// Agent Command Post demo: sends realistic Claude Code hook events for a few fake agents,
// so you can see the map work (and record a GIF) without running real sessions.
//   node demo.js            run until Ctrl+C
//   node demo.js --fast     shorter waits
// Fake units are removed from the board when you stop the demo.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let port = 7600;
try { port = JSON.parse(fs.readFileSync(path.join(process.env.ACP_DATA || path.join(os.homedir(), '.agent-command-post'), 'config.json'), 'utf8')).port || 7600; } catch (e) {}
const FAST = process.argv.includes('--fast');
const sleep = ms => new Promise(r => setTimeout(r, FAST ? ms / 3 : ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const H = os.homedir();

function post(ev) {
  return new Promise(res => {
    const body = JSON.stringify(ev);
    const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => { r.resume(); r.on('end', res); });
    req.on('error', () => { console.error(`Cannot reach the command post on port ${port}. Is the server running?`); process.exit(1); });
    req.end(body);
  });
}

const AGENTS = [
  { cwd: `${H}/projects/storefront`, prompt: 'Add Apple Pay to the checkout page and update the tests',
    todos: ['Read the current checkout flow', 'Add the Apple Pay button', 'Handle failed payments', 'Update checkout tests'],
    asks: ['The payment provider supports two button styles. Match the brand colors or use the default?'] },
  { cwd: `${H}/projects/mobile-app`, prompt: 'Fix the login crash on older Android phones',
    todos: ['Reproduce the crash', 'Patch the token refresh', 'Write a regression test'],
    asks: ['The fix needs a newer minimum Android version. Raise it or add a fallback?'] },
  { cwd: `${H}/projects/data-pipeline`, prompt: 'Clean last month of sales data and build the weekly report',
    todos: ['Load the raw sales export', 'Remove duplicate orders', 'Build the weekly charts'],
    asks: ['Found 214 duplicate rows. Drop them or merge them?'] },
  { cwd: `${H}/projects/docs-site`, prompt: 'Write the getting-started guide and fix broken links',
    todos: ['Audit broken links', 'Draft the getting-started guide', 'Add code examples', 'Check every page builds'],
    asks: ['Two pages cover the same setup step. Merge them or keep both?'] },
  { cwd: `${H}/projects/marketing-site`, prompt: 'Draft the landing page copy',
    todos: ['Draft landing page copy', 'Build the pricing section'],
    asks: [] , permission: true },
];
const TOOLS = [['Read', { file_path: 'notes.md' }], ['Grep', { pattern: 'TODO' }], ['Bash', { command: 'npm test' }], ['WebSearch', { query: 'library docs' }], ['Edit', { file_path: 'draft.md' }]];

const ids = [];
async function runAgent(a, i) {
  const session_id = `demo-${i}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(session_id);
  const base = { session_id, cwd: a.cwd, transcript_path: '' };
  await sleep(i * 1500);
  await post({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
  await sleep(1500);
  await post({ ...base, hook_event_name: 'UserPromptSubmit', prompt: a.prompt });
  const todos = a.todos.map((t, k) => ({ content: t, activeForm: t.replace(/^(\w+)/, m => m.replace(/e?$/, 'ing')), status: k === 0 ? 'in_progress' : 'pending' }));
  const writeTodos = async () => {
    const ev = { ...base, tool_name: 'TodoWrite', tool_input: { todos } };
    await post({ ...ev, hook_event_name: 'PreToolUse' });
    await post({ ...ev, hook_event_name: 'PostToolUse', tool_response: {} });
  };
  await writeTodos();
  let asked = false;
  for (let k = 0; k < todos.length; k++) {
    todos[k].status = 'in_progress'; await writeTodos();
    const steps = Math.round(rnd(3, 6));
    for (let s = 0; s < steps; s++) {
      const [tool_name, tool_input] = pick(TOOLS);
      await post({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input });
      if (a.permission && !asked && k === 0 && s === 1) {
        asked = true;
        await post({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Claude needs your permission to use ${tool_name}` });
        await sleep(rnd(15000, 25000));
      }
      await sleep(rnd(2000, 5000));
      await post({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {} });
      if (!asked && a.asks.length && k === 1 && s === 0) {
        asked = true;
        const q = { ...base, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: a.asks[0] }] } };
        await post({ ...q, hook_event_name: 'PreToolUse' });
        await sleep(rnd(12000, 25000));
        await post({ ...q, hook_event_name: 'PostToolUse', tool_response: {} });
      }
    }
    todos[k].status = 'completed'; await writeTodos();
  }
  await post({ ...base, hook_event_name: 'Stop' });
}

async function cleanup() {
  console.log('\nStopping demo, clearing fake units…');
  for (const id of ids) await new Promise(r => { const req = http.request({ host: '127.0.0.1', port, path: '/api/remove/' + id, method: 'POST' }, x => { x.resume(); x.on('end', r); }); req.on('error', r); req.end(); });
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log(`Demo running against http://localhost:${port}. Press Ctrl+C to stop and clear the fake units.`);
Promise.all(AGENTS.map(runAgent)).then(() => console.log('Demo finished. All demo units ready for orders. Ctrl+C to clear them.'));
