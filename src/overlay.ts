import type { Model } from "@oh-my-pi/pi-ai";
import type { PlanReviewOption } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Component, Focusable, Tab, TabBarTheme, TUI } from "@oh-my-pi/pi-tui";
import {
	Input,
	Markdown,
	matchesKey,
	parseSgrMouse,
	replaceTabs,
	ScrollView,
	TabBar,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { CouncilSession, isReviewerTurnEntry, type ReviewerTurnEntry } from "./council-session";

export type CouncilOverlayOutcome =
	| { action: "close" }
	| { action: "refine"; feedback: string }
	| { action: "approve"; choice: "execute" | "compact" | "keep" };

export interface PlanCouncilOverlayOptions {
	reviewOptions: PlanReviewOption[];
	synthesizerModel: Model | undefined;
	synthesizerThinkingLevel?: ConfiguredThinkingLevel;
	warnings?: string[];
	autoProceed?: boolean;
	autoDebate?: boolean;
}

interface StatusBanner {
	text: string;
	isError: boolean;
}

export class PlanCouncilOverlay implements Component, Focusable {
	#tui: TUI;
	#session: CouncilSession;
	#reviewOptions: PlanReviewOption[];
	#synthesizerModel: Model | undefined;
	#synthesizerThinkingLevel: ConfiguredThinkingLevel | undefined;
	#warnings: string[];
	#done: (result: CouncilOverlayOutcome) => void;
	#autoProceed: boolean;
	#autoDebate: boolean;
	#autoStage?: string;
	#mode: "browse" | "compose" = "browse";
	#tabBar: TabBar;
	#scrollView: ScrollView;
	#input: Input;
	#modelCursor = 0;
	#statusBanner?: StatusBanner;

	#planMarkdown: Markdown;
	#markdownCache = new Map<string, { text: string; md: Markdown }>();
	#unsubscribeSession: () => void;

	focused = true;

	constructor(
		tui: TUI,
		session: CouncilSession,
		options: PlanCouncilOverlayOptions,
		done: (result: CouncilOverlayOutcome) => void,
	) {
		this.#tui = tui;
		this.#session = session;
		this.#reviewOptions = options.reviewOptions;
		this.#synthesizerModel = options.synthesizerModel;
		this.#synthesizerThinkingLevel = options.synthesizerThinkingLevel;
		this.#warnings = options.warnings ?? [];
		this.#autoProceed = options.autoProceed ?? false;
		this.#autoDebate = options.autoDebate ?? true;
		this.#done = done;

		const tabBarTheme: TabBarTheme = {
			label: text => theme.bold(theme.fg("accent", text)),
			activeTab: text => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
			inactiveTab: text => theme.fg("muted", text),
			hint: text => theme.fg("muted", text),
		};

		this.#tabBar = new TabBar("", this.#buildTabs(), tabBarTheme);
		this.#tabBar.showHint = false;

		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: {
				track: t => theme.fg("muted", t),
				thumb: t => theme.fg("accent", t),
			},
		});

		this.#input = new Input();
		this.#input.prompt = "Ask council > ";

		this.#planMarkdown = new Markdown(session.planContent, 1, 0, getMarkdownTheme());

		this.#unsubscribeSession = this.#session.subscribe(() => {
			this.#syncTabs();
			this.#tui.requestRender();
		});

		if (this.#autoProceed) {
			void this.#runAutoPipeline(true);
		}
	}

	dispose(): void {
		this.#unsubscribeSession();
	}

	#buildTabs(): Tab[] {
		const tabs: Tab[] = [{ id: "council", label: "Council" }];

		for (const r of this.#session.activeReviewers) {
			const entries = this.#session.entries.filter(
				(e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === r.key,
			);
			const latest = entries[entries.length - 1];
			let icon = "";
			if (latest?.status === "streaming") {
				icon = "⏳ ";
			} else if (latest?.status === "error") {
				icon = "✗ ";
			} else if (latest?.status === "done") {
				icon = "✓ ";
			}

			tabs.push({
				id: `reviewer:${r.key}`,
				label: `${icon}${r.model.id}`,
			});
		}

		const synthReady = this.#session.latestSynthesis?.status === "done";
		tabs.push({
			id: "synthesis",
			label: `Synthesis${synthReady ? " ★" : ""}`,
		});

		tabs.push({
			id: "plan",
			label: "Plan",
		});

		tabs.push({
			id: "models",
			label: `Models (${this.#session.activeReviewers.length})`,
		});

		return tabs;
	}

	#syncTabs(): void {
		const currentActiveId = this.#tabBar.getActiveTab()?.id;
		this.#tabBar.setTabs(this.#buildTabs(), currentActiveId);
	}

	#getEntryMarkdown(id: string, text: string): Markdown {
		const cached = this.#markdownCache.get(id);
		if (cached && cached.text === text) {
			return cached.md;
		}
		const md = new Markdown(text, 1, 0, getMarkdownTheme());
		this.#markdownCache.set(id, { text, md });
		return md;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const totalHeight = Math.max(12, this.#tui.terminal?.rows || process.stdout.rows || 30);
		const headerRows = 3;
		const footerRows = 3;
		const bodyHeight = Math.max(4, totalHeight - headerRows - footerRows);

		this.#syncTabs();

		// Row 1: Title bar
		const roundBadge =
			this.#session.round > 0
				? theme.fg("accent", ` [Round ${this.#session.round}${this.#session.isBusy() ? " ⏳" : ""}]`)
				: "";
		const warnBadge =
			this.#warnings.length > 0
				? theme.fg("warning", ` (${this.#warnings.length} warning${this.#warnings.length === 1 ? "" : "s"})`)
				: "";
		const autoBadge = this.#autoStage ? theme.fg("accent", ` [Auto: ${this.#autoStage}]`) : "";
		const rawTitle = `Plan Council · ${this.#session.planTitle}${roundBadge}${autoBadge}${warnBadge}`;
		const titleLine = truncateToWidth(replaceTabs(rawTitle), safeWidth);

		// Row 2: TabBar
		const tabLine = this.#tabBar.render(safeWidth)[0] ?? "";

		// Row 3: Header divider
		const topDivider = theme.fg("muted", "─".repeat(safeWidth));

		// Middle Body
		const activeTab = this.#tabBar.getActiveTab()?.id ?? "council";
		const lines: string[] = [];
		const contentWidth = Math.max(10, safeWidth - 4);

		if (activeTab === "council") {
			if (this.#session.entries.length === 0) {
				lines.push(
					"",
					theme.fg("muted", "  No council critiques yet."),
					"",
					theme.fg("accent", "  Getting started:"),
					`  • Press ${theme.bold("r")} to run Round 1 critiques across active models`,
					`  • Press ${theme.bold("m")} to view and select reviewer models`,
					`  • Press ${theme.bold("i")} to ask a question or guide the council`,
					"",
				);
			} else {
				for (const entry of this.#session.entries) {
					if (entry.kind === "user") {
						const target = entry.targetLabel ? ` → ${entry.targetLabel}` : " → Council";
						lines.push(theme.bold(theme.fg("accent", `[Operator${target}]`)));
						for (const l of entry.text.split("\n")) {
							lines.push(`  ${replaceTabs(l)}`);
						}
						lines.push("");
					} else if (entry.kind === "synthesis") {
						let badge = "";
						if (entry.status === "streaming") badge = theme.fg("warning", " ⏳ synthesizing...");
						else if (entry.status === "error") badge = theme.fg("error", " ✗ error");
						lines.push(theme.bold(theme.fg("accent", `[Synthesis · ${entry.modelLabel}]`)) + badge);
						if (entry.text) {
							const md = this.#getEntryMarkdown(entry.id, entry.text);
							lines.push(...md.render(contentWidth));
						}
						lines.push("");
					} else {
						let badge = "";
						if (entry.status === "streaming") badge = theme.fg("warning", " ⏳ streaming...");
						else if (entry.status === "error") badge = theme.fg("error", " ✗ error");
						else if (entry.status === "aborted") badge = theme.fg("dim", " ⊘ aborted");
						lines.push(
							theme.bold(theme.fg("accent", `[${entry.reviewerLabel} · Round ${entry.round} ${entry.kind}]`)) + badge,
						);
						if (entry.status === "error" && entry.errorMessage) {
							lines.push(theme.fg("error", `  Error: ${replaceTabs(entry.errorMessage)}`));
						}
						if (entry.text) {
							const md = this.#getEntryMarkdown(entry.id, entry.text);
							lines.push(...md.render(contentWidth));
						}
						lines.push("");
					}
				}
			}
		} else if (activeTab.startsWith("reviewer:")) {
			const reviewerKey = activeTab.slice("reviewer:".length);
			const matchingEntries = this.#session.entries.filter(e => {
				if (e.kind === "user") {
					return !e.targetReviewerKey || e.targetReviewerKey === reviewerKey;
				}
				return isReviewerTurnEntry(e) && e.reviewerKey === reviewerKey;
			});

			if (matchingEntries.length === 0) {
				lines.push("", theme.fg("muted", "  No entries for this reviewer yet."), "");
			} else {
				for (const entry of matchingEntries) {
					if (entry.kind === "user") {
						const target = entry.targetLabel ? ` → ${entry.targetLabel}` : " → Council";
						lines.push(theme.bold(theme.fg("accent", `[Operator${target}]`)));
						for (const l of entry.text.split("\n")) {
							lines.push(`  ${replaceTabs(l)}`);
						}
						lines.push("");
					} else if (isReviewerTurnEntry(entry)) {
						let badge = "";
						if (entry.status === "streaming") badge = theme.fg("warning", " ⏳ streaming...");
						else if (entry.status === "error") badge = theme.fg("error", " ✗ error");
						else if (entry.status === "aborted") badge = theme.fg("dim", " ⊘ aborted");
						lines.push(
							theme.bold(theme.fg("accent", `[${entry.reviewerLabel} · Round ${entry.round} ${entry.kind}]`)) + badge,
						);
						if (entry.status === "error" && entry.errorMessage) {
							lines.push(theme.fg("error", `  Error: ${replaceTabs(entry.errorMessage)}`));
						}
						if (entry.text) {
							const md = this.#getEntryMarkdown(entry.id, entry.text);
							lines.push(...md.render(contentWidth));
						}
						lines.push("");
					}
				}
			}
		} else if (activeTab === "synthesis") {
			const latestSynth = this.#session.latestSynthesis;
			if (latestSynth) {
				let badge = "";
				if (latestSynth.status === "streaming") badge = theme.fg("warning", " ⏳ synthesizing...");
				else if (latestSynth.status === "error") badge = theme.fg("error", " ✗ error");
				lines.push(theme.bold(theme.fg("accent", `Synthesis by ${latestSynth.modelLabel}:`)) + badge);
				if (latestSynth.status === "error" && latestSynth.errorMessage) {
					lines.push(theme.fg("error", `  Error: ${replaceTabs(latestSynth.errorMessage)}`));
				}
				if (latestSynth.text) {
					const md = this.#getEntryMarkdown(latestSynth.id, latestSynth.text);
					lines.push(...md.render(contentWidth));
				}
			} else {
				lines.push(
					"",
					theme.fg("muted", "  No synthesis available yet."),
					"",
					`  • Press ${theme.bold("s")} to synthesize council reviews into actionable instructions`,
					`  • Press ${theme.bold("f")} to synthesize and immediately apply feedback to refine the plan`,
					"",
				);
			}
		} else if (activeTab === "plan") {
			lines.push(...this.#planMarkdown.render(contentWidth));
		} else if (activeTab === "models") {
			lines.push(
				theme.bold(theme.fg("accent", "Council Reviewer Models (Space to toggle, Enter to start critiques):")),
				"",
			);
			for (let i = 0; i < this.#session.availableReviewers.length; i++) {
				const m = this.#session.availableReviewers[i];
				const isSelected = this.#session.activeReviewers.some(r => r.key === m.key);
				const cursor = i === this.#modelCursor ? theme.fg("accent", "> ") : "  ";
				const box = isSelected ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = `${m.label} ${theme.fg("muted", `[family: ${m.family}]`)}`;
				lines.push(`${cursor}${box} ${label}`);
			}
		}

		this.#scrollView.setHeight(bodyHeight);
		this.#scrollView.setLines(lines);

		const isStreamingTab =
			this.#session.isBusy() &&
			(activeTab === "council" || activeTab.startsWith("reviewer:") || activeTab === "synthesis");
		this.#scrollView.setFollowTail(isStreamingTab);

		const bodyLines = this.#scrollView.render(safeWidth);

		// Bottom chrome
		// Footer Row 1: Divider + transient status banner
		let statusLine: string;
		if (this.#statusBanner) {
			const color = this.#statusBanner.isError ? "error" : "accent";
			statusLine = theme.fg(color, replaceTabs(truncateToWidth(this.#statusBanner.text, safeWidth)));
		} else {
			statusLine = theme.fg("muted", "─".repeat(safeWidth));
		}

		// Footer Row 2: Input composer
		if (activeTab.startsWith("reviewer:")) {
			const reviewerKey = activeTab.slice("reviewer:".length);
			const reviewer = this.#session.availableReviewers.find(r => r.key === reviewerKey);
			this.#input.prompt = `Reply @${reviewer?.model.id ?? "model"} > `;
		} else {
			this.#input.prompt = "Ask council > ";
		}

		if (this.#mode === "compose") {
			this.#input.focused = true;
			this.#input.placeholder = "Type your question or guidance... (Enter to send, Esc to browse)";
		} else {
			this.#input.focused = false;
			this.#input.placeholder = "Press i to ask a question or give operator guidance...";
		}
		const inputLine = this.#input.render(safeWidth)[0] ?? "";

		// Footer Row 3: Key hints
		let hintLine: string;
		if (this.#mode === "compose") {
			hintLine = theme.fg("muted", "Enter submit question · Esc back to browse mode");
		} else if (activeTab === "models") {
			hintLine = theme.fg(
				"muted",
				"Tab tabs · ↑↓/jk select model · Space toggle · Enter start critiques · Esc close",
			);
		} else {
			hintLine = theme.fg(
				"muted",
				"Space Auto-run · r critique · d debate · i ask · s synth · f refine · a approve · x stop · Esc close",
			);
		}

		return [titleLine, tabLine, topDivider, ...bodyLines, statusLine, inputLine, hintLine];
	}

	/** dispatch council controls with the configured synthesizer model and thinking level */
	handleInput(data: string): void {
		// SGR mouse scroll support
		if (data.startsWith("\x1b[<")) {
			const m = parseSgrMouse(data);
			if (m?.wheel) {
				this.#scrollView.scroll(m.wheel * 3);
				this.#tui.requestRender();
			}
			return;
		}

		if (this.#mode === "compose") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#mode = "browse";
				this.#input.focused = false;
				this.#tui.requestRender();
				return;
			}

			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				const text = this.#input.getValue().trim();
				if (!text) {
					this.#mode = "browse";
					this.#input.focused = false;
					this.#tui.requestRender();
					return;
				}

				const activeTab = this.#tabBar.getActiveTab()?.id;
				let defaultTargetKey: string | undefined;
				if (activeTab?.startsWith("reviewer:")) {
					defaultTargetKey = activeTab.slice("reviewer:".length);
				}

				void this.#session
					.askCouncil(text, defaultTargetKey)
					.then(() => {
						this.#input.setValue("");
						this.#mode = "browse";
						this.#input.focused = false;
						this.#statusBanner = undefined;
						this.#tui.requestRender();
					})
					.catch(err => {
						this.#statusBanner = {
							text: err instanceof Error ? err.message : String(err),
							isError: true,
						};
						this.#tui.requestRender();
					});
				return;
			}

			this.#input.handleInput(data);
			this.#tui.requestRender();
			return;
		}

		// Browse mode
		if (matchesKey(data, "tab") || data === "]") {
			this.#tabBar.nextTab();
			this.#statusBanner = undefined;
			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, "shift+tab") || data === "[") {
			this.#tabBar.prevTab();
			this.#statusBanner = undefined;
			this.#tui.requestRender();
			return;
		}

		const activeTab = this.#tabBar.getActiveTab()?.id ?? "council";

		if (activeTab === "models") {
			if (matchesKey(data, "up") || data === "k") {
				this.#modelCursor = Math.max(0, this.#modelCursor - 1);
				this.#tui.requestRender();
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				this.#modelCursor = Math.min(this.#session.availableReviewers.length - 1, this.#modelCursor + 1);
				this.#tui.requestRender();
				return;
			}
			if (data === " ") {
				if (!this.#session.isBusy()) {
					const target = this.#session.availableReviewers[this.#modelCursor];
					if (target) {
						const currentKeys = this.#session.activeReviewers.map(r => r.key);
						const nextKeys = currentKeys.includes(target.key)
							? currentKeys.filter(k => k !== target.key)
							: [...currentKeys, target.key];
						this.#session.setReviewers(nextKeys);
						this.#tui.requestRender();
					}
				}
				return;
			}
			if (matchesKey(data, "enter") || data === "r") {
				this.#tabBar.selectTab("council");
				void this.#session.startInitialCritiques();
				this.#tui.requestRender();
				return;
			}
		} else {
			// Scroll keys
			if (data === "k") {
				this.#scrollView.scroll(-1);
				this.#tui.requestRender();
				return;
			}
			if (data === "j") {
				this.#scrollView.scroll(1);
				this.#tui.requestRender();
				return;
			}
			if (data === "g") {
				this.#scrollView.scrollToTop();
				this.#tui.requestRender();
				return;
			}
			if (data === "G") {
				this.#scrollView.scrollToBottom();
				this.#tui.requestRender();
				return;
			}
			if (this.#scrollView.handleScrollKey(data)) {
				this.#tui.requestRender();
				return;
			}
		}

		if (data === " " || matchesKey(data, "enter")) {
			void this.#runAutoPipeline(false);
			return;
		}

		// Mode switch to compose
		if (data === "i" || data === "c") {
			this.#mode = "compose";
			this.#input.focused = true;
			this.#statusBanner = undefined;
			this.#tui.requestRender();
			return;
		}

		// Action keys
		if (data === "r") {
			void this.#session
				.startInitialCritiques()
				.then(() => {
					this.#statusBanner = undefined;
					this.#tui.requestRender();
				})
				.catch(err => {
					this.#statusBanner = { text: err.message, isError: true };
					this.#tui.requestRender();
				});
			return;
		}

		if (data === "d") {
			void this.#session
				.runDebateRound()
				.then(() => {
					this.#statusBanner = undefined;
					this.#tui.requestRender();
				})
				.catch(err => {
					this.#statusBanner = { text: err.message, isError: true };
					this.#tui.requestRender();
				});
			return;
		}

		if (data === "m") {
			this.#tabBar.selectTab("models");
			this.#statusBanner = undefined;
			this.#tui.requestRender();
			return;
		}

		if (data === "s") {
			this.#tabBar.selectTab("synthesis");
			void this.#session
				.synthesizeFeedback(this.#synthesizerModel, this.#synthesizerThinkingLevel)
				.then(() => {
					this.#statusBanner = undefined;
					this.#tui.requestRender();
				})
				.catch(err => {
					this.#statusBanner = { text: err.message, isError: true };
					this.#tui.requestRender();
				});
			return;
		}

		if (data === "f") {
			void this.#refineWithSynthesis();
			return;
		}

		if (data === "a") {
			const approveOption = this.#reviewOptions.find(
				opt => !opt.disabled && (opt.id === "execute" || opt.id === "compact" || opt.id === "keep"),
			);
			if (approveOption) {
				this.#session.abortActiveRound();
				this.#done({ action: "approve", choice: approveOption.id as "execute" | "compact" | "keep" });
			} else {
				this.#statusBanner = { text: "No approval option is enabled for this review.", isError: true };
				this.#tui.requestRender();
			}
			return;
		}

		if (data === "x") {
			if (this.#session.isBusy()) {
				this.#session.abortActiveRound();
				this.#statusBanner = { text: "Stopped active model streams.", isError: false };
				this.#tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.#session.abortActiveRound();
			this.#done({ action: "close" });
		}
	}

	/** apply synthesis using the configured thinking level when a request is needed */
	async #refineWithSynthesis(): Promise<void> {
		if (this.#session.latestSynthesis?.status === "done" && this.#session.latestSynthesis.text.trim()) {
			this.#done({ action: "refine", feedback: this.#session.latestSynthesis.text.trim() });
			return;
		}

		if (!this.#session.isBusy()) {
			this.#tabBar.selectTab("synthesis");
			this.#tui.requestRender();
			try {
				const synth = await this.#session.synthesizeFeedback(this.#synthesizerModel, this.#synthesizerThinkingLevel);
				if (synth.status === "done" && synth.text.trim()) {
					this.#done({ action: "refine", feedback: synth.text.trim() });
				}
			} catch (err) {
				this.#statusBanner = {
					text: err instanceof Error ? err.message : String(err),
					isError: true,
				};
				this.#tui.requestRender();
			}
		}
	}

	/** retain the synthesizer thinking setting through automatic review and refinement */
	async #runAutoPipeline(autoApplyRefine: boolean): Promise<void> {
		if (this.#session.isBusy()) return;
		this.#autoStage = "Starting...";
		this.#statusBanner = undefined;
		this.#tui.requestRender();

		try {
			const synth = await this.#session.runAutoPipeline(this.#synthesizerModel, {
				autoDebate: this.#autoDebate,
				synthesizerThinkingLevel: this.#synthesizerThinkingLevel,
				onStageChange: stage => {
					this.#autoStage = stage;
					this.#tui.requestRender();
				},
			});

			this.#autoStage = undefined;
			this.#tabBar.selectTab("synthesis");
			this.#tui.requestRender();

			if (autoApplyRefine && synth.status === "done" && synth.text.trim()) {
				this.#done({ action: "refine", feedback: synth.text.trim() });
			} else {
				this.#statusBanner = {
					text: "Council complete! Press f to apply revisions to plan, or a to approve.",
					isError: false,
				};
				this.#tui.requestRender();
			}
		} catch (err) {
			this.#autoStage = undefined;
			this.#statusBanner = {
				text: err instanceof Error ? err.message : String(err),
				isError: true,
			};
			this.#tui.requestRender();
		}
	}
}
