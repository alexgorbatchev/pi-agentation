# Agentation Pi Plugin

`packages/pi-agentation/agentation.ts`

A Pi extension that continuously runs an Agentation fix loop by repeatedly sending:

- `/skill:agentation-fix-loop <project-id>`

It starts automatically when the session starts, resolves the project ID for the current repository, and keeps re-queuing the same project-scoped prompt after each agent run until Pi exits (or you stop it).

## Behavior

- The launcher (`bin/agentation-pi`) injects an embedded local skill via `--skill`
- Extension checks that `/skill:agentation-fix-loop` is available before running
- On session start/switch/fork, the extension:
  - runs `agentation projects --json`
  - runs `rg` to discover literal `projectId="..."` values in the repo
  - intersects both lists
  - auto-starts if exactly one project matches, otherwise prompts you to choose in the TUI
- The resolved project ID is stored in the current Pi session so reloads/resume do not re-prompt that same session
- On `agent_end`: sends the next project-scoped loop prompt
- On `session_shutdown`: stops loop automatically
- If the skill is missing, no repo project IDs are found, or no discovered repo IDs are known to Agentation yet: plugin requests shutdown and exits with code `1`

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
