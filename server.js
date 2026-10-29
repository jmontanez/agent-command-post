#!/usr/bin/env node
// Agent Command Post — local TOC server.
// Receives Claude Code hook events, tracks each session as a unit, and serves the live map.
// Zero dependencies. Everything stays on this machine unless you turn on ntfy alerts.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync, spawn } = require('child_process');

const HOME = os.homedir();
const DATA_DIR = process.env.ACP_DATA || path.join(HOME, '.agent-command-post');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULTS = {
  port: 7600,
  lanAccess: false,
  accessKey: '',
  lostCommsMinutes: 5,
  lostCommsInToolMinutes: 20,
  appLostCommsMinutes: 45,
  staleHours: 8,
  flagsHours: 24,
  showIdleProjects: true,
  desktopNotifications: true,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyIncludeDetails: false,
  claudeCommand: '',
  terminal: '',
  projects: [],
};

// ---------- config ----------
let config = { ...DEFAULTS };
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...DEFAULTS, ...raw };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[acp] config.json unreadable, using defaults:', e.message);
    config = { ...DEFAULTS };
  }
  config.projects = (config.projects || []).map((p, i) => ({
    code: String(p.code || `AO${i + 1}`).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || `AO${i + 1}`,
    name: String(p.name || p.code || `Project ${i + 1}`),
    match: (p.match || []).map(norm).filter(Boolean),
  }));
}
function norm(s) { return String(s || '').toLowerCase().replace(/[\s_]+/g, '-'); }
loadConfig();
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => { loadConfig(); broadcast(); });

// ---------- state ----------
const now = () => Date.now();
let state = { aos: {}, sessions: {}, log: [], stats: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch (e) {}
function dayKey(t = now()) { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
function freshStats() { return { day: dayKey(), done: 0, calls: 0, answered: 0, respTotal: 0, secured: [], units: [] }; }
if (!state.stats || state.stats.day !== dayKey()) state.stats = freshStats();
for (const [id, s] of Object.entries(state.sessions || {})) if (/[\\/]\.config[\\/]Claude[\\/]scratch-workspaces[\\/]/.test(s.cwd || '') && String(s.ao).startsWith('dir:')) delete state.sessions[id];
if (state.aos && state.aos['app:desktop-chats'] && state.aos['app:desktop-chats'].code !== 'CHATS') { for (const [id, x] of Object.entries(state.sessions || {})) if (x.ao === 'app:desktop-chats') delete state.sessions[id]; delete state.aos['app:desktop-chats']; }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, STATE_PATH);
    } catch (e) { console.error('[acp] could not save state:', e.message); }
  }, 1000);
}

function log(msg, cls = '') {
  state.log.push({ at: now(), msg, cls });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}
// Permanent service record: one JSON line per event worth keeping. Never trimmed.
function record(type, s, extra = {}) {
  const ao = s ? state.aos[s.ao] : null;
  const row = { t: now(), type, ...(s ? { sid: s.id, call: s.call, source: s.source || 'cli' } : {}), ...(ao ? { ao: ao.code, aoName: ao.name } : {}), ...extra };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(HISTORY_PATH, JSON.stringify(row) + '\n'); }
  catch (e) { console.error('[acp] could not write history:', e.message); }
}
// Sample agents (demo.js and test runs) leave no trace in your flags or service record.
function purgeSample(id) {
  let n = 0;
  for (const ao of Object.values(state.aos)) { const before = ao.flags.length; ao.flags = ao.flags.filter(f => !f.id.startsWith(id + ':')); n += before - ao.flags.length; }
  if (state.stats) state.stats.done = Math.max(0, state.stats.done - n);
  try {
    const kept = fs.readFileSync(HISTORY_PATH, 'utf8').split('\n').filter(l => { if (!l) return false; try { return !String(JSON.parse(l).sid || '').startsWith(id); } catch (e) { return true; } });
    fs.writeFileSync(HISTORY_PATH, kept.join('\n') + (kept.length ? '\n' : ''));
  } catch (e) {}
  delete state.sessions[id];
}
function rollDay() { if (state.stats.day !== dayKey()) state.stats = freshStats(); }

