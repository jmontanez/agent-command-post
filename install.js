#!/usr/bin/env node
// Agent Command Post installer.
//   node install.js               install or update, add Claude Code hooks, start the server
//   node install.js --no-service  same, but do not create the systemd user service
//   node install.js --uninstall   remove the hooks and the service (keeps your data)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const args = new Set(process.argv.slice(2));
const HOME = os.homedir();
const SRC = __dirname;
const DATA = process.env.ACP_DATA || path.join(HOME, '.agent-command-post');
const APP = path.join(DATA, 'app');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const UNIT_DIR = path.join(HOME, '.config', 'systemd', 'user');
const UNIT = path.join(UNIT_DIR, 'agent-command-post.service');
const NODE = process.execPath; // absolute path, so hooks work even when nvm's node is not on PATH
const MARK = 'agent-command-post';
const RELAY_SRC = path.join(SRC, 'relay');
const RELAY_DIR = path.join(DATA, 'relay');

const HOOK_EVENTS = [
  ['SessionStart', false], ['SessionEnd', false], ['UserPromptSubmit', false],
  ['PreToolUse', true], ['PostToolUse', true], ['PostToolUseFailure', true], ['PermissionRequest', true],
  ['Notification', false], ['Stop', false], ['PreCompact', false],
];

const say = m => console.log(m);
const ok = m => console.log('  ✓ ' + m);
const warn = m => console.log('  ! ' + m);

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); }
  catch (e) { console.error(`Could not parse ${SETTINGS}: ${e.message}\nFix that file (or move it aside) and run the installer again. Nothing was changed.`); process.exit(1); }
}
function writeSettings(obj) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    const bak = `${SETTINGS}.acp-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, bak);
    ok(`Backed up your Claude Code settings to ${bak}`);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}
function stripOurHooks(settings) {
  if (!settings.hooks) return settings;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(MARK)) }))
      .filter(g => g.hooks.length);
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}
function addHooks(settings) {
  settings.hooks = settings.hooks || {};
  const command = `"${NODE}" "${path.join(APP, 'hook.js')}"`;
  for (const [ev, toolEvent] of HOOK_EVENTS) {
    const group = { hooks: [{ type: 'command', command, timeout: 5 }] };
    if (toolEvent) group.matcher = '*';
    settings.hooks[ev] = [...(settings.hooks[ev] || []), group];
  }
  return settings;
}
function copyApp() {
  fs.mkdirSync(path.join(APP, 'public'), { recursive: true });
  for (const f of ['server.js', 'hook.js', 'demo.js', 'package.json']) {
    if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(APP, f));
  }
  for (const f of fs.readdirSync(path.join(SRC, 'public'))) fs.copyFileSync(path.join(SRC, 'public', f), path.join(APP, 'public', f));
  ok(`Installed app to ${APP}`);
  const cfg = path.join(DATA, 'config.json');
  if (!fs.existsSync(cfg)) {
    const example = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
    example.accessKey = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(cfg, JSON.stringify(example, null, 2) + '\n');
    ok(`Created ${cfg} (edit it to map your project folders)`);
  } else ok(`Kept your existing ${cfg}`);
}
function hasSystemd() {
  try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}
function installService() {
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(UNIT, `[Unit]
Description=Agent Command Post (TOC server for Claude Code agents)
After=default.target

[Service]
ExecStart="${NODE}" "${path.join(APP, 'server.js')}"
Restart=on-failure
RestartSec=3
Environment=ACP_DATA=${DATA}

