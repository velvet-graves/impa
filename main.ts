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
import { exec, execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const NEO_SLOT_COUNT  = 8;
const STAGING_DIR     = ".neotools-export";
const MANIFEST_FILE   = "manifest.json"; // inside staging dir

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocxTemplate {
	id: string;
	label: string;
	templatePath: string;
}

/** One entry in the Neo slot map */
interface NeoSlot {
	slot: number;         // 1–8
	vaultPath: string;    // vault-relative path to the .md source file
}

/** Written to .neotools-export/manifest.json so send→receive is stateful */
interface NeoManifest {
	slots: Array<{
		slot: number;
		vaultPath: string;       // vault-relative original path
		stagingName: string;     // e.g. "File 1.txt"
	}>;
	lastSent: string | null;     // ISO timestamp
}

interface ImpaSettings {
	templates: DocxTemplate[];
	exportDirectory: string;
	overwriteExisting: boolean;
	pandocPath: string;
	neotoolsPath: string;        // "neotools" if on PATH, else absolute
	neoSlots: NeoSlot[];         // 8 slots
}

const DEFAULT_TEMPLATES: DocxTemplate[] = [
	{ id: "novel", label: "Novel", templatePath: "" },
	{ id: "short", label: "Short", templatePath: "" },
	{ id: "pitch", label: "Pitch", templatePath: "" },
	{ id: "comic", label: "Comic", templatePath: "" },
];

const DEFAULT_NEO_SLOTS: NeoSlot[] = Array.from({ length: NEO_SLOT_COUNT }, (_, i) => ({
	slot: i + 1,
	vaultPath: "",
}));

const DEFAULT_SETTINGS: ImpaSettings = {
	templates: DEFAULT_TEMPLATES,
	exportDirectory: "",
	overwriteExisting: false,
	pandocPath: "pandoc",
	neotoolsPath: "neotools",
	neoSlots: DEFAULT_NEO_SLOTS,
};

// ─── Vault File Suggest (generic) ─────────────────────────────────────────────

type FileFilter = (relPath: string) => boolean;

class VaultFileSuggest extends AbstractInputSuggest<string> {
	private vaultRoot: string;
	private inputEl: HTMLInputElement;
	private onSelect: (value: string) => void;
	private filter: FileFilter;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		onSelect: (value: string) => void,
		filter: FileFilter = () => true
	) {
		super(app, inputEl);
		this.inputEl   = inputEl;
		this.onSelect  = onSelect;
		this.filter    = filter;
		this.vaultRoot = (app.vault.adapter as any).basePath as string;
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase().replace(/\\/g, "/");
		return this.findFiles(this.vaultRoot, this.vaultRoot)
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

	selectSuggestion(vaultRelPath: string, _evt: MouseEvent | KeyboardEvent): void {
		this.inputEl.value = vaultRelPath;
		this.onSelect(vaultRelPath);
		this.close();
	}

	private findFiles(dir: string, root: string): string[] {
		const results: string[] = [];
		try {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					results.push(...this.findFiles(full, root));
				} else if (entry.isFile()) {
					const rel = path.relative(root, full).replace(/\\/g, "/");
					if (this.filter(rel)) results.push(rel);
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

/** Run a shell command and return stdout, or throw with stderr on failure */
function runCommand(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, (err, stdout, stderr) => {
			if (err) reject(new Error(stderr || err.message));
			else resolve(stdout);
		});
	});
}

/** Check whether a command exists on PATH / at the given path */
function checkCommandExists(cmd: string): Promise<boolean> {
	return new Promise(resolve => {
		exec(`command -v "${cmd}"`, (err) => resolve(!err));
	});
}

// ─── Neotools Status Check ────────────────────────────────────────────────────

async function assertNeotools(neotoolsPath: string): Promise<void> {
	const exists = await checkCommandExists(neotoolsPath);
	if (!exists) {
		throw new Error(
			`neotools not found at "${neotoolsPath}". ` +
			`Install neotools and set the correct path in Impa → Neo Sync settings.`
		);
	}
}

// ─── Neo Sync: Send Modal ─────────────────────────────────────────────────────

class NeoSendConfirmModal extends Modal {
	private slots: NeoSlot[];
	private vaultRoot: string;
	private onConfirm: () => void;

	constructor(app: App, slots: NeoSlot[], vaultRoot: string, onConfirm: () => void) {
		super(app);
		this.slots     = slots;
		this.vaultRoot = vaultRoot;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Send to Alphasmart Neo" });
		contentEl.createEl("p", {
			text: "The following files will be copied to the staging area, renamed, and written to your Neo. Make sure your Neo is connected.",
			cls: "impa-subtitle",
		});

		const configured = this.slots.filter(s => s.vaultPath.trim() !== "");
		if (configured.length === 0) {
			contentEl.createEl("p", { text: "⚠️  No files assigned to Neo slots. Configure them in Impa settings." });
			this.addCancelBtn(contentEl);
			return;
		}

		const table = contentEl.createEl("table", { cls: "impa-neo-table" });
		const thead = table.createEl("thead");
		const hr    = thead.createEl("tr");
		hr.createEl("th", { text: "Neo Slot" });
		hr.createEl("th", { text: "Vault File" });
		hr.createEl("th", { text: "Sends As" });

		const tbody = table.createEl("tbody");
		for (const slot of configured) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: `File ${slot.slot}` });
			tr.createEl("td", { text: path.basename(slot.vaultPath), attr: { title: slot.vaultPath } });
			tr.createEl("td", { text: `File ${slot.slot}.txt` });
		}

		const btnRow = contentEl.createDiv({ cls: "impa-btn-row" });
		btnRow.createEl("button", { text: "Send", cls: "mod-cta impa-confirm-btn" })
			.addEventListener("click", () => { this.close(); this.onConfirm(); });
		this.addCancelBtn(btnRow);
	}

	private addCancelBtn(parent: HTMLElement) {
		parent.createEl("button", { text: "Cancel", cls: "impa-cancel-btn" })
			.addEventListener("click", () => this.close());
	}

	onClose() { this.contentEl.empty(); }
}

