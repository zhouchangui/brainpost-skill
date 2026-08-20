---
name: brainpost
description: Save URLs, plain text, Markdown, or local documents to a BrainPost Vault. Use when the user asks to submit, post, capture, collect, archive, convert, or save content through BrainPost.
---

# BrainPost

Use the bundled Node.js script directly. Do not install or invoke a global CLI.

Set `<skill-dir>` to the directory containing this `SKILL.md`, then choose exactly one input:

```text
node <skill-dir>/scripts/brainpost.mjs capture --url <URL>
node <skill-dir>/scripts/brainpost.mjs capture --file <absolute-file-path>
node <skill-dir>/scripts/brainpost.mjs capture --stdin
node <skill-dir>/scripts/brainpost.mjs capabilities
node <skill-dir>/scripts/brainpost.mjs status --intake <UUID>
```

Pass `--stdin` content through process stdin. All submissions use the Owner's current default Obsidian Vault.

## First use

If the script returns `configuration_required`, it opens the BrainPost account page. Show `error.details.prompt` to the user without changing it.

When the user supplies their existing Identity Token, pass the token plus a newline to process stdin:

```text
node <skill-dir>/scripts/brainpost.mjs configure
```

The MVP intentionally shares this one Token with every BrainPost channel. Never issue, rotate, revoke, transform, or commit it. The script stores it at `~/.config/brainpost/config.json` with mode `0600`.

If no Vault is connected yet, configuration succeeds with `pendingDelivery: true`; submitted content waits in the Pending Delivery Project and is delivered after the first Vault activation.

## Submission rules

- Use `--file` with an absolute path. Markdown (`.md`, `.markdown`) is preserved as Intake text up to 262,144 UTF-8 bytes.
- Word, PDF, PowerPoint, Excel, OpenDocument, RTF, EPUB and CSV files use private File Intake when `membership.fileIntakeEnabled` is true and must stay within the returned `membership.maxFileBytes`. Query `capabilities` when the user asks about membership or remaining allowance. The receipt reports only Capture ID, filename and status; it never prints file bytes, Token, object keys or temporary URLs.
- Use `--stdin` for plain text and `--url` for HTTP(S) links.
- Report the returned Intake ID/status/status URL for text and links, or Capture ID/filename/status for documents.
- Use `status --intake <UUID>` when the user asks for the asynchronous result; report the returned stable failure reason without exposing source data.
- On a retryable failure, reuse `error.details.idempotencyKey` with `--idempotency-key <UUID>`.
- Preserve stable error codes and safe reset details when explaining a rejection; do not infer tier rules or task limits locally.
- Never print the config file or Token.
