# pi plugin for Agentation Fork

A pi extension that continuously runs an Agentation fix loop by repeatedly sending:

- `/skill:agentation-fix-loop <project-id>`

It starts automatically when the session starts, resolves the project ID for the current repository (searching for `<Agentation projectId=... />`), and keeps re-queuing the same project-scoped prompt after each agent run until pi exits (or you stop it).

See:

- [Agentation Fork](https://github.com/alexgorbatchev/agentation)
- [CLI](https://github.com/alexgorbatchev/agentation-cli)
- [Agentation Skills](https://github.com/alexgorbatchev/agentation-skills)

> [!IMPORTANT]
> This loops AI until manually stopped and so it can consume tokens while idling. Don't forget to stop it when you no longer using it.

## Behavior

- The launcher (`pi-agentation`) injects the local packaged fix-loop skill via `--skill`
- Extension checks that `/skill:agentation-fix-loop` is available before running
- On session start/switch/fork, the extension:
  - runs `agentation projects --json`
  - runs `rg` to discover literal `projectId="..."` or `projectId='...'` values in the repo
  - intersects both lists
  - auto-starts if exactly one project matches, otherwise prompts you to choose in the TUI
- The resolved project ID is stored in the current Pi session so reloads/resume do not re-prompt that same session
- On `agent_end`: sends the next project-scoped loop prompt
- On `session_shutdown`: stops loop automatically
- If the skill is missing, no repo project IDs are found, or no discovered repo IDs are known to Agentation yet: plugin requests shutdown and exits with code `1`

## Commands

- `/agentation-loop-start` — resume/start looping
- `/agentation-loop-stop` — pause looping

## Installation

Install both project packages:

```bash
npm install -D @alexgorbatchev/agentation @alexgorbatchev/pi-agentation
```

`@alexgorbatchev/pi-agentation` ships its own packaged copy of the fix-loop skill. That file is synced from [`@alexgorbatchev/agentation-skills`](https://github.com/alexgorbatchev/agentation-skills) during packaging, so you do not need to install the skill package separately.

Required executables on `PATH`:

- `pi`
- `agentation`
- `rg`

The `agentation` [CLI](https://github.com/alexgorbatchev/agentation-cli) is distributed separately from these npm packages and must be downloaded and placed on your `PATH`.

## Usage

Before running the pi, you need to start the [CLI](https://github.com/alexgorbatchev/agentation-cli) and connect from the front end which has `<Agentation projectId="..." />` at least once in the last 24h. Then run the launcher from your project:

```bash
npx pi-agentation
```

If your shell already exposes local package binaries on `PATH`, you can run:

```bash
pi-agentation
```

## Notes

- This loop is intentionally persistent and can consume tokens quickly.
- Use `/agentation-loop-stop` if you want to pause it without exiting Pi.
