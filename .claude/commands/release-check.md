---
description: Check Agent Command Post is safe and ready to push to public GitHub
---

Run a pre-release check of this repo and report a short pass/fail list. Do not change any files unless I say so.

1. **Private data stays out.** Run `git status --ignored` and `git ls-files`. FAIL if `config.json`, `state.json`, `history.jsonl`, anything in `runs/`, `*.bak` or `*.acp-backup` is tracked or staged. Also search tracked files for my access key value from `config.json`, my home path, and personal project names, and list any hits.
2. **Installer is present and works.** `install.js` and `install.sh` exist and `package.json` scripts point at them. Dry-run `node install.js --no-service` with `CLAUDE_CONFIG_DIR` and `ACP_DATA` set to temp folders, then `--uninstall`, and confirm the temp `settings.json` ends up clean.
3. **Code is valid.** `node --check` passes on `server.js`, `hook.js`, `demo.js` and `install.js`.
4. **Security checks are still in place.** `allowedHost()` and `sameOrigin()` both run before `authorized()` in the request handler. `/hook` and `/api/inbox/*/take` are still loopback-only.
5. **Board runs.** Start the server with `ACP_DATA` pointed at a temp folder on a spare port. Confirm `/api/ping` answers, then confirm a POST with `Origin: https://evil.example` gets a 403. Stop it.
6. **Release basics.** README, LICENSE, `config.example.json` and the version in `package.json` all exist and agree with each other.

End with READY or NOT READY and the list of fixes needed.
