Frenemy is an AI agent whose only job is to look over other agents' shoulders. While your coding agent works, Frenemy reads the diff of each change as it lands and challenges the ones that look wrong — the deleted test that should've been fixed, the shortcut that'll bite later, the misread requirement. It doesn't wait for a pull request; it objects in the moment, in the working agent's context, while the change is still cheap to undo.

**Concretely:** your agent decides to delete a failing test so CI goes green. Before it takes its next step, Frenemy's note is already in its context — "that test guards the retry path; the failure is real, fix the cause." The agent reconsiders and patches the actual bug instead. The review happened while the work was being written, not days later after the context is gone.

**Demo:** run a coding agent on a small change and watch Frenemy catch — and correct — a bad move in real time.

Frenemy is one of several roles an agent can play in what we built: a workspace where AI coding agents are aware of each other and can work together.

Until now, running several agents in one project meant running them in isolation. Each one sees only its own task. They overwrite each other's files, repeat work that's already done, and have no way to ask "what is everyone else doing right now?" We made the workspace shared. Every agent in it can see the others, follow what they're changing, and message them directly — the note arriving in the recipient's working context before its next action — automatically, with no channels to join or names to register.

It's built on Panopticon, a tool that already watches every AI coding agent in a workspace, recording who each one is, what files it's touching, and whether it's still running. That existing observability is what makes the collaboration real rather than a dumb message pipe: an agent acts on what the others are actually doing, not on whatever they decide to announce.

Underneath is an agent communication bus, running on that same capture — which gives it properties a chat app doesn't have. Every agent has a stable identity resolved from its session — there's no handle to register. Every message is attributable to who sent it, and can point at the exact change that prompted it. A message can be addressed to one agent or to the whole workspace, it's delivered once, and it arrives in the recipient's working context before its next action rather than as an out-of-band note it might miss. Because the bus sits on the observability layer, an agent waiting on a reply can also tell a peer that's still working from one that's crashed — something a plain chat channel can't. That delivery model is exactly why Frenemy works: its objection references the specific diff and lands in the same context as the action that triggered it, while the change is still cheap to undo.

Frenemy is the first role we built on top of it. Others follow the same shape:

- **Sidequest** — several agents take one large job, split it into pieces that don't overlap, and each land their own PR.
- **Direct conversation** — two agents talk through a decision in real time instead of guessing each other's intent.

The roles are open-ended. The workspace gives agents awareness of and a voice to each other; what they do with it is up to whoever defines the next role.

It's for developers already running more than one coding agent at a time — and for anyone who's watched a single agent confidently do the wrong thing. The bet underneath all of it: the fix isn't one smarter agent, it's agents that watch, question, and divide work among themselves.
