# Agentation Pi Plugin

`packages/pi-agentation/agentation.ts`

A Pi extension that continuously runs an Agentation fix loop by repeatedly sending:

- `/skill:agentation-fix-loop`

It starts automatically when the session starts and keeps re-queuing the same prompt after each agent run, until Pi exits (or you stop it).

## Behavior

- The launcher (`bin/agentation-pi`) injects an embedded local skill via `--skill`
- Extension checks that `/skill:agentation-fix-loop` is available before running
- On `session_start`: starts loop and sends first prompt
- On `agent_end`: sends the next loop prompt
- On `session_shutdown`: stops loop automatically
- If the skill is missing: plugin requests shutdown and exits with code `1`

## Commands

- `/agentation-loop-start` — resume/start looping
- `/agentation-loop-stop` — pause looping

## Use it

From this workspace package (after `pnpm install`) — recommended (includes embedded skill automatically):

```bash
pnpm --filter agentation-pi exec ./bin/agentation-pi
```

From this monorepo, directly via `pi` (must pass the bundled skill path):

```bash
pi \
  -e ./packages/pi-agentation/agentation.ts \
  --skill ./packages/pi-agentation/skills/agentation-fix-loop/SKILL.md
```

Pass normal Pi flags/args through it:

```bash
pnpm --filter agentation-pi exec ./bin/agentation-pi -- --list-models
```

To auto-discover both the extension and embedded skill, install this package as a Pi package (so `pi.skills` and `pi.extensions` are both loaded), instead of copying only `agentation.ts` into an extensions folder.

## Notes

- This loop is intentionally persistent and can consume tokens quickly.
- Use `/agentation-loop-stop` if you want to pause it without exiting Pi.
