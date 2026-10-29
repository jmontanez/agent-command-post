# Agent Command Post

A military command-post style live board for Claude Code agents. It shows which agents are working, which are waiting on the user, and which went silent, on one map. Users answer agents and give new orders by clicking them on the board. It's meant for public release on GitHub (MIT).

## Layout

This folder is the source repo. `install.js` (via `install.sh`) copies the app into `~/.agent-command-post/app`, adds the Claude Code hooks, sets up a systemd user service and installs the relay. **Always edit here, never in `~/.agent-command-post/app`**, because the next install overwrites that copy.

- `server.js`: the single Node server (no dependencies, Node 18+). Serves the board, takes hook events, holds state, sends orders.
- `hook.js`: Claude Code pipes every hook event here; it forwards the event to `POST /hook` and exits silently. It must never print, block, or slow Claude down.
- `public/`: the board (`index.html` is the main view, `classic.html` the tactical map).
- `demo.js`: sample agents for trying the board.
- `relay/command-post-relay/`: a Claude Code plugin that polls `/api/inbox/<sid>/take` and submits board orders into a live session.

Runtime data lives in `~/.agent-command-post/` (or `$ACP_DATA`): `config.json`, `state.json`, `history.jsonl`, `runs/`.

## Rules

- **Never lose the record of completed work.** Don't rewrite or truncate `history.jsonl` or `state.json` except through the server's own code paths.
- **Never commit runtime data.** `config.json` holds the access key; the rest holds the user's private session history.
- **The installed `server.js` restarts itself when its file changes** (it exits with code 75 and the service brings it back). Run `node --check server.js` after every edit.
- **Security model:** anything from loopback is trusted. That only stays safe because of `allowedHost()` (blocks DNS rebinding) and `sameOrigin()` (blocks other websites from POSTing). Keep both checks in front of every route. `/hook` and `/api/inbox/*/take` stay loopback-only.
- Orders can resume a closed session with `--permission-mode acceptEdits`. Treat any change to `/api/order` or `resumeWith()` as security-sensitive.
- Keep it dependency-free plain Node.
- The user-facing language stays in the command-post theme (on station, lost comms, orders, flags, secured, TOC).

## Working on it with Claude Code

Run `node devtools/setup.js` once to copy the safety hooks and `/release-check` into `.claude/`.