// ─── Neo Sync: Receive Result Modal ──────────────────────────────────────────

interface ReceiveResult {
	slot: number;
	vaultPath: string;
	status: "updated" | "skipped" | "missing";
	reason?: string;
}

class NeoReceiveResultModal extends Modal {
	constructor(app: App, private results: ReceiveResult[]) { super(app); }

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Sync from Alphasmart Neo — Results" });

		const table = contentEl.createEl("table", { cls: "impa-neo-table" });
		const thead = table.createEl("thead");
		const hr    = thead.createEl("tr");
		hr.createEl("th", { text: "Slot" });
		hr.createEl("th", { text: "Vault File" });
		hr.createEl("th", { text: "Result" });

		const tbody = table.createEl("tbody");
		for (const r of this.results) {
			const tr  = tbody.createEl("tr");
			const icon = r.status === "updated" ? "✅" : r.status === "skipped" ? "⏭️" : "❓";
			tr.createEl("td", { text: `File ${r.slot}` });
			tr.createEl("td", { text: r.vaultPath ? path.basename(r.vaultPath) : "(not mapped)" });
			tr.createEl("td", { text: `${icon} ${r.reason ?? r.status}` });
		}

		contentEl.createDiv({ cls: "impa-cancel-row" })
			.createEl("button", { text: "Close", cls: "impa-cancel-btn" })
			.addEventListener("click", () => this.close());
	}

	onClose() { this.contentEl.empty(); }
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
	private neotoolsStatusEl: HTMLElement | null = null;

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

		containerEl.createEl("h2", { text: "Impa Settings", cls: "impa-settings-header" });

		// ═══════════════════════════════════════════════════════════════════
		// PANDOC SECTION
		// ═══════════════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Pandoc Export" });

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

		new Setting(containerEl)
			.setName("Overwrite existing files")
			.setDesc("Overwrite a file with the same name in the export directory. When disabled, a unique suffix is added instead.")
			.addToggle(t => t
				.setValue(this.plugin.settings.overwriteExisting)
				.onChange(async v => {
					this.plugin.settings.overwriteExisting = v;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl("h3", { text: "Docx Templates" });
		containerEl.createEl("p", {
			text: "Give each template a name, then type to search for matching .docx files inside your vault. Selecting a suggestion fills the path automatically.",
			cls: "setting-item-description",
		});

		const tmplHeader = containerEl.createDiv({ cls: "impa-template-header" });
		tmplHeader.createEl("span", { text: "Name" });
		tmplHeader.createEl("span", { text: "Template file (vault path)" });
		tmplHeader.createEl("span", { text: "" });

		for (let i = 0; i < this.plugin.settings.templates.length; i++) {
			this.renderTemplateRow(containerEl, i);
		}

		new Setting(containerEl)
			.addButton(btn => btn
				.setButtonText("+ Add template")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.templates.push({ id: generateId(), label: "New Template", templatePath: "" });
					await this.plugin.saveSettings();
					this.display();
				}));

		// ═══════════════════════════════════════════════════════════════════
		// NEO SYNC SECTION
		// ═══════════════════════════════════════════════════════════════════
		containerEl.createEl("h3", { text: "Alphasmart Neo Sync" });
		containerEl.createEl("p", {
			text: `Files are staged in your vault's ${STAGING_DIR}/ folder during sync. A manifest inside that folder tracks which vault file maps to which Neo slot, so the return trip can restore names automatically.`,
			cls: "setting-item-description",
		});

		// Neotools path + live status indicator
		const neoPathSetting = new Setting(containerEl)
			.setName("Neotools path")
			.setDesc('The neotools CLI command. Leave as "neotools" if it is on your PATH, or enter the full path to the binary.')
			.addText(t => t
				.setPlaceholder("neotools")
				.setValue(this.plugin.settings.neotoolsPath)
				.onChange(async v => {
					this.plugin.settings.neotoolsPath = v.trim() || "neotools";
					await this.plugin.saveSettings();
					this.checkNeotoolsStatus();
				}));

		// Status badge next to the setting
		this.neotoolsStatusEl = neoPathSetting.settingEl.createDiv({ cls: "impa-neo-status impa-neo-status--checking" });
		this.neotoolsStatusEl.setText("Checking…");
		this.checkNeotoolsStatus();

		// Slot assignments
		containerEl.createEl("h4", { text: "File slot assignments" });
		containerEl.createEl("p", {
			text: "Assign a vault note to each of the 8 file slots on your Neo. Unassigned slots are skipped during sync.",
			cls: "setting-item-description",
		});

		const slotHeader = containerEl.createDiv({ cls: "impa-template-header" });
		slotHeader.createEl("span", { text: "Neo Slot" });
		slotHeader.createEl("span", { text: "Vault file (.md)" });
		slotHeader.createEl("span", { text: "" }); // clear btn

		for (let i = 0; i < NEO_SLOT_COUNT; i++) {
			this.renderNeoSlotRow(containerEl, i);
		}
	}

	// ── neotools status badge ────────────────────────────────────────────────

	private checkNeotoolsStatus() {
		if (!this.neotoolsStatusEl) return;
		const el = this.neotoolsStatusEl;
		el.className = "impa-neo-status impa-neo-status--checking";
		el.setText("Checking…");

		checkCommandExists(this.plugin.settings.neotoolsPath).then(found => {
			if (found) {
				el.className = "impa-neo-status impa-neo-status--ok";
				el.setText("✓ Found");
			} else {
				el.className = "impa-neo-status impa-neo-status--error";
				el.setText("✗ Not found");
			}
		});
	}

	// ── template row ─────────────────────────────────────────────────────────

	private renderTemplateRow(containerEl: HTMLElement, i: number): void {
		const tmpl = this.plugin.settings.templates[i];
		const row  = containerEl.createDiv({ cls: "impa-template-row" });

		const nameWrap  = row.createDiv({ cls: "impa-template-cell" });
		const nameInput = nameWrap.createEl("input", { type: "text", cls: "impa-name-input" }) as HTMLInputElement;
		nameInput.placeholder = "Template name";
		nameInput.value       = tmpl.label;
		nameInput.addEventListener("change", async () => {
			this.plugin.settings.templates[i].label = nameInput.value;
			await this.plugin.saveSettings();
		});

		const pathWrap  = row.createDiv({ cls: "impa-template-cell impa-template-cell--wide" });
		const pathInput = pathWrap.createEl("input", { type: "text", cls: "impa-path-input" }) as HTMLInputElement;
		pathInput.placeholder = "Templates/my-template.docx";
		pathInput.value       = tmpl.templatePath;
		pathInput.addEventListener("input", async () => {
			this.plugin.settings.templates[i].templatePath = pathInput.value.trim();
			await this.plugin.saveSettings();
		});

		const suggest = new VaultFileSuggest(this.app, pathInput,
			async (selected) => {
				pathInput.value = selected;
				this.plugin.settings.templates[i].templatePath = selected;
				await this.plugin.saveSettings();
			},
			(rel) => rel.toLowerCase().endsWith(".docx")
		);
		this.suggests.push(suggest);

		const delWrap = row.createDiv({ cls: "impa-template-cell impa-template-cell--btn" });
		const delBtn  = delWrap.createEl("button", { cls: "impa-delete-btn", attr: { "aria-label": "Remove template" } });
		delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
		delBtn.addEventListener("click", async () => {
			this.plugin.settings.templates.splice(i, 1);
			await this.plugin.saveSettings();
			this.display();
		});
	}

	// ── Neo slot row ─────────────────────────────────────────────────────────

	private renderNeoSlotRow(containerEl: HTMLElement, i: number): void {
		// Ensure the slot exists (safety for settings migration)
		if (!this.plugin.settings.neoSlots[i]) {
			this.plugin.settings.neoSlots[i] = { slot: i + 1, vaultPath: "" };
		}

		const slot = this.plugin.settings.neoSlots[i];
		const row  = containerEl.createDiv({ cls: "impa-template-row" });

		// Slot label (read-only)
		const labelWrap = row.createDiv({ cls: "impa-template-cell" });
		labelWrap.createEl("span", { text: `File ${slot.slot}`, cls: "impa-slot-label" });

		// Vault file path input with .md autocomplete
		const pathWrap  = row.createDiv({ cls: "impa-template-cell impa-template-cell--wide" });
		const pathInput = pathWrap.createEl("input", { type: "text", cls: "impa-path-input" }) as HTMLInputElement;
		pathInput.placeholder = "Writing/my-novel 1.0.md";
		pathInput.value       = slot.vaultPath;
		pathInput.addEventListener("input", async () => {
			this.plugin.settings.neoSlots[i].vaultPath = pathInput.value.trim();
			await this.plugin.saveSettings();
		});

		const suggest = new VaultFileSuggest(this.app, pathInput,
			async (selected) => {
				pathInput.value = selected;
				this.plugin.settings.neoSlots[i].vaultPath = selected;
				await this.plugin.saveSettings();
			},
			(rel) => rel.toLowerCase().endsWith(".md") && !rel.startsWith(STAGING_DIR)
		);
		this.suggests.push(suggest);

		// Clear button
		const clearWrap = row.createDiv({ cls: "impa-template-cell impa-template-cell--btn" });
		const clearBtn  = clearWrap.createEl("button", { cls: "impa-delete-btn", attr: { "aria-label": "Clear slot" } });
		clearBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		clearBtn.addEventListener("click", async () => {
			pathInput.value = "";
			this.plugin.settings.neoSlots[i].vaultPath = "";
			await this.plugin.saveSettings();
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

		this.addCommand({
			id: "impa-neo-send",
			name: "Send to Alphasmart Neo",
			callback: () => this.neoSend(),
		});

		this.addCommand({
			id: "impa-neo-receive",
			name: "Sync from Alphasmart Neo",
			callback: () => this.neoReceive(),
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
		// Ensure 8 slots always exist
		if (!this.settings.neoSlots || this.settings.neoSlots.length !== NEO_SLOT_COUNT) {
			const existing = this.settings.neoSlots ?? [];
			this.settings.neoSlots = Array.from({ length: NEO_SLOT_COUNT }, (_, i) =>
				existing[i] ?? { slot: i + 1, vaultPath: "" }
			);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Staging dir helpers ──────────────────────────────────────────────────

	private get vaultRoot(): string {
		return (this.app.vault.adapter as any).basePath as string;
	}

	private get stagingPath(): string {
		return path.join(this.vaultRoot, STAGING_DIR);
	}

	private get manifestPath(): string {
		return path.join(this.stagingPath, MANIFEST_FILE);
	}

	private ensureStagingDir() {
		if (!fs.existsSync(this.stagingPath)) {
			fs.mkdirSync(this.stagingPath, { recursive: true });
		}
	}

	private readManifest(): NeoManifest {
		try {
			if (fs.existsSync(this.manifestPath)) {
				return JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
			}
		} catch (_) {}
		return { slots: [], lastSent: null };
	}

	private writeManifest(manifest: NeoManifest) {
		this.ensureStagingDir();
		fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
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
		if (this.settings.templates.filter(t => t.templatePath.trim() !== "").length === 0) {
			new Notice("⚠️  Impa: No templates configured. Add template paths in Impa settings.");
			return;
		}
		new TemplatePicker(this.app, this.settings.templates, (tmpl) => this.runPandocExport(file, tmpl)).open();
	}

	async runPandocExport(file: TFile, template: DocxTemplate) {
		const sourcePath      = path.join(this.vaultRoot, file.path);
		const templateAbsPath = path.join(this.vaultRoot, template.templatePath);

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

	// ── Neo: Send to Alphasmart ──────────────────────────────────────────────

	async neoSend() {
		// Check neotools exists first
		try { await assertNeotools(this.settings.neotoolsPath); }
		catch (e: any) { new Notice(`❌  Impa: ${e.message}`); return; }

		const configured = this.settings.neoSlots.filter(s => s.vaultPath.trim() !== "");
		if (configured.length === 0) {
			new Notice("⚠️  Impa: No files assigned to Neo slots. Configure them in Impa settings.");
			return;
		}

		new NeoSendConfirmModal(this.app, this.settings.neoSlots, this.vaultRoot, async () => {
			await this.executeSend(configured);
		}).open();
	}

	private async executeSend(slots: NeoSlot[]) {
		this.ensureStagingDir();
		const manifest: NeoManifest = { slots: [], lastSent: new Date().toISOString() };
		const errors: string[] = [];

		new Notice(`⏳  Impa: Preparing files for Neo…`);

		for (const slot of slots) {
			const sourcePath  = path.join(this.vaultRoot, slot.vaultPath);
			const stagingName = `File ${slot.slot}.txt`;
			const stagingDest = path.join(this.stagingPath, stagingName);

			if (!fs.existsSync(sourcePath)) {
				errors.push(`Slot ${slot.slot}: source file not found (${slot.vaultPath})`);
				continue;
			}

			try {
				// Read as UTF-8 markdown, write as plain text with .txt extension
				const content = fs.readFileSync(sourcePath, "utf8");
				fs.writeFileSync(stagingDest, content, "utf8");

				manifest.slots.push({
					slot: slot.slot,
					vaultPath: slot.vaultPath,
					stagingName,
				});
			} catch (e: any) {
				errors.push(`Slot ${slot.slot}: ${e.message}`);
			}
		}

		this.writeManifest(manifest);

		if (errors.length > 0) {
			new Notice(`⚠️  Impa: Staging errors:\n${errors.join("\n")}`);
		}

		// Push each staged file to the Neo via neotools.
		// Correct syntax: neotools files write <filepath> <slot>
		const neoErrors: string[] = [];
		for (const entry of manifest.slots) {
			const stagingFile = path.join(this.stagingPath, entry.stagingName);
			try {
				await runCommand(this.settings.neotoolsPath, ["files", "write", stagingFile, String(entry.slot)]);
			} catch (e: any) {
				neoErrors.push(`Slot ${entry.slot}: ${e.message}`);
			}
		}

		if (neoErrors.length > 0) {
			new Notice(`❌  Impa: neotools errors:\n${neoErrors.join("\n")}`);
		} else {
			new Notice(`✅  Impa: ${manifest.slots.length} file(s) sent to Neo successfully.`);
		}
	}

	// ── Neo: Receive from Alphasmart ─────────────────────────────────────────

	async neoReceive() {
		try { await assertNeotools(this.settings.neotoolsPath); }
		catch (e: any) { new Notice(`❌  Impa: ${e.message}`); return; }

		const manifest = this.readManifest();
		if (manifest.slots.length === 0) {
			new Notice("⚠️  Impa: No sync manifest found. Run \"Send to Alphasmart Neo\" first to establish the slot mapping.");
			return;
		}

		this.ensureStagingDir();
		new Notice(`⏳  Impa: Reading files from Neo…`);

		const results: ReceiveResult[] = [];

		// Step 1: Pull ALL files from Neo into staging in one command.
		// Correct syntax: neotools files read-all --path <directory>
		// This produces "File 1.txt", "File 3.txt", etc. in the staging dir,
		// matching the names we wrote during the send — so the manifest entries
		// align directly with the files on disk.
		try {
			await runCommand(this.settings.neotoolsPath, ["files", "read-all", "--path", this.stagingPath]);
		} catch (e: any) {
			new Notice(`❌  Impa: neotools read-all failed:\n${(e as Error).message}`);
			return;
		}

		// Step 2: For each mapped slot, compare mtimes and write back to vault.
		for (const entry of manifest.slots) {
			const stagingFile  = path.join(this.stagingPath, entry.stagingName);
			const vaultAbsPath = path.join(this.vaultRoot, entry.vaultPath);
			const result: ReceiveResult = {
				slot: entry.slot,
				vaultPath: entry.vaultPath,
				status: "missing",
			};

			// If neotools didn't produce this file, the slot was empty on the Neo
			if (!fs.existsSync(stagingFile)) {
				result.status = "missing";
				result.reason = "File not present on Neo";
				results.push(result);
				continue;
			}

			// Skip if vault file is newer than what came off the Neo
			if (fs.existsSync(vaultAbsPath)) {
				const vaultMtime   = fs.statSync(vaultAbsPath).mtimeMs;
				const stagingMtime = fs.statSync(stagingFile).mtimeMs;
				if (vaultMtime > stagingMtime) {
					result.status = "skipped";
					result.reason = "Vault file is newer — not overwritten";
					results.push(result);
					continue;
				}
			}

			// Overwrite the vault file
			try {
				const content     = fs.readFileSync(stagingFile, "utf8");
				const vaultParent = path.dirname(vaultAbsPath);
				if (!fs.existsSync(vaultParent)) fs.mkdirSync(vaultParent, { recursive: true });
				fs.writeFileSync(vaultAbsPath, content, "utf8");

				// Nudge Obsidian's cache if the file is currently open
				const obsFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
				if (obsFile instanceof TFile) await this.app.vault.read(obsFile);

				result.status = "updated";
				result.reason = "Updated from Neo";
			} catch (e: any) {
				result.status = "missing";
				result.reason = `Write error: ${(e as Error).message}`;
			}

			results.push(result);
		}

		new NeoReceiveResultModal(this.app, results).open();
	}
}
