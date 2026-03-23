---
name: agentation
description: >-
  Process exactly one Agentation Fork batch that was already fetched by the
  pi-agentation extension. Acknowledge each annotation, make the requested code
  change, then resolve, reply, or dismiss it. Use when the extension dispatches
  `/skill:agentation <project-id>` for a ready batch, or when the user
  explicitly wants to continue the current batch.
targets:
  - '*'
---

# Agentation Fork Batch Processor

Process exactly one Agentation Fork annotation batch for the supplied `<project-id>`.

If this skill is invoked as `/skill:agentation <project-id>`, treat the user-supplied argument as the authoritative project ID for this run.

## Extension contract

The `pi-agentation` extension owns polling and batching.

That means:

- The extension already ran `agentation pending` or `agentation watch`
- The extension injected the current batch as an extension context message
- You must process **only that provided batch**
- You must **not** start or manage your own polling loop

## Do not do these commands here

Do **not** run any of the following from this skill:

- `agentation start`
- `agentation status`
- `agentation projects`
- `agentation pending`
- `agentation watch`

Those belong to the extension, not to this skill.

## Allowed Agentation Fork CLI commands

Use only the annotation lifecycle commands needed to process the provided batch:

- `agentation ack <annotation-id>`
- `agentation resolve <annotation-id> --summary "..."`
- `agentation reply <annotation-id> --message "..."`
- `agentation dismiss <annotation-id> --reason "..."`

## Required workflow

For each annotation in the provided batch, in order:

1. **Acknowledge it first**

   ```bash
   agentation ack <annotation-id>
   ```

2. **Understand the request**
   - Read the annotation fields from the extension-provided batch context
   - Inspect the relevant files
   - Infer the smallest correct change

3. **Implement the fix**
   - Keep changes minimal
   - Follow repo conventions
   - Do not broaden scope without evidence

4. **Finish the annotation with exactly one terminal action**

   Resolve when fixed:

   ```bash
   agentation resolve <annotation-id> --summary "<short file + change summary>"
   ```

   Reply when clarification is required:

   ```bash
   agentation reply <annotation-id> --message "I need clarification on ..."
   ```

   Dismiss when not actionable:

   ```bash
   agentation dismiss <annotation-id> --reason "Not actionable because ..."
   ```

## Important execution rules

- Process annotations in the order they appear in the provided batch
- Do not invent or fetch another batch
- Do not leave the skill running after the provided batch is handled
- Run each `agentation ack|resolve|reply|dismiss` as a **separate bash command** so the extension can track completion reliably
- Keep resolve summaries concise and concrete
- Only resolve once the requested change is actually implemented

## If no batch context is present

If the extension context says there is no active batch:

- report that clearly
- do not try to poll Agentation Fork yourself
- tell the user to resume the extension loop with `/agentation-loop-start`

## Completion condition

Stop after the current provided batch has been fully processed.

This is a **one-shot batch processor**, not a watcher.
