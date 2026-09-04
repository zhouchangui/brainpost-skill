# BrainPost Skill

One Agent Skill for sending URLs, text, Markdown, and local documents to BrainPost for delivery into the Owner's Obsidian Vault.

## Install

```bash
npx skills add zhouchangui/brainpost-skill
```

Then ask your agent to save something with `$brainpost`. There is no standalone or global CLI; the installed Skill runs its bundled script.

On first use, BrainPost opens the account page and asks for the existing shared Identity Token. The agent stores it locally in `~/.config/brainpost/config.json`. If no Vault is connected yet, submissions safely wait until the first Vault is activated. Complete Markdown is supported up to 256 KiB; available points can privately upload supported Word, PDF, presentation, spreadsheet, OpenDocument, RTF, EPUB and CSV files within the current Platform limit.

The bundled script can report the current points balance, reserved points, task costs and purchase options without embedding the tier matrix:

```bash
node brainpost/scripts/brainpost.mjs capabilities
node brainpost/scripts/brainpost.mjs status --intake <UUID>
node brainpost/scripts/brainpost.mjs status --capture <UUID>
```

## Verify

```bash
node --test test/brainpost.test.mjs
```
