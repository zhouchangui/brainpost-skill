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

Pass `--stdin` content through process stdin. Add `--cloud` only when the user explicitly requests Cloud Enhancement.

## First use

If the script returns `configuration_required`, it opens the BrainPost account page. Show `error.details.prompt` to the user without changing it.

When the user supplies their existing Identity Token, pass the token plus a newline to process stdin:

```text
node <skill-dir>/scripts/brainpost.mjs configure
```

The MVP intentionally shares this one Token with every BrainPost channel. Never issue, rotate, revoke, transform, or commit it. The script stores it at `~/.config/brainpost/config.json` with mode `0600`.

If configuration returns `project_required`, show the safe project list, ask which Vault to use, then rerun with `--project <UUID>`. After configuration succeeds, retry the original capture.

## Submission rules

- Upload a Markdown file with `--file`; preserve its complete contents. The API accepts valid UTF-8 files up to 262,144 bytes.
- Use `--stdin` for plain text and `--url` for HTTP(S) links.
- Use an explicit `--project <UUID>` only when the user requests a non-default Vault.
- Report the returned capture ID and status.
- On a retryable failure, reuse `error.details.idempotencyKey` with `--idempotency-key <UUID>`.
- Never print the config file or Token.
