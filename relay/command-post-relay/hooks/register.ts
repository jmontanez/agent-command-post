import type { Register } from 'claude-code'

// Agent Command Post relay: lets the command post at http://localhost:7600 send answers and
// new orders into a Claude Code session running on the same computer.
//
// The command post's hooks already report what each session is doing. This relay adds the
// return channel: every 15 seconds while the session waits on you (45 while it works) it
// asks the command post for messages typed on the board, and submits them into the session
// as if you had typed them. Sessions that cannot reach localhost:7600 (a cloud session,
// or the command post is not running) are left alone: the relay does nothing there.

const ORIGIN = 'http://localhost:7600'

let sid = ''
let ready = false
let working = false
let busy = false
let lastPoll = 0
let pausedUntil = 0
let timer: { cancel: () => void } | undefined

async function reachable($: any): Promise<boolean> {
  try {
    const r: any = await Promise.race([$.http.fetch(`${ORIGIN}/api/ping`), $.clock.sleep(3000).then(() => null)])
    return !!r && r.ok && String(r.text).includes('agent-command-post')
  } catch { return false }
}

async function poll($: any) {
  if (busy || !sid || Date.now() < pausedUntil) return
  busy = true
  lastPoll = Date.now()
  try {
    const r: any = await Promise.race([
      $.http.fetch(`${ORIGIN}/api/inbox/${encodeURIComponent(sid)}/take`, { method: 'POST' }),
      $.clock.sleep(5000).then(() => null),
    ])
    if (!r || !r.ok) throw new Error('no answer')
    const messages: string[] = JSON.parse(r.text).messages ?? []
    if (messages.length) {
      $.ui.toast('Orders from your command post')
      void $.prompt.submit({ text: messages.join('\n\n') })
    }
  } catch {
    pausedUntil = Date.now() + 60_000 // command post restarting or stopped: try again in a minute
  } finally {
    busy = false
  }
}

async function start($: any) {
  if (ready) return
  ready = true
  if (!(await reachable($))) return // not on the command post's computer: stay silent
  try { sid = await $.session.id() } catch { return }
  timer = $.clock.every(15_000, () => {
    const gap = working ? 45_000 : 15_000
    if (Date.now() - lastPoll >= gap - 1000) void poll($)
  })
  void poll($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    void start($)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    working = true
    void start($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if ((e as any).agentId === undefined) { working = false; void poll($) }
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))
}
