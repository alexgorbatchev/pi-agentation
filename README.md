# Agentation Pi Plugin

`agentation.ts`

A pi extension that continuously runs an Agentation fix loop by repeatedly sending:

- `/skill:agentation-fix-loop <project-id>`

It starts automatically when the session starts, resolves the project ID for the current repository (searching for `<Agentation projectId=... />`), and keeps re-queuing the same project-scoped prompt after each agent run until pi exits (or you stop it).

## Behavior

- The launcher (`pi-agentation`) injects the vendored local skill via `--skill`
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

Required executables on `PATH`:

- `pi`
- `agentation`
- `rg`

The `agentation` CLI is distributed separately from these npm packages and must be downloaded and placed on your `PATH`.

## Usage

Run the launcher from your project:

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
