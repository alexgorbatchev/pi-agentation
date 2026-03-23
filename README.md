# pi-agentation

A pi extension launcher for Agentation Fork.

It resolves the repository's Agentation Fork `projectId`, starts an
extension-managed watch loop, and dispatches a **one-shot** Agentation Fork
batch-processing skill when real annotations arrive.

See:

- [agentation-fork.vercel.app](https://agentation-fork.vercel.app)
- [Agentation Fork](https://github.com/alexgorbatchev/agentation)
- [Agentation Fork CLI](https://github.com/alexgorbatchev/agentation-cli)
- [Agentation Skills](https://github.com/alexgorbatchev/agentation-skills)

> [!IMPORTANT]
> When idle, this keeps an Agentation Fork watch loop running but does not
> spend model tokens. Tokens are only used when a real annotation batch is
> dispatched for autonomous code-fix work.

## Architecture

`pi-agentation` now splits responsibilities cleanly:

- **Extension**
  - resolves the project for the current repo
  - runs `agentation pending` once on startup
  - then keeps a live `agentation watch <project-id> --timeout 300 --batch-window 10 --json` loop running
  - dispatches exactly one skill run per fetched batch
  - pauses queue polling while the current batch is still in progress

- **Skill**
  - processes exactly one already-fetched batch
  - acknowledges each annotation
  - edits code
  - resolves, replies, or dismisses annotations
  - exits when that batch is done

This avoids the old brittle design where the extension kept re-queuing the same
skill prompt after every agent turn.

## Behavior

- The launcher (`pi-agentation`) injects the bundled `agentation` skill via `--skill`
- The extension checks that `/skill:agentation` is available before starting
- On session start/switch/fork, the extension:
  - runs `agentation projects --json`
  - runs `rg` to discover literal `projectId="..."` or `projectId='...'` values in the repo
  - intersects both lists
  - auto-starts if exactly one project matches, otherwise prompts you to choose in the TUI
- The resolved project ID is stored in the current Pi session so reloads/resume do not re-prompt that same session
- The extension manages the polling loop itself; it does one startup `agentation pending` check and then relies on a live `agentation watch` loop as the primary mechanism
- When a batch arrives, the extension injects batch context and dispatches `/skill:agentation <project-id>`
- The UI widget is intentionally conservative: after startup it reports live-watch status, not an authoritative queue-empty claim
- If a batch is left incomplete, restart `pi-agentation` to retry from a clean watch loop
- On `session_shutdown`, the extension stops its internal watch loop automatically
- If the skill is missing, no repo project IDs are found, or no discovered repo IDs are known to Agentation Fork yet: the plugin requests shutdown and exits with code `1`

## Installation

Install both project packages:

```bash
npm install -D @alexgorbatchev/agentation @alexgorbatchev/pi-agentation
```

`@alexgorbatchev/pi-agentation` ships a bundled `agentation` skill, so you do not need to install a separate skill package for local use.

Executable resolution order:

- `pi-agentation` resolves `pi` from the nearest `node_modules/.bin/pi` first, then falls back to `PATH`
- the extension resolves `agentation` from the nearest `node_modules/.bin/agentation` first, then falls back to `PATH`
- `rg` is still expected on `PATH`

This makes the package work cleanly when `pi-agentation`, `pi`, and the Agentation Fork CLI are installed into the same Node project, while still supporting global installations.

## Usage

Before running pi, start the [Agentation Fork CLI](https://github.com/alexgorbatchev/agentation-cli) and connect from the front end which uses `<Agentation projectId="..." />` at least once in the last 24h. Then run the launcher from your project:

```bash
npx pi-agentation
```

If your shell already exposes local package binaries on `PATH`, you can run:

```bash
pi-agentation
```

## Notes

- The extension now owns polling; the skill is intentionally one-shot.
- If you leave a batch partially handled, restart `pi-agentation` to retry from a clean watch loop.
