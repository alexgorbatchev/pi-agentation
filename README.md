# Agentation Pi Plugin

`packages/pi-agentation/agentation.ts`

A Pi extension that continuously runs an Agentation fix loop by repeatedly sending:

- `/skill:agentation-fix-loop`

It starts automatically when the session starts and keeps re-queuing the same prompt after each agent run, until Pi exits (or you stop it).

## Behavior

- Checks that `/skill:agentation-fix-loop` is available before running
- On `session_start`: starts loop and sends first prompt
- On `agent_end`: sends the next loop prompt
- On `session_shutdown`: stops loop automatically
- If the skill is missing: plugin requests shutdown and exits with code `1`

## Commands

- `/agentation-loop-start` — resume/start looping
- `/agentation-loop-stop` — pause looping

## Use it

From this monorepo:

```bash
pi -e ./packages/pi-agentation/agentation.ts
```

From this workspace package (after `pnpm install`):

```bash
pnpm --filter agentation-pi exec agentation-pi
```

Pass normal Pi flags/args through it:

```bash
pnpm --filter agentation-pi exec agentation-pi -- --list-models
```

Or copy/symlink it into your Pi extensions directory for auto-discovery:

- `~/.pi/agent/extensions/`

## Notes

- This loop is intentionally persistent and can consume tokens quickly.
- Use `/agentation-loop-stop` if you want to pause it without exiting Pi.
