
## Worker contract (tickets from the manager)

When a prompt says you are the WORKER, you are building a ticket the manager (Grok Bot) wrote. Follow these steps in order.

1. **Read the ticket.** Do only what it asks. Files outside "In scope" are read-only. If the fix is impossible without touching one, stop and report BLOCKED.
2. **Reproduce first.** Write or run a test that fails because of the bug, or that proves the feature is missing. Keep that test.
3. **Smallest change that passes.** No refactors, no renames, no formatting sweeps, no "while I'm here" fixes.
4. **Run every check below.** All must pass before you commit.
5. **Commit on the current branch** with the message `TASK-<n>: <what changed>`. Never push, merge, or switch branches; the script does that.
6. **Log it.** Add one line under "Recent changes" in CURRENT_STATE.md: date, ticket id, one-line result. Commit that too.
7. **Write the proof** to the file path the prompt gives you, in the PR proof format below.

### Checks

- Tests: `node --test test/unit.test.js` (the API tests start local servers, so they run outside the sandbox)

### Hard stops

Write `BLOCKED: <reason>` as the first line of the proof file and stop, without committing, if the ticket needs any of these:

- a secret, API key, or environment variable change
- a database migration or a change to production data
- a new package or a package upgrade
- changes to billing, auth, or payment code that the ticket does not name
- more than about 300 changed lines
- a guess, because the acceptance criteria are unclear

### PR proof format

```
## TASK-<n>: <title>

**Result:** <one sentence a non-coder can check>
**Cause:** <one sentence>
**Change:**
- `<file>`: <what changed, one line>

**Proof**
- Test that failed before and passes now: `<test name>`
- `<test command>`: <N passed, 0 failed>
- Lint: passed · Build: passed

**Acceptance criteria**
- [x] <criterion copied from the ticket>

**How to check it yourself:** <one step on the preview deployment>
**Risk:** <low / medium>, because <one line>
**Not done:** <anything left, or "nothing">
```
