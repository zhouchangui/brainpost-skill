# BrainPost Skill

One Agent Skill for sending URLs, text, and complete Markdown files to a BrainPost Vault.

## Install

```bash
npx skills add zhouchangui/brainpost-skill
```

Then ask your agent to save something with `$brainpost`. There is no standalone or global CLI; the installed Skill runs its bundled script.

On first use, BrainPost opens the account page and asks for the existing shared Identity Token. The agent stores it locally in `~/.config/brainpost/config.json`. Complete Markdown uploads are supported up to 256 KiB.

## Verify

```bash
node --test test/brainpost.test.mjs
```