[Install]
WantedBy=default.target
`);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', 'agent-command-post.service'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'restart', 'agent-command-post.service']);
  ok('Started the TOC server as a background service (starts again on login)');
}
function startDetached() {
  const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const child = spawn(NODE, [path.join(APP, 'server.js')], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ACP_DATA: DATA } });
  child.unref();
  ok(`Started the TOC server (pid ${child.pid}). Log: ${path.join(DATA, 'server.log')}`);
  warn('It will not restart after a reboot. Run this installer again, or start it with: node ' + path.join(APP, 'server.js'));
}

function findClaude() {
  const candidates = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'claude'));
  candidates.push(path.join(path.dirname(NODE), 'claude'), path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), path.join(HOME, '.npm-global', 'bin', 'claude'));
  return candidates.find(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (e) { return false; } });
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
// The relay lets the board send answers and orders into Claude Code sessions on this computer.
function installRelay() {
  if (!fs.existsSync(RELAY_SRC)) return;
  fs.rmSync(RELAY_DIR, { recursive: true, force: true });
  copyDir(RELAY_SRC, RELAY_DIR);
  const claude = findClaude();
  const manual = () => {
    warn('Could not add the relay to Claude Code automatically. To answer agents from the board, run:');
    say(`      claude plugin marketplace add "${RELAY_DIR}"\n      claude plugin install command-post-relay@agent-command-post --scope user`);
  };
  if (!claude) return manual();
  const run = a => execFileSync(claude, a, { stdio: 'pipe', timeout: 120000, env: { ...process.env, PATH: `${path.dirname(NODE)}${path.delimiter}${process.env.PATH || ''}` } }).toString();
  try {
    let listed = '';
    try { listed = run(['plugin', 'marketplace', 'list']); } catch (e) {}
    if (listed.includes('agent-command-post')) run(['plugin', 'marketplace', 'update', 'agent-command-post']);
    else run(['plugin', 'marketplace', 'add', RELAY_DIR]);
    try { run(['plugin', 'install', 'command-post-relay@agent-command-post', '--scope', 'user']); }
    catch (e) { if (!/already/i.test(String(e.stdout || '') + String(e.stderr || ''))) throw e; }
    ok('Added the relay to Claude Code, so you can answer agents from the board');
  } catch (e) { manual(); }
}
function removeRelay() {
  const claude = findClaude();
  if (!claude) return;
  for (const a of [['plugin', 'uninstall', 'command-post-relay@agent-command-post'], ['plugin', 'marketplace', 'remove', 'agent-command-post']]) {
    try { execFileSync(claude, a, { stdio: 'ignore', timeout: 60000 }); } catch (e) {}
  }
  ok('Removed the relay from Claude Code');
}

// ---------- main ----------
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) { console.error(`Node.js 18 or newer is required (you have ${process.versions.node}).`); process.exit(1); }

if (args.has('--uninstall')) {
  say('Removing Agent Command Post');
  writeSettings(stripOurHooks(readSettings()));
  ok('Removed the hooks from Claude Code settings');
  removeRelay();
  if (fs.existsSync(UNIT)) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'agent-command-post.service'], { stdio: 'ignore' }); } catch (e) {}
    fs.unlinkSync(UNIT);
    try { execFileSync('systemctl', ['--user', 'daemon-reload']); } catch (e) {}
    ok('Removed the background service');
  }
  say(`\nYour data is still in ${DATA}. Delete that folder yourself if you want it gone.`);
  process.exit(0);
}

say('Installing Agent Command Post');
copyApp();
writeSettings(addHooks(stripOurHooks(readSettings())));
ok(`Added hooks to ${SETTINGS}`);
installRelay();
if (!args.has('--no-service')) {
  if (process.platform === 'linux' && hasSystemd()) {
    try { installService(); } catch (e) { warn('systemd service failed: ' + e.message); startDetached(); }
  } else startDetached();
}
let port = 7600;
try { port = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).port || 7600; } catch (e) {}
say(`
Done. Open http://localhost:${port}

Claude Code sessions you start from now on will report in, and you can answer
them or give them new orders from the board. Sessions that were already open
need a restart to pick this up.

Try it without real agents:   node "${path.join(APP, 'demo.js')}"
Map folders to projects:      edit ${path.join(DATA, 'config.json')}
Remove it later:              node "${path.join(SRC, 'install.js')}" --uninstall
`);
