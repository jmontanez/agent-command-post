#!/usr/bin/env node
// Copies the command post's own Claude Code setup (safety hooks and /release-check) into
// .claude/ at the repo root. Only needed if you work on Agent Command Post itself.
//   node devtools/setup.js
// Existing files in .claude/ are backed up as <name>.bak before being replaced.
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, 'claude');
const DEST = path.join(__dirname, '..', '.claude');
function copy(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copy(s, d); continue; }
    if (fs.existsSync(d) && fs.readFileSync(d, 'utf8') !== fs.readFileSync(s, 'utf8')) fs.copyFileSync(d, `${d}.bak`);
    fs.copyFileSync(s, d);
    console.log(`  ${path.relative(path.join(DEST, '..'), d)}`);
  }
}
fs.mkdirSync(DEST, { recursive: true });
console.log('Installed:');
copy(SRC, DEST);
console.log('Done. Start Claude Code from this folder to use the hooks and /release-check.');
