# Impa — Obsidian Writing Companion Plugin

Named after Zelda's guardian, Impa watches over your writing.

## Features

- **Version Increment** — Duplicate the active note with the next decimal version (e.g. `Novel 1.0.md` → `Novel 1.1.md`).
- **Export to DOCX** — Export the active note via Pandoc using one of your four predefined Word templates (Novel, Short, Pitch, Comic).

## Installation (Manual)

1. Copy the three required files into your vault's plugin folder:
   ```
   YOUR_VAULT/.obsidian/plugins/impa/main.js
   YOUR_VAULT/.obsidian/plugins/impa/manifest.json
   YOUR_VAULT/.obsidian/plugins/impa/styles.css
   ```
2. Restart Obsidian (or run "Reload app without saving" from the command palette).
3. Go to **Settings → Community Plugins**, find **Impa**, and enable it.

## Configuration (Settings → Impa)

| Setting | Description |
|---|---|
| **Pandoc path** | Path to your pandoc binary. `pandoc` works if it's on PATH (it is on CachyOS with a standard install). |
| **Default export directory** | Absolute path to your output folder. Leave blank to save next to the source note. |
| **Overwrite existing files** | Toggle on to overwrite; off to auto-suffix (e.g. `Novel (2).docx`). |
| **Novel / Short / Pitch / Comic template** | Absolute path to each `.docx` reference template file. |

## Commands & Hotkeys

Both commands appear in the **Command Palette** as:
- `Impa: Increment note version`
- `Impa: Export to DOCX via Pandoc`

Assign hotkeys via **Settings → Hotkeys**, search "Impa".

## Template format

Templates must be `.docx` files formatted as Pandoc reference documents.  
See: https://pandoc.org/MANUAL.html#option--reference-doc

## Version Numbering Logic

| Current filename | New filename |
|---|---|
| `Novel 1.0.md` | `Novel 1.1.md` |
| `Novel 1.9.md` | `Novel 1.10.md` |
| `Story.md` (no version) | `Story 1.0.md` |

>PLEASE NOTE THAT THIS WAS VIBECODED BY CLAUDE. I'M NOT ANY KIND OF CODE AND HAVE NO IDEA IF IT'S DOING WEIRD THINGS. I JUST WANTED SOMETHING FOR MYSELF AND THOUGHT I MIGHT AS WELL PUT IT SOMEWHERE IN CASE SOMEONE ELSE WANTED THIS HIGHLY SPECIFIC FEATURESET, BUT SINCE PRO'LLY NOBODY DOES I'M NOT SUPER WORRIED
