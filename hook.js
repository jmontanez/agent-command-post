#!/usr/bin/env node
// Agent Command Post hook. Claude Code pipes each hook event to this script on stdin.
// It forwards the event to the local TOC server and exits. It never prints anything and
// never blocks or changes what Claude does: if the server is down, it exits quietly.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let port = Number(process.env.ACP_PORT) || 7600;
try {
  const dir = process.env.ACP_DATA || path.join(os.homedir(), '.agent-command-post');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  if (cfg.port) port = Number(cfg.port);
} catch (e) {}

const done = () => process.exit(0);
setTimeout(done, 1500).unref();

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { body += c; });
// The Claude Code process that ran this hook, so the board can tell whether the session is
// still open. Walks up from this process: node hook.js <- shell <- claude.
function claudePid() {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 5 && pid > 1; i++) {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (/claude/i.test(cmd) && !/hook\.js/.test(cmd)) return pid;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    }
  } catch (e) {}
  return 0;
}

process.stdin.on('end', () => {
  if (!body) return done();
  try { const ev = JSON.parse(body); ev._pid = claudePid(); body = JSON.stringify(ev); } catch (e) {}
  try {
    const req = http.request({
      host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 800,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', done); });
    req.on('error', done);
    req.on('timeout', () => { req.destroy(); done(); });
    req.end(body);
  } catch (e) { done(); }
});
process.stdin.on('error', done);
