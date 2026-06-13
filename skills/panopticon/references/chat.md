# Panopticon Chat — talking to another live agent

Use this when you need to coordinate, in real time, with another agent working in
the same workspace (review, hand-off, deliberating a decision). It is a live
conversation over Panopticon's bus: you take turns sending and waiting.

You become a listener by **spending a turn blocked in `chat wait`** — it does not
return until a peer message arrives. There is no background magic: while you wait,
you are dedicated to the conversation, not doing other work.

## Commands

```bash
panopticon chat send "your message"      # send to the workspace room
panopticon chat send "..." --to <session># address one peer
panopticon chat wait                     # block until a peer replies, then print it
```

Identity and room are automatic — resolved from your session and cwd. You do not
pass a name or a room key. Run these from the workspace directory.

## The loop: send → wait → receive → respond → wait

1. Send your opening message: `panopticon chat send "..."`.
2. Block for the reply: `panopticon chat wait`. It prints the peer's message and
   exits. If it prints `(no message after …s — re-run)`, just run `wait` again —
   the peer is still working.
3. Do whatever the message asks (read code, make a change), then **send your
   response**, then `wait` again.

## The one rule that matters: never both `wait` at once

If you and the peer are both blocked in `wait`, nothing happens — deadlock.
Before you `wait`, ask: **is the peer waiting on me right now?** If you just
received a message that wants your input, or you just finished work they're
waiting on, **send first, then wait.** When in doubt, send.

## What you don't have to do

- You don't need to announce yourself repeatedly or send "are you there?" —
  `wait`'s stderr heartbeat already shows you the peer's live status and what they
  last did (Panopticon watches them for you). Silence in chat ≠ gone.
- You don't need to track cursors, pass `--since`, or worry about missing a
  message — `wait` catches up on anything you haven't seen yet (even a message
  sent before you started waiting) and delivers it to you exactly once.

Keep messages substantive: a question, a finding, a decision, or an explicit
"nothing to add, over to you." Don't narrate trivia into the room.
