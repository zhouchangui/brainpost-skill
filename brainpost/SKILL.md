---
name: brainpost
description: Save URLs, plain text, or complete Markdown files to a BrainPost Vault. Use when the user asks to submit, post, capture, collect, archive, or save content through BrainPost.
---

# BrainPost

Use the bundled Node.js script directly. Do not install or invoke a global CLI.

Set `<skill-dir>` to the directory containing this `SKILL.md`, then choose exactly one input:

```text
node <skill-dir>/scripts/brainpost.mjs capture --url <URL>
node <skill-dir>/scripts/brainpost.mjs capture --file <absolute-markdown-path>
node <skill-dir>/scripts/brainpost.mjs capture --stdin
```

Pass `--stdin` content through process stdin. All submissions use the Owner's current default Obsidian Vault.

## First use

If the script returns `configuration_required`, it opens the BrainPost account page. Show `error.details.prompt` to the user without changing it.

When the user supplies their existing Identity Token, pass the token plus a newline to process stdin:

```text
node <skill-dir>/scripts/brainpost.mjs configure
```

The MVP intentionally shares this one Token with every BrainPost channel. Never issue, rotate, revoke, transform, or commit it. The script stores it at `~/.config/brainpost/config.json` with mode `0600`.

If configuration returns `default_vault_required`, show the setup URL and ask the user to open and authenticate an Obsidian Vault before retrying.

## Submission rules

- Upload a Markdown file with `--file`; preserve its complete contents as the Intake source. The API accepts valid UTF-8 files up to 262,144 bytes.
- Use `--stdin` for plain text and `--url` for HTTP(S) links.
- Report the returned Intake ID, status and status URL.
- On a retryable failure, reuse `error.details.idempotencyKey` with `--idempotency-key <UUID>`.
- Never print the config file or Token.
