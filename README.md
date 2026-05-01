# Impa — Obsidian Writing Companion Plugin

Named after Zelda's guardian, Impa watches over your writing.

## Features

- **Quick Version Increment** — Quickly duplicate the active note with the next decimal version (e.g. `Novel 1.0.md` → `Novel 1.1.md`).
- **Export to DOCX** — Export the active note via Pandoc using predefined Word templates. Supports multiple templates, which can be selected from a list at the time of export.
- **Sync to Alphasmart** — Uses neotools for two seperate commands: to send files to Alphasmart, and to bring them back. 

## Installation (Manual)

1. Copy the three required files into your vault's plugin folder:
   ```
   YOUR_VAULT/.obsidian/plugins/impa/main.js
   YOUR_VAULT/.obsidian/plugins/impa/manifest.json
   YOUR_VAULT/.obsidian/plugins/impa/styles.css
   ```
2. Restart Obsidian (or run "Reload app without saving" from the command palette).
3. Go to **Settings → Community Plugins**, find **Impa**, and enable it.

## Dependancies

- [pandoc](https://pandoc.org/) for export functions.
- [neotools](https://github.com/lykahb/neotools) for sync to and from Alphasmart.

## Configuration (Settings → Impa)

| Setting | Description |
|---|---|
| **Pandoc path** | Path to your pandoc binary. `pandoc` works if it's on PATH. |
| **Default export directory** | Absolute path to your output folder. Leave blank to save next to the source note. |
| **Overwrite existing files** | Toggle on to overwrite; off to auto-suffix (e.g. `Novel (2).docx`). |
| **Select templates** | Select and name `.docx` reference template files. |
| **Neotools path** | Verify neotools PATH|
| **File Slot Assignments** | Select up to 8 files to assign to the 8 slots on the Alphasmart|

## Commands & Hotkeys

Commands appear in the **Command Palette** as:
- `Impa: Increment note version`
- `Impa: Export to DOCX via Pandoc`
- `Impa: Send to Alphasmart`
- `Impa: Sync from Alphasmart`

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

## Alphasmart

Uses `.neotools-export` as a staging folder during conversion from `.md` to `.txt`, which is required for Alphasmart. During conversion back to Obsidian vault, also restores the original file name, since the Alphasmart automatically renames the file to `File 1.txt` etc during initial export from device. 

>PLEASE NOTE THIS WAS VIBECODED BY CLAUDE. I'M NOT ANY KIND OF CODER AND HAVE NO IDEA IF IT'S DOING WEIRD THINGS. I JUST WANTED SOMETHING FOR MYSELF AND THOUGHT I MIGHT AS WELL PUT IT SOMEWHERE IN CASE SOMEONE ELSE WANTED THIS HIGHLY SPECIFIC FEATURE SET. BUT SINCE PRO'LLY NOBODY DOES, I'M NOT SUPER WORRIED
