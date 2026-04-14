import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	AbstractInputSuggest,
} from "obsidian";
import { exec } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocxTemplate {
	id: string;
	label: string;
	templatePath: string; // Vault-relative path to the .docx reference template
}

interface ImpaSettings {
	templates: DocxTemplate[];
	exportDirectory: string;
	overwriteExisting: boolean;
	pandocPath: string;
}

const DEFAULT_TEMPLATES: DocxTemplate[] = [
	{ id: "novel", label: "Novel", templatePath: "" },
	{ id: "short", label: "Short", templatePath: "" },
	{ id: "pitch", label: "Pitch", templatePath: "" },
	{ id: "comic", label: "Comic", templatePath: "" },
];

const DEFAULT_SETTINGS: ImpaSettings = {
	templates: DEFAULT_TEMPLATES,
	exportDirectory: "",
	overwriteExisting: false,
	pandocPath: "pandoc",
};

// ─── Vault .docx File Suggest ─────────────────────────────────────────────────
//
// AbstractInputSuggest<T> contract:
//   getSuggestions(query)  → T[]
//   renderSuggestion(T, el) → void
//   selectSuggestion(T, evt) → void   ← must fill the input AND close
//
// We accept an onSelect callback so the caller controls what happens when
// the user clicks a suggestion (set input value + persist to settings).

class VaultFileSuggest extends AbstractInputSuggest<string> {
	private vaultRoot: string;
	private inputEl: HTMLInputElement;
	private onSelect: (value: string) => void;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		onSelect: (value: string) => void
	) {
		super(app, inputEl);
		this.inputEl   = inputEl;
		this.onSelect  = onSelect;
		this.vaultRoot = (app.vault.adapter as any).basePath as string;
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase().replace(/\\/g, "/");
		return this.findDocxFiles(this.vaultRoot, this.vaultRoot)
			.filter(f => f.toLowerCase().replace(/\\/g, "/").includes(q))
			.slice(0, 20);
	}

	renderSuggestion(vaultRelPath: string, el: HTMLElement): void {
		const parts    = vaultRelPath.split("/");
		const fileName = parts.pop() ?? vaultRelPath;
		const folder   = parts.join("/");
		el.createEl("div", { text: fileName, cls: "impa-suggest-filename" });
		if (folder) el.createEl("small", { text: folder, cls: "impa-suggest-folder" });
	}

	// Called by Obsidian when the user clicks or keyboards-selects a suggestion.
	selectSuggestion(vaultRelPath: string, _evt: MouseEvent | KeyboardEvent): void {
		// 1. Fill the visible input
		this.inputEl.value = vaultRelPath;
		// 2. Notify the caller so it can persist to settings
		this.onSelect(vaultRelPath);
		// 3. Close the dropdown
		this.close();
	}

	private findDocxFiles(dir: string, root: string): string[] {
		const results: string[] = [];
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					results.push(...this.findDocxFiles(full, root));
				} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".docx")) {
					results.push(path.relative(root, full).replace(/\\/g, "/"));
				}
			}
		} catch (_) {}
		return results;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function incrementVersion(filename: string): string {
	const m = filename.match(/^(.*?)(\d+)\.(\d+)(\.[^.]+)$/);
	if (!m) {
		const dot = filename.lastIndexOf(".");
		return dot === -1 ? filename + " 1.0" : filename.slice(0, dot) + " 1.0" + filename.slice(dot);
	}
	return `${m[1]}${parseInt(m[2], 10)}.${parseInt(m[3], 10) + 1}${m[4]}`;
}

function resolveOutputPath(p: string): string {
	if (!fs.existsSync(p)) return p;
	const ext  = path.extname(p);
	const base = p.slice(0, p.length - ext.length);
	let n = 2;
	while (fs.existsSync(`${base} (${n})${ext}`)) n++;
	return `${base} (${n})${ext}`;
}

function generateId(): string {
	return "tmpl_" + Math.random().toString(36).slice(2, 9);
}

// ─── Template Picker Modal ────────────────────────────────────────────────────

class TemplatePicker extends Modal {
	constructor(
		app: App,
		private templates: DocxTemplate[],
		private onChoose: (t: DocxTemplate) => void
	) { super(app); }

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Impa — Choose Export Template" });
		contentEl.createEl("p", { text: "Select a Word template to use for this export.", cls: "impa-subtitle" });

