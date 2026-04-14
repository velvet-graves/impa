import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocxTemplate {
	id: string;
	label: string;
	templatePath: string; // Absolute path to the .docx reference template
}

interface ImpaSettings {
	templates: DocxTemplate[];
	exportDirectory: string;    // Default export output folder (absolute path)
	overwriteExisting: boolean; // true = overwrite, false = auto-rename
	pandocPath: string;         // Path to pandoc binary (default: "pandoc")
}

const DEFAULT_TEMPLATES: DocxTemplate[] = [
	{ id: "novel",  label: "Novel",  templatePath: "" },
	{ id: "short",  label: "Short",  templatePath: "" },
	{ id: "pitch",  label: "Pitch",  templatePath: "" },
	{ id: "comic",  label: "Comic",  templatePath: "" },
];

const DEFAULT_SETTINGS: ImpaSettings = {
	templates: DEFAULT_TEMPLATES,
	exportDirectory: "",
	overwriteExisting: false,
	pandocPath: "pandoc",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Given a filename like "Novel 1.0.md" or "Novel 1.9.md",
 * returns the next decimal-incremented version: "Novel 1.1.md" / "Novel 2.0.md".
 *
 * Increments the decimal part by 0.1 with one decimal place precision.
 * If no decimal version pattern is found, appends " 1.0" before the extension.
 */
function incrementVersion(filename: string): string {
	// Match: anything, then a space, then digits.digits, then .ext
	const versionPattern = /^(.*?)(\d+)\.(\d+)(\.[^.]+)$/;
	const match = filename.match(versionPattern);

	if (!match) {
		// No version found — append 1.0 before extension
		const dotIdx = filename.lastIndexOf(".");
		if (dotIdx === -1) return filename + " 1.0";
		return filename.slice(0, dotIdx) + " 1.0" + filename.slice(dotIdx);
	}

	const prefix   = match[1]; // e.g. "Novel "
	const major    = parseInt(match[2], 10);
	const minor    = parseInt(match[3], 10);
	const ext      = match[4]; // e.g. ".md"

	const newMinor = minor + 1;
	// If minor rolls over 9 to 10, keep going — e.g. 1.9 → 1.10
	return `${prefix}${major}.${newMinor}${ext}`;
}

/**
 * Given a desired output path, return a path that doesn't collide with
 * existing files by appending (2), (3), etc. if needed.
 */
function resolveOutputPath(desiredPath: string): string {
	if (!fs.existsSync(desiredPath)) return desiredPath;

	const ext      = path.extname(desiredPath);
	const base     = desiredPath.slice(0, desiredPath.length - ext.length);
	let counter    = 2;

	while (fs.existsSync(`${base} (${counter})${ext}`)) {
		counter++;
	}
	return `${base} (${counter})${ext}`;
}

// ─── Template Picker Modal ────────────────────────────────────────────────────

class TemplatePicker extends Modal {
	private templates: DocxTemplate[];
	private onChoose: (template: DocxTemplate) => void;

	constructor(app: App, templates: DocxTemplate[], onChoose: (t: DocxTemplate) => void) {
		super(app);
		this.templates = templates;
		this.onChoose  = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Impa — Choose Export Template" });
		contentEl.createEl("p", {
			text: "Select a Word template to use for this export.",
			cls: "impa-subtitle",
		});

		const validTemplates = this.templates.filter(t => t.templatePath.trim() !== "");
		const allTemplates   = this.templates;

		if (allTemplates.length === 0) {
			contentEl.createEl("p", { text: "No templates configured. Add them in Impa settings." });
			return;
		}

		const grid = contentEl.createDiv({ cls: "impa-template-grid" });

		for (const template of allTemplates) {
			const hasPath = template.templatePath.trim() !== "";

			const btn = grid.createEl("button", {
				text: template.label,
				cls: "impa-template-btn" + (hasPath ? "" : " impa-template-btn--disabled"),
			});

			if (!hasPath) {
				btn.setAttribute("title", "No template path configured in settings");
				btn.setAttribute("disabled", "true");
			} else {
				btn.addEventListener("click", () => {
					this.close();
					this.onChoose(template);
				});
			}
		}

		// Cancel button
		const cancelRow = contentEl.createDiv({ cls: "impa-cancel-row" });
		cancelRow.createEl("button", { text: "Cancel", cls: "impa-cancel-btn" })
			.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class ImpaSettingTab extends PluginSettingTab {
	plugin: ImpaPlugin;

	constructor(app: App, plugin: ImpaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Impa Settings" });

		// ── Pandoc path ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Pandoc path")
			.setDesc('Full path to your pandoc binary, or just "pandoc" if it is on your PATH.')
			.addText(text => text
				.setPlaceholder("pandoc")
				.setValue(this.plugin.settings.pandocPath)
				.onChange(async (value) => {
					this.plugin.settings.pandocPath = value.trim() || "pandoc";
					await this.plugin.saveSettings();
				}));

		// ── Export directory ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Default export directory")
			.setDesc("Absolute path to the folder where exported .docx files are saved. Leave blank to save next to the source note.")
			.addText(text => text
				.setPlaceholder("/home/you/Documents/Exports")
				.setValue(this.plugin.settings.exportDirectory)
				.onChange(async (value) => {
					this.plugin.settings.exportDirectory = value.trim();
					await this.plugin.saveSettings();
				}));

		// ── Overwrite toggle ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Overwrite existing files")
			.setDesc("If a file with the same name already exists in the export directory, overwrite it. When disabled, a unique suffix is added instead.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.overwriteExisting)
				.onChange(async (value) => {
					this.plugin.settings.overwriteExisting = value;
					await this.plugin.saveSettings();
				}));

		// ── Templates ────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Export Templates" });
		containerEl.createEl("p", {
			text: "Set the absolute path to each .docx reference template file. Pandoc uses these for formatting.",
			cls: "setting-item-description",
		});

		for (let i = 0; i < this.plugin.settings.templates.length; i++) {
			const tmpl = this.plugin.settings.templates[i];

			new Setting(containerEl)
				.setName(`${tmpl.label} template`)
				.setDesc(`Absolute path to the ${tmpl.label} .docx reference template`)
				.addText(text => text
					.setPlaceholder("/home/you/Templates/novel-template.docx")
					.setValue(tmpl.templatePath)
					.onChange(async (value) => {
						this.plugin.settings.templates[i].templatePath = value.trim();
						await this.plugin.saveSettings();
					}));
		}
	}
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class ImpaPlugin extends Plugin {
	settings: ImpaSettings;

	async onload() {
		await this.loadSettings();

		// ── Command: Increment Version ──────────────────────────────────────
		this.addCommand({
			id: "impa-increment-version",
			name: "Increment note version",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.incrementNoteVersion(file);
			},
		});

		// ── Command: Export to DOCX ─────────────────────────────────────────
		this.addCommand({
			id: "impa-export-docx",
			name: "Export to DOCX via Pandoc",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.promptExportDocx(file);
			},
		});

		this.addSettingTab(new ImpaSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		const saved = await this.loadData();
		// Deep-merge so new default templates aren't wiped by old saved data
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// Make sure we always have all four default template slots
		if (!this.settings.templates || this.settings.templates.length === 0) {
			this.settings.templates = DEFAULT_TEMPLATES.map(t => ({ ...t }));
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Version increment ────────────────────────────────────────────────────

	async incrementNoteVersion(file: TFile) {
		const folder      = file.parent?.path ?? "";
		const newName     = incrementVersion(file.name);
		const newPath     = folder ? `${folder}/${newName}` : newName;

		// Check if destination already exists
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`⚠️  Impa: "${newName}" already exists in this folder.`);
			return;
		}

		try {
			const content = await this.app.vault.read(file);
			await this.app.vault.create(newPath, content);
			// Open the new file
			const newFile = this.app.vault.getAbstractFileByPath(newPath);
			if (newFile instanceof TFile) {
				await this.app.workspace.getLeaf(false).openFile(newFile);
			}
			new Notice(`✅  Impa: Created "${newName}"`);
		} catch (err) {
			console.error("Impa version increment error:", err);
			new Notice(`❌  Impa: Failed to create "${newName}". See console for details.`);
		}
	}

	// ── Pandoc export ────────────────────────────────────────────────────────

	promptExportDocx(file: TFile) {
		const configured = this.settings.templates.filter(t => t.templatePath.trim() !== "");
		if (configured.length === 0) {
			new Notice("⚠️  Impa: No templates configured. Add template paths in Impa settings.");
			return;
		}

		new TemplatePicker(this.app, this.settings.templates, (template) => {
			this.runPandocExport(file, template);
		}).open();
	}

	async runPandocExport(file: TFile, template: DocxTemplate) {
		// Resolve vault-absolute path to the source .md file
		const vaultRoot  = (this.app.vault.adapter as any).basePath as string;
		const sourcePath = path.join(vaultRoot, file.path);

		// Determine output path
		const baseName     = file.basename + ".docx";
		let exportDir      = this.settings.exportDirectory.trim();

		if (!exportDir) {
			// Default: same folder as the source note
			exportDir = path.dirname(sourcePath);
		}

		// Ensure export directory exists
		if (!fs.existsSync(exportDir)) {
			try {
				fs.mkdirSync(exportDir, { recursive: true });
			} catch (err) {
				new Notice(`❌  Impa: Could not create export directory: ${exportDir}`);
				return;
			}
		}

		let outputPath = path.join(exportDir, baseName);

		if (!this.settings.overwriteExisting) {
			outputPath = resolveOutputPath(outputPath);
		}

		// Build pandoc command
		const pandoc       = this.settings.pandocPath || "pandoc";
		const templateArg  = `--reference-doc="${template.templatePath}"`;
		const command      = `"${pandoc}" "${sourcePath}" -o "${outputPath}" ${templateArg}`;

		new Notice(`⏳  Impa: Exporting "${file.name}" as ${template.label}…`);

		exec(command, { cwd: path.dirname(sourcePath) }, (error, stdout, stderr) => {
			if (error) {
				console.error("Impa pandoc error:", error);
				console.error("stderr:", stderr);
				new Notice(`❌  Impa: Export failed.\n${stderr || error.message}`);
				return;
			}
			const outFile = path.basename(outputPath);
			new Notice(`✅  Impa: Exported "${outFile}" using ${template.label} template.`);
		});
	}
}
