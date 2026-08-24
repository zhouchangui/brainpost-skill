# AGENTS.md

## Project overview

This public repository contains the installable `brainpost` Agent Skill. It submits URLs, plain text, complete Markdown, and supported local documents to the BrainPost API. The installable package is `brainpost/`; repository-only tests and documentation stay at the root.

## Boundaries

- Keep the Skill self-contained and dependency-free; use Node.js standard library APIs.
- Do not add a standalone package, global executable, or CLI distribution.
- All BrainPost channels share one existing Identity Token in the MVP. Do not add token issuance, rotation, revocation, or secondary-token flows.
- Plaintext Token handoff from the user to the agent is allowed for this MVP. Never commit it, echo it, include it in JSON output, or read it back from the config for display.
- Store local configuration only at `~/.config/brainpost/config.json` with mode `0600`.
- Preserve Markdown exactly and enforce the BrainPost API limit of 262,144 UTF-8 bytes.

## Development

- Run tests: `node --test test/brainpost.test.mjs`
- Validate the Skill: `python3 /Users/zcg/.codex/skills/.system/skill-creator/scripts/quick_validate.py brainpost`
- Install locally for a smoke test: `npx skills add .`

Edit files with the smallest working change. Keep tests at the repository root so `npx skills` installs only the `brainpost/` directory.

## Release

Before pushing, run the test and validation commands above. Installation from GitHub must remain:

```bash
npx skills add zhouchangui/brainpost-skill
```