		if (this.templates.length === 0) {
			contentEl.createEl("p", { text: "No templates configured. Add them in Impa settings." });
			return;
		}

		const grid = contentEl.createDiv({ cls: "impa-template-grid" });
		for (const tmpl of this.templates) {
			const hasPath = tmpl.templatePath.trim() !== "";
			const btn = grid.createEl("button", {
				text: tmpl.label,
				cls: "impa-template-btn" + (hasPath ? "" : " impa-template-btn--disabled"),
			});
			if (!hasPath) {
				btn.setAttribute("title", "No template file configured in settings");
				btn.setAttribute("disabled", "true");
			} else {
				btn.addEventListener("click", () => { this.close(); this.onChoose(tmpl); });
			}
		}

		contentEl.createDiv({ cls: "impa-cancel-row" })
			.createEl("button", { text: "Cancel", cls: "impa-cancel-btn" })
			.addEventListener("click", () => this.close());
	}

	onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class ImpaSettingTab extends PluginSettingTab {
	private suggests: VaultFileSuggest[] = [];

	constructor(app: App, public plugin: ImpaPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.suggests.forEach(s => s.close());
		this.suggests = [];

		// ── Hero quote ───────────────────────────────────────────────────────
		const quote = containerEl.createEl("blockquote", { cls: "impa-hero-quote" });
		quote.createEl("p").innerHTML =
			`"Princess, it's dangerous to go alone! Take me!" — Impa, <em>Hyrule Warriors</em>`;

		// ── Header ───────────────────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Impa Settings", cls: "impa-settings-header" });

		// ── Pandoc path ──────────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Pandoc path")
			.setDesc('Full path to the pandoc binary, or just "pandoc" if it is on your PATH.')
			.addText(t => t
				.setPlaceholder("pandoc")
				.setValue(this.plugin.settings.pandocPath)
				.onChange(async v => {
					this.plugin.settings.pandocPath = v.trim() || "pandoc";
					await this.plugin.saveSettings();
				}));

		// ── Export directory ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Default export directory")
			.setDesc("Absolute path to the folder where exported .docx files are saved. Leave blank to save next to the source note.")
			.addText(t => t
				.setPlaceholder("/home/you/Documents/Exports")
				.setValue(this.plugin.settings.exportDirectory)
				.onChange(async v => {
					this.plugin.settings.exportDirectory = v.trim();
					await this.plugin.saveSettings();
				}));

		// ── Overwrite toggle ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Overwrite existing files")
			.setDesc("Overwrite a file with the same name in the export directory. When disabled, a unique suffix is added instead.")
			.addToggle(t => t
				.setValue(this.plugin.settings.overwriteExisting)
				.onChange(async v => {
					this.plugin.settings.overwriteExisting = v;
					await this.plugin.saveSettings();
				}));

		// ── Templates ────────────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Export Templates" });
		containerEl.createEl("p", {
			text: "Give each template a name, then type to search for matching .docx files inside your vault. Selecting a suggestion fills the path automatically. Use the trash icon to remove a template.",
			cls: "setting-item-description",
		});

		// Column headers
		const header = containerEl.createDiv({ cls: "impa-template-header" });
		header.createEl("span", { text: "Name" });
		header.createEl("span", { text: "Template file (vault path)" });
		header.createEl("span", { text: "" });

		// Template rows
		for (let i = 0; i < this.plugin.settings.templates.length; i++) {
			this.renderTemplateRow(containerEl, i);
		}

		// Add template button
		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText("+ Add template")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.templates.push({
						id: generateId(),
						label: "New Template",
						templatePath: "",
					});
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	private renderTemplateRow(containerEl: HTMLElement, i: number): void {
		const tmpl = this.plugin.settings.templates[i];
		const row  = containerEl.createDiv({ cls: "impa-template-row" });

		// ── Name input ───────────────────────────────────────────────────────
		const nameWrap  = row.createDiv({ cls: "impa-template-cell" });
		const nameInput = nameWrap.createEl("input", {
			type: "text",
			cls:  "impa-name-input",
		}) as HTMLInputElement;
		nameInput.placeholder = "Template name";
		nameInput.value       = tmpl.label;
		nameInput.addEventListener("change", async () => {
			this.plugin.settings.templates[i].label = nameInput.value;
			await this.plugin.saveSettings();
		});

		// ── Path input with vault autocomplete ───────────────────────────────
		const pathWrap  = row.createDiv({ cls: "impa-template-cell impa-template-cell--wide" });
		const pathInput = pathWrap.createEl("input", {
			type: "text",
			cls:  "impa-path-input",
		}) as HTMLInputElement;
		pathInput.placeholder = "Templates/my-template.docx";
		pathInput.value       = tmpl.templatePath;

		// Manual typing still persists
		pathInput.addEventListener("input", async () => {
			this.plugin.settings.templates[i].templatePath = pathInput.value.trim();
			await this.plugin.saveSettings();
		});

		// Autocomplete: onSelect callback is the canonical write path for
		// suggestion clicks — it sets the value AND persists to settings.
		const suggest = new VaultFileSuggest(
			this.app,
			pathInput,
			async (selected: string) => {
				pathInput.value = selected;
				this.plugin.settings.templates[i].templatePath = selected;
				await this.plugin.saveSettings();
			}
		);
		this.suggests.push(suggest);

		// ── Delete button ────────────────────────────────────────────────────
		const delWrap = row.createDiv({ cls: "impa-template-cell impa-template-cell--btn" });
		const delBtn  = delWrap.createEl("button", {
			cls:  "impa-delete-btn",
			attr: { "aria-label": "Remove template" },
		});
		delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
		delBtn.addEventListener("click", async () => {
			this.plugin.settings.templates.splice(i, 1);
			await this.plugin.saveSettings();
			this.display();
		});
	}
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class ImpaPlugin extends Plugin {
	settings: ImpaSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "impa-increment-version",
			name: "Increment note version",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				this.incrementNoteVersion(file);
			},
		});

		this.addCommand({
			id: "impa-export-docx",
			name: "Export to DOCX via Pandoc",
			checkCallback: (checking) => {
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		if (!this.settings.templates || this.settings.templates.length === 0) {
			this.settings.templates = DEFAULT_TEMPLATES.map(t => ({ ...t }));
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Version increment ────────────────────────────────────────────────────

	async incrementNoteVersion(file: TFile) {
		const folder  = file.parent?.path ?? "";
		const newName = incrementVersion(file.name);
		const newPath = folder ? `${folder}/${newName}` : newName;

		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`⚠️  Impa: "${newName}" already exists in this folder.`);
			return;
		}
		try {
			const content = await this.app.vault.read(file);
			await this.app.vault.create(newPath, content);
			const newFile = this.app.vault.getAbstractFileByPath(newPath);
			if (newFile instanceof TFile) await this.app.workspace.getLeaf(false).openFile(newFile);
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
		new TemplatePicker(this.app, this.settings.templates, (tmpl) => this.runPandocExport(file, tmpl)).open();
	}

	async runPandocExport(file: TFile, template: DocxTemplate) {
		const vaultRoot       = (this.app.vault.adapter as any).basePath as string;
		const sourcePath      = path.join(vaultRoot, file.path);
		const templateAbsPath = path.join(vaultRoot, template.templatePath);

		if (!fs.existsSync(templateAbsPath)) {
			new Notice(`❌  Impa: Template file not found:\n${template.templatePath}`);
			return;
		}

		const baseName = file.basename + ".docx";
		let exportDir  = this.settings.exportDirectory.trim() || path.dirname(sourcePath);

		if (!fs.existsSync(exportDir)) {
			try { fs.mkdirSync(exportDir, { recursive: true }); }
			catch { new Notice(`❌  Impa: Could not create export directory: ${exportDir}`); return; }
		}

		let outputPath = path.join(exportDir, baseName);
		if (!this.settings.overwriteExisting) outputPath = resolveOutputPath(outputPath);

		const pandoc  = this.settings.pandocPath || "pandoc";
		const command = `"${pandoc}" "${sourcePath}" -o "${outputPath}" --reference-doc="${templateAbsPath}"`;

		new Notice(`⏳  Impa: Exporting "${file.name}" as ${template.label}…`);
		exec(command, { cwd: path.dirname(sourcePath) }, (error, _stdout, stderr) => {
			if (error) {
				console.error("Impa pandoc error:", error, stderr);
				new Notice(`❌  Impa: Export failed.\n${stderr || error.message}`);
				return;
			}
			new Notice(`✅  Impa: Exported "${path.basename(outputPath)}" using ${template.label} template.`);
		});
	}
}