// ---------- areas of operation ----------
function aoFor(cwd) {
  const p = norm(cwd);
  for (const proj of config.projects) {
    if (proj.match.some(m => p.includes(m))) return ensureAo(`cfg:${proj.code}`, proj.code, proj.name, false);
  }
  // Unmatched: one AO per top-level folder under home (or the folder name if outside home).
  let rel = cwd ? path.relative(HOME, cwd) : '';
  let top = (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? path.basename(cwd || '') : rel.split(path.sep)[0];
  if (!cwd || path.resolve(cwd) === path.resolve(HOME)) top = 'home';
  top = top || 'field';
  return ensureAo(`dir:${top}`, null, top, true);
}
// Chats started in the Claude desktop app without a project folder run in a scratch folder.
const isScratch = cwd => /[\\/]\.config[\\/]Claude[\\/]scratch-workspaces[\\/]/.test(String(cwd || ''));
// Claude app sessions check in by project name instead of folder.
function aoForProject(name, hint) {
  const p = norm(name);
  const h = norm(`${name || ''} ${cleanText(hint)}`);
  for (const proj of config.projects) {
    if (p && norm(proj.name) === p) return ensureAo(`cfg:${proj.code}`, proj.code, proj.name, false);
  }
  for (const proj of config.projects) {
    if (proj.match.some(m => h.includes(m)) || h.includes(norm(proj.name))) return ensureAo(`cfg:${proj.code}`, proj.code, proj.name, false);
  }
  return ensureAo(`app:${p || 'claude-app'}`, p === 'desktop-chats' ? 'CHATS' : null, String(name || 'Claude app').slice(0, 40), true);
}
function ensureAo(key, code, name, dynamic) {
  if (!state.aos[key]) {
    let c = code || name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FIELD';
    const taken = new Set([...config.projects.map(p => p.code), ...Object.values(state.aos).map(a => a.code)]);
    let base = c, n = 2;
    while (taken.has(c)) c = base.slice(0, 5) + n++;
    state.aos[key] = { key, code: c, name, dynamic, flags: [], secured: false, securedAt: 0 };
  }
  const ao = state.aos[key];
  if (!dynamic) { const p = config.projects.find(p => `cfg:${p.code}` === key); if (p) { ao.code = p.code; ao.name = p.name; } }
  return ao;
}

// ---------- sessions (units) ----------
const live = s => s && s.state !== 'ended';
function callsignFor(ao) {
  const used = new Set(Object.values(state.sessions).filter(s => live(s) && s.ao === ao.key).map(s => s.n));
  let n = 1; while (used.has(n)) n++;
  return n;
}
function getSession(ev) {
  const id = ev.session_id;
  let s = state.sessions[id];
  if (!s || s.state === 'ended' && ev.hook_event_name === 'SessionStart') {
    const app = ev.source === 'app';
    const scratch = isScratch(ev.cwd);
    const ao = app ? aoForProject(ev.project, ev.hint) : scratch ? aoForProject('Desktop chats', ev.hint) : aoFor(ev.cwd || '');
    const n = callsignFor(ao);
    s = state.sessions[id] = {
      id, ao: ao.key, n, call: `${ao.code}-${n}`, cwd: app ? '' : (ev.cwd || ''), state: 'standby',
      source: app ? 'app' : 'cli', link: '',
      startedAt: now(), lastSignal: now(), orders: '', tool: '', inTool: false,
      ask: '', askAt: 0, lost: false, todos: [], transcript: ev.transcript_path || '',
    };
    rollDay();
    if (!state.stats.units.includes(id)) state.stats.units.push(id);
    log(`${s.call}: on station. ${app ? 'Claude app' : tildify(s.cwd)}`, 'f');
    record('start', s, { where: app ? 'Claude app' : tildify(s.cwd) });
  }
  if (typeof ev.link === 'string' && /^https:\/\/claude\.ai\//.test(ev.link)) s.link = ev.link.slice(0, 300);
  return s;
}
function tildify(p) { return p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : (p || ''); }
const HIDDEN = /<(system-reminder|user_memory_snapshot|task-notification|profile|preferences|memory_listing|user_memory|system)[^>]*>[\s\S]*?<\/\1>/gi;
function cleanText(t) { return String(t || '').replace(HIDDEN, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function trim(t, n = 160) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

function block(s, msg, options = [], kind = 'question') {
  msg = trim(msg, 400) || 'Needs your attention';
  s.options = (options || []).map(o => trim(o, 60)).filter(Boolean).slice(0, 5);
  s.askKind = kind;
  if (s.state === 'blocked' && s.ask === msg) return;
  const fresh = s.state !== 'blocked';
  s.state = 'blocked'; s.ask = msg;
  if (fresh) { s.askAt = now(); rollDay(); state.stats.calls++; record('support', s, { text: msg }); }
  log(`${s.call}: ${msg}`, 'a');
  alert(s, 'support');
}
function answer(s) {
  if (s.state === 'blocked') {
    rollDay(); state.stats.answered++; state.stats.respTotal += now() - (s.askAt || now());
    record('answered', s, { ms: now() - (s.askAt || now()) });
    log(`${s.call}: support received. Back on mission.`, 'f');
  }
  s.ask = ''; s.options = []; s.askKind = '';
}
// ---------- questions an agent leaves you at the end of a turn ----------
function lastAssistantText(file) {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 600000);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]; if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch (e) { continue; }
      const role = j.message?.role || j.type;
      const c = j.message?.content;
      if (role === 'user') {
        // A real prompt from you marks the start of this turn: look no further back.
        const isToolResult = Array.isArray(c) && c.every(x => x.type === 'tool_result');
        if (!isToolResult && !j.isMeta) return '';
        continue;
      }
      if (role !== 'assistant') continue;
      const text = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : (typeof c === 'string' ? c : '');
      if (text.trim()) return text;
    }
  } catch (e) {}
  return '';
}
const cap = t => { t = String(t).trim().replace(/^(to|the)\s+/i, m => m); return t.charAt(0).toUpperCase() + t.slice(1); };
function optionsFor(q, before) {
  // Numbered or lettered choices listed just before the question: one button each.
  const lines = before.split('\n').slice(-10);
  const listed = [];
  for (const l of lines) {
    const m = l.match(/^\s*(?:\d+[.)]|[A-Da-d][.)]|\*\*[A-D]\*\*[.):]?)\s+(.+)$/);
    if (m) { const o = m[1].replace(/\*\*/g, '').split(/\s[—–-]\s|:\s/)[0].trim(); if (o) listed.push(o.length > 60 ? o.slice(0, 57) + '…' : o); }
  }
  if (listed.length >= 2 && listed.length <= 5) return listed;
  const core = q.replace(/^.*?:\s*/, '').replace(/[“”"]/g, '').trim();
  // "Should I drop them or merge?" -> Drop them / Merge
  const choice = core.replace(/^(?:should|shall)\s+(?:i|we)\s+|^(?:do you want|would you like)(?:\s+me)?(?:\s+to)?\s+|^want me to\s+|^(?:which(?: one)?(?: do you want)?|pick one)[:,]?\s+/i, '');
  const orm = choice.match(/^([^,?]{2,50}?)\s*,?\s+or\s+([^,?]{2,50}?)\s*\?\s*$/i);
  if (orm && !/^(not|no)$/i.test(orm[2].trim())) return [cap(orm[1]), cap(orm[2])];
  if (/^(should|shall|do|does|can|could|would|will|is|are|want|ok|okay|ready)\b/i.test(core) || /\byes or no\b/i.test(q)) return ['Yes', 'No'];
  return [];
}
function findQuestion(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ').trim();
  if (!t) return null;
  const paras = t.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  for (let k = paras.length - 1; k >= Math.max(0, paras.length - 2); k--) {
    const qs = paras[k].replace(/\*\*/g, '').match(/[^.!?\n]*\?/g);
    if (!qs) continue;
    const question = qs[qs.length - 1].replace(/^[\s>#*_-]+/, '').trim();
    if (question.length < 6) continue;
    return { question, options: optionsFor(question, paras.slice(Math.max(0, k - 1), k + 1).join('\n')) };
  }
  return null;
}

function plantFlag(s, text) {
  const ao = state.aos[s.ao]; if (!ao) return;
  ao.flags.push({ id: `${s.id}:${ao.flags.length}:${now()}`, text: trim(text, 120), by: s.call, at: now() });
  if (ao.flags.length > 400) ao.flags.splice(0, ao.flags.length - 400);
  rollDay(); state.stats.done++;
  record('task_done', s, { text: trim(text, 200) });
  log(`${s.call}: task done. ${trim(text, 90)}. Flag planted.`, 'g');
}

function setTodos(s, todos) {
  if (!Array.isArray(todos)) return;
  const before = new Map(s.todos.map(t => [t.content, t.status]));
  const next = todos.map((t, i) => ({ id: String(t.id ?? i + 1), content: trim(t.content || t.subject || '', 140), status: t.status === 'done' ? 'completed' : (t.status || 'pending'), active: trim(t.activeForm || '', 140) }));
  for (const t of next) if (t.status === 'completed' && before.get(t.content) !== 'completed') plantFlag(s, t.content);
  s.todos = next;
}
function taskTool(s, ev) {
  const inp = ev.tool_input || {};
  if (ev.tool_name === 'TaskCreate') {
    const r = ev.tool_response; let id;
    try {
      id = r?.task?.id ?? r?.id ?? r?.taskId;
      if (id == null) { const m = JSON.stringify(r || '').match(/(?:task|#)\s*#?(\d+)/i); if (m) id = m[1]; }
    } catch (e) {}
    id = String(id ?? s.todos.length + 1);
    s.todos.push({ id, content: trim(inp.subject || inp.description || 'Task', 140), status: 'pending', active: trim(inp.activeForm || '', 140) });
  } else if (ev.tool_name === 'TaskUpdate') {
    const t = s.todos.find(t => t.id === String(inp.taskId));
    if (!t) return;
    if (inp.subject) t.content = trim(inp.subject, 140);
    if (inp.status === 'deleted') { s.todos = s.todos.filter(x => x !== t); return; }
    if (inp.status && inp.status !== t.status) { if (inp.status === 'completed') plantFlag(s, t.content); t.status = inp.status; }
  }
}
function toolSummary(ev) {
  const i = ev.tool_input || {};
  const d = i.description || i.file_path || i.path || i.pattern || i.url || i.query || i.command || '';
  return trim(`${ev.tool_name || 'a tool'}${d ? ': ' + String(d).split('\n')[0] : ''}`, 90);
}

function handle(ev) {
  if (!ev || !ev.session_id) return;
  const name = ev.hook_event_name;
  const s = getSession(ev);
  s.lastSignal = now();
  if (s.lost) { s.lost = false; log(`${s.call}: comms restored.`, 'f'); }
  if (ev.transcript_path) s.transcript = ev.transcript_path;
  if (Number(ev._pid) > 1) s.pid = Number(ev._pid);
  if (name !== 'CheckIn' && name !== 'Scan') s.hooked = true;
  const tool = ev.tool_name || '';

  switch (name) {
    case 'SessionStart':
      if (s.state === 'ended') s.state = 'standby';
      break;
    case 'UserPromptSubmit':
      answer(s); s.state = 'working'; s.orders = trim(cleanText(ev.prompt), 220) || s.orders; s.tool = ''; s.inTool = false;
      if (cleanText(ev.prompt)) { log(`TOC → ${s.call}: new orders. ${trim(cleanText(ev.prompt), 90)}`, 'f'); record('orders', s, { text: trim(cleanText(ev.prompt), 300) }); }
      break;
    case 'PreToolUse':
      if (tool === 'AskUserQuestion') {
        const q0 = ev.tool_input?.questions?.[0] || {};
        const q = q0.question || ev.tool_input?.question || 'Has a question for you';
        block(s, q, (q0.options || []).map(o => (typeof o === 'string' ? o : o.label)), 'dialog');
      } else {
        if (s.state === 'blocked') answer(s);
        s.state = 'working'; s.tool = toolSummary(ev); s.inTool = true;
      }
      if (tool === 'TodoWrite') setTodos(s, ev.tool_input?.todos);
      break;
    case 'PermissionRequest':
      block(s, `Permission needed: ${toolSummary(ev)}`, [], 'permission');
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      s.inTool = false;
      if (s.state === 'blocked') answer(s);
      if (s.state !== 'ended') s.state = 'working';
      if (name === 'PostToolUse') {
        if (tool === 'TodoWrite') setTodos(s, ev.tool_input?.todos);
        if (tool === 'TaskCreate' || tool === 'TaskUpdate') taskTool(s, ev);
      }
      break;
    case 'Notification': {
      const type = ev.notification_type || '';
      const msg = ev.message || '';
      if (type === 'auth_success') break;
      if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) { if (s.state !== 'blocked') s.state = 'standby'; break; }
      block(s, msg || 'Needs your attention', [], /permission/i.test(msg) ? 'permission' : 'notice');
      break;
    }
    case 'Stop': {
      if (s.state === 'blocked') answer(s);
      s.state = 'standby'; s.tool = ''; s.inTool = false;
      // Did the agent end its turn by asking you something? Then it raises its hand.
      const q = findQuestion(ev.last_assistant_message || lastAssistantText(s.transcript));
      if (q) block(s, q.question, q.options, 'question');
      else log(`${s.call}: turn complete. Ready for orders.`, 'o');
      break;
    }
    case 'CheckIn': {
      // Sent by Claude app sessions (see the command-post-checkin skill).
      if (ev.orders && cleanText(ev.orders) && trim(cleanText(ev.orders), 220) !== s.orders) { s.orders = trim(cleanText(ev.orders), 220); record('orders', s, { text: trim(cleanText(ev.orders), 300) }); }
      if (Array.isArray(ev.todos)) setTodos(s, ev.todos);
      const st = ev.status;
      if (st === 'blocked' || st === 'needs_you') block(s, ev.ask || 'Needs your input');
      else if (st === 'working') { if (s.state === 'blocked') answer(s); s.state = 'working'; s.tool = trim(ev.action || '', 140); s.inTool = false; }
      else if (st === 'standby' || st === 'done') { if (s.state === 'blocked') answer(s); s.state = 'standby'; s.tool = ''; if (st === 'done') { log(`${s.call}: mission complete. Ready for orders.`, 'o'); record('mission_complete', s); } }
      else if (st === 'ended') { s.ask = ''; s.state = 'ended'; s.endedAt = now(); log(`${s.call}: off station.`, 'f'); record('end', s); }
      if (ev.action && st !== 'working') s.tool = trim(ev.action, 140);
      break;
    }
    case 'PreCompact':
      log(`${s.call}: compacting memory.`, '');
      break;
    case 'SessionEnd':
      if (s.state === 'blocked') s.ask = '';
      s.state = 'ended'; s.endedAt = now();
      log(`${s.call}: off station.`, 'f');
      record('end', s);
      break;
    default:
      break;
  }
  recomputeSecured();
  scheduleSave();
  broadcast();
}

function recomputeSecured() {
  for (const ao of Object.values(state.aos)) {
    const units = Object.values(state.sessions).filter(s => live(s) && s.ao === ao.key);
    const done = units.length > 0 && units.every(s => s.todos.length > 0 && s.todos.every(t => t.status === 'completed') && s.state === 'standby');
    if (done && !ao.secured) {
      ao.secured = true; ao.securedAt = now();
      rollDay(); if (!state.stats.secured.includes(ao.key)) state.stats.secured.push(ao.key);
      log(`TOC: AO ${ao.code} (${ao.name}) SECURED. All tasks done.`, 'g');
      record('secured', null, { ao: ao.code, aoName: ao.name });
      notify(`AO ${ao.code} secured`, `${ao.name}: all tasks done.`, 'low');
    } else if (!done && ao.secured && units.some(s => s.todos.some(t => t.status !== 'completed'))) {
      ao.secured = false;
    }
  }
}

// ---------- alerts ----------
const lastAlert = new Map();
function alert(s, kind) {
  const key = s.id + kind;
  if (now() - (lastAlert.get(key) || 0) < 30000) return;
  lastAlert.set(key, now());
  const ao = state.aos[s.ao];
  if (kind === 'support') notify(`${s.call} needs support`, `${ao ? ao.name + ': ' : ''}${s.ask}`, 'high');
  else notify(`${s.call} lost comms`, `${ao ? ao.name + ': ' : ''}no signal for ${config.lostCommsMinutes}+ min`, 'default');
}
function notify(title, body, prio) {
  if (config.desktopNotifications) {
    execFile('notify-send', ['-a', 'Agent Command Post', '-u', prio === 'high' ? 'critical' : 'normal', title, body], () => {});
  }
  if (config.ntfyTopic) {
    try {
      const u = new URL(String(config.ntfyServer).replace(/\/$/, '') + '/' + encodeURIComponent(config.ntfyTopic));
      const text = config.ntfyIncludeDetails ? body : 'Open your command post for details.';
      const req = (u.protocol === 'http:' ? http : https).request(u, {
        method: 'POST', timeout: 5000,
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: prio === 'high' ? 'high' : prio === 'low' ? 'low' : 'default', Tags: prio === 'high' ? 'rotating_light' : 'radio' },
      }, r => r.resume());
      req.on('error', () => {}); req.on('timeout', () => req.destroy());
      req.end(text);
    } catch (e) {}
  }
}

// ---------- reading Claude Code's saved conversations ----------
// Hooks only report sessions started after the install. To catch every session on this
// computer (older ones too), also read the conversation files Claude Code keeps on disk.
function scanRoots() {
  const roots = new Set([path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects')]);
  for (const s of Object.values(state.sessions)) if (s.transcript) roots.add(path.dirname(path.dirname(s.transcript)));
  for (const r of config.transcriptDirs || []) roots.add(r);
  return [...roots];
}
function readTail(file, max = 400000) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, len = Math.min(size, max); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); return buf.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
function readHead(file, max = 60000) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.slice(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
const promptText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
function summarizeTranscript(file) {
  let cwd = '', lastKind = '', lastText = '', orders = '', first = '';
  for (const l of readHead(file).split('\n')) {
    let j; try { j = JSON.parse(l); } catch (e) { continue; }
    if (j.cwd && !cwd) cwd = j.cwd;
    if (!first && (j.message?.role || j.type) === 'user' && !j.isMeta) first = cleanText(promptText(j.message?.content));
    if (cwd && first) break;
  }
  const lines = readTail(file).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
    if (j.cwd && !cwd) cwd = j.cwd;
    if (j.isSidechain) continue;
    const role = j.message?.role || j.type, c = j.message?.content;
    if (role === 'user') {
      const isToolResult = Array.isArray(c) && c.length && c.every(x => x.type === 'tool_result');
      if (!lastKind) lastKind = isToolResult ? 'tool' : (j.isMeta ? '' : 'prompt');
      if (!isToolResult && !j.isMeta && cleanText(promptText(c))) { orders = cleanText(promptText(c)); if (lastKind) break; }
    } else if (role === 'assistant') {
      if (!lastKind) {
        const text = Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : (typeof c === 'string' ? c : '');
        const usesTool = Array.isArray(c) && c.some(x => x.type === 'tool_use');
        lastKind = usesTool ? 'tool' : text.trim() ? 'answer' : '';
        lastText = text;
      }
    }
  }
  return { cwd, lastKind, lastText, orders, first };
}
let scanning = false;
function scanTranscripts() {
  if (scanning) return; scanning = true;
  let changed = false;
  try {
    const cutoff = now() - config.staleHours * 3600000;
    for (const root of scanRoots()) {
      let dirs = []; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch (e) { continue; }
      for (const d of dirs) {
        let files = []; try { files = fs.readdirSync(path.join(root, d.name)).filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-')); } catch (e) { continue; }
        for (const f of files) {
          const file = path.join(root, d.name, f);
          let st; try { st = fs.statSync(file); } catch (e) { continue; }
          const mtime = st.mtimeMs;
          if (mtime < cutoff) continue;
          const id = f.slice(0, -6);
          let s = state.sessions[id];
          if (s && s.hooked && now() - s.lastSignal < 10 * 60000) continue; // its hooks are reporting it live
          if (s && s.scanMtime === mtime) continue;
          let t; try { t = summarizeTranscript(file); } catch (e) { continue; }
          if (!t.cwd) continue;
          if (!s || (s.state === 'ended' && mtime > (s.endedAt || 0) + 1000)) {
            if (s) delete state.sessions[id];
            s = getSession({ session_id: id, cwd: t.cwd, hook_event_name: 'Scan', transcript_path: file, hint: `${t.first} ${t.orders}`.slice(0, 1500) });
            s.lastSignal = mtime;
          }
          if (s.state === 'ended') continue;
          s.scanned = true; s.transcript = file; s.scanMtime = mtime; s.lastSignal = Math.max(s.lastSignal || 0, mtime);
          if (t.orders) s.orders = trim(t.orders, 220);
          if (t.lastKind === 'answer') {
            const q = findQuestion(t.lastText);
            if (q) block(s, q.question, q.options, 'question');
            else { if (s.state === 'blocked') answer(s); s.state = 'standby'; }
          } else if (t.lastKind === 'prompt' || t.lastKind === 'tool') {
            if (s.state === 'blocked') answer(s);
            s.state = now() - mtime < 5 * 60000 ? 'working' : 'standby';
          }
          changed = true;
        }
      }
    }
  } catch (e) { console.error('[acp] scan failed:', e.message); }
  scanning = false;
  if (changed) { recomputeSecured(); scheduleSave(); broadcast(); }
}
setInterval(scanTranscripts, 15000);
setTimeout(scanTranscripts, 1500);

// ---------- watchdog: lost comms + stale sessions ----------
setInterval(() => {
  let changed = false;
  for (const s of Object.values(state.sessions)) {
    if (!live(s)) {
      if (now() - (s.endedAt || 0) > 30 * 60000) { delete state.sessions[s.id]; changed = true; }
      continue;
    }
    const quiet = now() - s.lastSignal;
    if (s.state === 'working' && !s.lost) {
      const lim = (s.source === 'app' ? config.appLostCommsMinutes : s.inTool ? config.lostCommsInToolMinutes : config.lostCommsMinutes) * 60000;
      if (quiet > lim) { s.lost = true; s.lostAt = now(); record('lost', s); log(`${s.call}: no signal for ${Math.round(quiet / 60000)} min. Lost comms.`, 'h'); alert(s, 'lost'); changed = true; }
    }
    if (quiet > config.staleHours * 3600000) { s.state = 'ended'; s.endedAt = now(); log(`${s.call}: presumed off station (no signal for ${config.staleHours}h).`, 'f'); changed = true; }
  }
  for (const [k, ao] of Object.entries(state.aos)) {
    const recent = ao.flags.some(f => now() - f.at < 24 * 3600000);
    const hasUnits = Object.values(state.sessions).some(s => live(s) && s.ao === k);
    if (ao.dynamic && !recent && !hasUnits) { delete state.aos[k]; changed = true; }
  }
  if (state.stats.day !== dayKey()) { rollDay(); changed = true; }
  if (changed) { recomputeSecured(); scheduleSave(); broadcast(); }
}, 10000);

// ---------- finding Claude Code and continuing a session ----------
function findClaude(env) {
  if (config.claudeCommand) return config.claudeCommand;
  const found = which('claude', env);
  if (found) return found;
  const extra = [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), path.join(HOME, '.npm-global', 'bin', 'claude'), path.join(path.dirname(process.execPath), 'claude')];
  try { for (const v of fs.readdirSync(path.join(HOME, '.nvm', 'versions', 'node'))) extra.push(path.join(HOME, '.nvm', 'versions', 'node', v, 'bin', 'claude')); } catch (e) {}
  return extra.find(f => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch (e) { return false; } }) || null;
}
function resumeWith(s, text) {
  const env = { ...process.env };
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${path.join(HOME, '.local', 'bin')}${path.delimiter}${env.PATH || '/usr/bin:/bin'}`;
  const claude = findClaude(env);
  if (!claude) return { ok: false, error: 'Claude Code is not installed as a command on this computer.' };
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : HOME;
  try {
    fs.mkdirSync(path.join(DATA_DIR, 'runs'), { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'runs', `${s.call}.log`), 'a');
    const child = spawn(claude, ['--resume', s.id, '-p', text, '--permission-mode', 'acceptEdits'], { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.on('error', () => {});
    child.unref();
    log(`TOC: ${s.call} picked up your answer and is back to work.`, 'f');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- opening a session in Claude Code ----------
function isAlive(pid) { return !!pid && fs.existsSync(`/proc/${pid}`); }
let desktopEnv = null;
function guiEnv() {
  // A background service may not have the desktop's display variables; borrow them from systemd.
  if (!desktopEnv) {
    desktopEnv = {};
    try {
      for (const line of execFileSync('systemctl', ['--user', 'show-environment'], { timeout: 3000 }).toString().split('\n')) {
        const m = line.match(/^(DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XAUTHORITY)=(.*)$/);
        if (m) desktopEnv[m[1]] = m[2];
      }
    } catch (e) {}
  }
  return { ...desktopEnv, ...process.env };
}
function which(cmd, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (e) {}
  }
  return null;
}
function openInClaude(s) {
  const env = guiEnv();
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${path.join(HOME, '.local', 'bin')}${path.delimiter}${env.PATH || '/usr/bin:/bin'}`;
  const claude = config.claudeCommand || which('claude', env) || 'claude';
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : HOME;
  const q = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const shell = `cd ${q(cwd)} && ${q(claude)} --resume ${q(s.id)}; echo; echo "Session closed. You can close this window."; exec bash`;
  const terms = config.terminal ? [config.terminal] : ['gnome-terminal', 'x-terminal-emulator', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm'];
  for (const t of terms) {
    const bin = which(t, env);
    if (!bin) continue;
    const args = t === 'gnome-terminal' ? ['--working-directory', cwd, '--title', s.call, '--', 'bash', '-lc', shell]
      : t === 'konsole' ? ['--workdir', cwd, '-e', 'bash', '-lc', shell]
      : t === 'kitty' || t === 'alacritty' ? ['-e', 'bash', '-lc', shell]
      : ['-e', `bash -lc ${q(shell)}`];
    try {
      const child = spawn(bin, args, { cwd, env, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { ok: true, terminal: t };
    } catch (e) {}
  }
  return { ok: false, error: 'No terminal app found to open Claude Code in.', command: `cd ${q(cwd)} && claude --resume ${s.id}` };
}

// ---------- snapshot ----------
function snapshot() {
  const t = now();
  const flagWin = config.flagsHours * 3600000;
  if (config.showIdleProjects) for (const p of config.projects) ensureAo(`cfg:${p.code}`, p.code, p.name, false);
  const cfgOrder = config.projects.map(p => `cfg:${p.code}`);
  const aos = Object.values(state.aos)
    .filter(a => !(a.key.startsWith('cfg:') && !cfgOrder.includes(a.key)))
    .sort((a, b) => {
      const ia = cfgOrder.indexOf(a.key), ib = cfgOrder.indexOf(b.key);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      return a.name.localeCompare(b.name);
    })
    .map(a => ({ key: a.key, code: a.code, name: a.name, secured: a.secured, securedAt: a.securedAt,
      flags: a.flags.filter(f => t - f.at < flagWin).slice(-60) }));
  const units = Object.values(state.sessions)
    .filter(s => live(s) || t - (s.endedAt || 0) < 90000)
    .map(s => ({
      id: s.id, call: s.call, ao: s.ao, state: s.lost && s.state === 'working' ? 'nocomms' : s.state,
      source: s.source || 'cli', link: s.link || '',
      cwd: tildify(s.cwd), cwdRaw: s.cwd, orders: s.orders, tool: s.tool, ask: s.ask, askAt: s.askAt,
      lastSignal: s.lastSignal, startedAt: s.startedAt, todos: s.todos,
      radio: !!s.radio && t - (s.lastPoll || 0) < 180000, open: isAlive(s.pid), pending: (s.inbox || []).map(m => m.text), options: s.options || [], askKind: s.askKind || '',
      reply: s.source === 'app' ? 'app' : (s.radio && t - (s.lastPoll || 0) < 180000) ? 'relay' : isAlive(s.pid) ? 'needs-relay' : 'resume',
    }));
  const st = state.stats;
  return {
    now: t,
    settings: { lostCommsMinutes: config.lostCommsMinutes, ntfy: !!config.ntfyTopic, desktop: !!config.desktopNotifications },
    aos, units, log: state.log.slice(-80),
    stats: { done: st.done, calls: st.calls, answered: st.answered, avgResponseMs: st.answered ? st.respTotal / st.answered : 0, secured: st.secured.length, units: st.units.length },
  };
}

// ---------- http ----------
const clients = new Set();
let bTimer = null;
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) { try { res.write(data); } catch (e) {} }
  }, 200);
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 20000);

const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
function authorized(req) {
  if (isLoopback(req.socket.remoteAddress)) return true;
  if (!config.lanAccess || !config.accessKey) return false;
  const u = new URL(req.url, 'http://x');
  const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('acp_key='));
  return u.searchParams.get('key') === config.accessKey || (cookie && decodeURIComponent(cookie.slice(8)) === config.accessKey);
}
// Blocks other websites open in your browser from driving the board.
// Host check: stops DNS rebinding (a site whose domain is pointed at 127.0.0.1). Domain names
// must be loopback names, this computer's name, or ones you list in config.allowedHosts;
// bare IP addresses are always fine, since rebinding needs a domain name.
// Origin check: browsers label cross-site requests, so a page on another site cannot send
// orders, dismiss agents or open terminals. Hooks and the relay send no Origin and still work.
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function hostName(h) { return String(h || '').toLowerCase().replace(/:\d+$/, ''); }
function allowedHost(req) {
  const h = hostName(req.headers.host);
  if (!h) return true; // HTTP/1.0 tools without a Host header
  if (LOOPBACK_NAMES.has(h) || h.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[')) return true;
  const me = os.hostname().toLowerCase();
  if (h === me || h === `${me}.local`) return true;
  return (config.allowedHosts || []).map(x => String(x).toLowerCase()).includes(h);
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const o = req.headers.origin;
  if (!o) return true;
  if (o === 'null') return false;
  try { return new URL(o).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch (e) { return false; }
}
function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function readBody(req, cb) {
  let d = '', size = 0;
  req.on('data', c => { size += c.length; if (size > 2e6) { req.destroy(); return; } d += c; });
  req.on('end', () => cb(d));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!allowedHost(req)) return send(res, 403, 'Unknown host name. Open the board at http://localhost:' + config.port + ' or add this name to allowedHosts in config.json.', 'text/plain');
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, '{"error":"Requests from other websites are not allowed."}');
  if (!authorized(req)) return send(res, 401, 'Unauthorized. Add ?key=YOUR_ACCESS_KEY to the URL.', 'text/plain');
  const extra = {};
  if (u.searchParams.get('key') && config.accessKey) extra['set-cookie'] = `acp_key=${encodeURIComponent(config.accessKey)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;

  if (req.method === 'POST' && u.pathname === '/hook') {
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, '{}');
    return readBody(req, d => { try { handle(JSON.parse(d)); } catch (e) {} send(res, 204, ''); });
  }
  if (req.method === 'GET' && u.pathname === '/api/history') {
    return fs.readFile(HISTORY_PATH, 'utf8', (err, txt) => {
      const days = Math.min(3650, Math.max(1, Number(u.searchParams.get('days')) || 30));
      const since = now() - days * 86400000;
      const rows = [];
      for (const line of (err ? '' : txt).split('\n')) { if (!line) continue; try { const r = JSON.parse(line); if (r.t >= since) rows.push(r); } catch (e) {} }
      const byDay = {}, byAo = {};
      for (const r of rows) {
        const d = byDay[dayKey(r.t)] ||= { day: dayKey(r.t), t: r.t, done: 0, calls: 0, answered: 0, respTotal: 0, secured: 0, units: new Set() };
        if (r.sid) d.units.add(r.sid);
        if (r.type === 'task_done') d.done++;
        if (r.type === 'support') d.calls++;
        if (r.type === 'answered') { d.answered++; d.respTotal += r.ms || 0; }
        if (r.type === 'secured') d.secured++;
        if (r.ao) { const a = byAo[r.ao] ||= { code: r.ao, name: r.aoName, done: 0, calls: 0, last: 0 }; if (r.type === 'task_done') a.done++; if (r.type === 'support') a.calls++; a.last = Math.max(a.last, r.t); }
      }
      const out = {
        days: Object.values(byDay).sort((a, b) => b.t - a.t).map(d => ({ day: d.day, t: d.t, done: d.done, calls: d.calls, answered: d.answered, avgResponseMs: d.answered ? d.respTotal / d.answered : 0, secured: d.secured, units: d.units.size })),
        projects: Object.values(byAo).sort((a, b) => b.done - a.done),
        recent: rows.filter(r => r.type === 'task_done' || r.type === 'secured' || r.type === 'mission_complete').slice(-60).reverse(),
        total: rows.length,
      };
      send(res, 200, JSON.stringify(out), 'application/json', extra);
    });
  }
  if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, JSON.stringify(snapshot()), 'application/json', extra);
  if (req.method === 'GET' && u.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...extra });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/scan') {
    const out = { roots: scanRoots(), files: [] };
    for (const root of out.roots) {
      let dirs = []; try { dirs = fs.readdirSync(root); } catch (e) { out.files.push({ root, error: e.code }); continue; }
      for (const d of dirs) { let fl = []; try { fl = fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.jsonl')); } catch (e) { continue; }
        for (const f of fl) { try { const st = fs.statSync(path.join(root, d, f)); if (now() - st.mtimeMs < 24 * 3600000) out.files.push({ dir: d, id: f.slice(0, -6), minutesAgo: Math.round((now() - st.mtimeMs) / 60000), onBoard: !!state.sessions[f.slice(0, -6)] }); } catch (e) {} } }
    }
    out.files.sort((a, b) => (a.minutesAgo ?? 0) - (b.minutesAgo ?? 0));
    return send(res, 200, JSON.stringify(out));
  }
  if (req.method === 'GET' && u.pathname === '/api/ping') return send(res, 200, '{"ok":true,"app":"agent-command-post"}');
  // Orders and answers typed on the board, waiting for the agent's relay to pick them up.
  const om = u.pathname.match(/^\/api\/order\/(.+)$/);
  if (req.method === 'POST' && om) {
    return readBody(req, d => {
      let text = '';
      try { text = String(JSON.parse(d).text || '').trim().slice(0, 4000); } catch (e) {}
      const s = state.sessions[decodeURIComponent(om[1])];
      if (!s || !live(s)) return send(res, 404, '{"error":"That agent is no longer on the board."}');
      if (!text) return send(res, 400, '{"error":"Type a message first."}');
      const wasWaiting = s.state === 'blocked';
      record('order_sent', s, { text: trim(text, 300), wasWaiting });
      log(`TOC → ${s.call}: ${trim(text, 120)}`, 'f');
      // Window closed: continue the session right here with your answer.
      if (s.source !== 'app' && !isAlive(s.pid) && !(s.radio && now() - (s.lastPoll || 0) < 180000)) {
        const r = resumeWith(s, text);
        if (r.ok) { answer(s); s.state = 'working'; s.orders = trim(text, 220); s.tool = 'Picking up your answer'; s.lastSignal = now(); scheduleSave(); broadcast(); return send(res, 200, '{"ok":true,"via":"resume"}'); }
      }
      (s.inbox ||= []).push({ text, at: now() });
      scheduleSave(); broadcast();
      const waiting = !(s.radio && now() - (s.lastPoll || 0) < 180000);
      send(res, 200, JSON.stringify({ ok: true, via: 'relay', waiting }));
    });
  }
  const opm = u.pathname.match(/^\/api\/open\/(.+)$/);
  if (req.method === 'POST' && opm) {
    const s = state.sessions[decodeURIComponent(opm[1])];
    if (!s) return send(res, 404, '{"error":"That agent is no longer on the board."}');
    if (s.source === 'app') return send(res, 409, JSON.stringify({ error: 'This agent runs in the Claude app. Open it there.', link: s.link || '' }));
    if (isAlive(s.pid)) return send(res, 409, JSON.stringify({ error: `${s.call} is already open in a window on this computer. Switch to that window, or answer it here.` }));
    const r = openInClaude(s);
    if (r.ok) log(`TOC: opened ${s.call} in Claude Code.`, 'f');
    return send(res, r.ok ? 200 : 500, JSON.stringify(r));
  }
  const im = u.pathname.match(/^\/api\/inbox\/(.+)\/take$/);
  if (req.method === 'POST' && im) {
    if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, '{}');
    const s = state.sessions[decodeURIComponent(im[1])];
    if (!s) return send(res, 200, '{"messages":[]}');
    const first = !s.radio || now() - (s.lastPoll || 0) > 180000;
    s.radio = true; s.lastPoll = now();
    const messages = (s.inbox || []).map(m => m.text);
    s.inbox = [];
    if (messages.length) { log(`${s.call}: orders received.`, 'o'); scheduleSave(); }
    if (messages.length || first) broadcast();
    return send(res, 200, JSON.stringify({ messages }));
  }
  const m = u.pathname.match(/^\/api\/(dismiss|remove)\/(.+)$/);
  if (req.method === 'POST' && m) {
    const s = state.sessions[decodeURIComponent(m[2])];
    if (!s) return send(res, 404, '{}');
    if (m[1] === 'dismiss') {
      if (s.state === 'blocked') { answer(s); s.state = 'standby'; }
      if (s.lost) { s.lost = false; s.lastSignal = now(); log(`TOC: ${s.call} lost-comms alert cleared.`, 'f'); }
    } else {
      s.state = 'ended'; s.endedAt = now(); log(`TOC: ${s.call} removed from the board.`, 'f');
      if (s.id.startsWith('demo-')) purgeSample(s.id);
    }
    recomputeSecured(); scheduleSave(); broadcast();
    return send(res, 200, '{}');
  }
  if (req.method === 'POST' && u.pathname === '/api/test-alert') {
    notify('Radio check', 'Agent Command Post alerts are working.', 'high');
    return send(res, 200, '{}');
  }
  if (req.method === 'GET') {
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const f = path.normalize(path.join(PUBLIC_DIR, p));
    if (!f.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found', 'text/plain');
    return fs.readFile(f, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(f)] || 'application/octet-stream', extra));
  }
  send(res, 405, '{}');
});

const host = config.lanAccess ? '0.0.0.0' : '127.0.0.1';
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`[acp] Port ${config.port} is busy. Is the command post already running? Change "port" in ${CONFIG_PATH}.`);
  else console.error('[acp]', e.message);
  process.exit(1);
});
server.listen(config.port, host, () => {
  console.log(`[acp] Agent Command Post on http://localhost:${config.port}${config.lanAccess ? ' (LAN access on, key required)' : ''}`);
  console.log(`[acp] data: ${DATA_DIR}`);
});
function shutdown() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state)); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
// Self-update: when the installed server file changes, save and exit so the service restarts on the new code.
fs.watchFile(__filename, { interval: 3000 }, () => { console.log('[acp] server updated, restarting'); try { fs.writeFileSync(STATE_PATH, JSON.stringify(state)); } catch (e) {} process.exit(75); });
