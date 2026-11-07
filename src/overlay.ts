import type { Model } from "@oh-my-pi/pi-ai";
import type { PlanReviewOption, PlanReviewTier } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { Component, Focusable, Tab, TabBarTheme, TUI } from "@oh-my-pi/pi-tui";
import {
	Input,
	Markdown,
	matchesKey,
	parseSgrMouse,
	replaceTabs,
	ScrollView,
	SplitPane,
	TabBar,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { CouncilSession, isReviewerTurnEntry, READER_TARGET_KEY, type ReviewerTurnEntry } from "./council-session";
import { openDisagreementCount, type ReviewerPosition } from "./position";

export type ApprovalChoice = "execute" | "compact" | "keep";

export type CouncilOverlayOutcome =
	| { action: "close" }
	| { action: "refine"; feedback: string }
	| {
			action: "approve";
			choice: ApprovalChoice;
			/** execution tier role; present only when the review offers two or more tiers */
			role?: string;
	  };

export interface PlanCouncilOverlayOptions {
	reviewOptions: PlanReviewOption[];
	/** execution tiers from `plan_review_requested`, in slider order */
	reviewTiers?: PlanReviewTier[];
	synthesizerModel: Model | undefined;
	synthesizerThinkingLevel?: ConfiguredThinkingLevel;
	warnings?: string[];
	autoProceed?: boolean;
	autoDebate?: boolean;
	maxDebateRounds?: number;
}

const SYNTHESIS_READY_BANNER = "Synthesis ready — press f to refine plan, or a to approve.";

interface StatusBanner {
	text: string;
	isError: boolean;
}

/** compact model id for narrow tab bars: drops a dated snapshot suffix and caps the length */
function shortModelId(id: string): string {
	const base = id.replace(/-\d{6,8}$/, "");
	return base.length > 14 ? `${base.slice(0, 13)}…` : base;
}

function formatVerdictGlyph(verdict: ReviewerPosition["verdict"]): string {
	switch (verdict) {
		case "APPROVE":
			return theme.fg("success", "✓");
		case "NEEDS REVISION":
			return theme.fg("warning", "△");
		case "BLOCK":
			return theme.fg("error", "✗");
	}
}

function formatVerdictBadge(verdict: ReviewerPosition["verdict"]): string {
	switch (verdict) {
		case "APPROVE":
			return theme.fg("success", "✓ APPROVE");
		case "NEEDS REVISION":
			return theme.fg("warning", "△ NEEDS REVISION");
		case "BLOCK":
			return theme.fg("error", "✗ BLOCK");
	}
}

/** wall time of a settled turn, e.g. `12.4s`; undefined while it is still running */
function formatElapsed(startedAt: number, finishedAt: number | undefined): string | undefined {
	if (finishedAt === undefined || finishedAt < startedAt) return undefined;
	return `${((finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

export class PlanCouncilOverlay implements Component, Focusable {
	#tui: TUI;
	#session: CouncilSession;
	#reviewOptions: PlanReviewOption[];
	#reviewTiers: PlanReviewTier[];
	#approveChoiceIndex = 0;
	#approveTierIndex = 0;
	#synthesizerModel: Model | undefined;
	#synthesizerThinkingLevel: ConfiguredThinkingLevel | undefined;
	#warnings: string[];
	#done: (result: CouncilOverlayOutcome) => void;
	/** set once the overlay has reported an outcome; later async settlements must not report another */
	#resolved = false;
	/** opening the approval picker cancels the automatic refine that would otherwise close the overlay */
	#autoRefineDisarmed = false;
	/** bumped by each manual refine request and by opening the picker, superseding in-flight requests */
	#manualRefineSeq = 0;
	#autoProceed: boolean;
	#autoDebate: boolean;
	#maxDebateRounds: number;
	#autoStage?: string;
	#mode: "browse" | "compose" | "approve" = "browse";
	#tabBar: TabBar;
	#scrollView: ScrollView;
	/** side-by-side plan reference, toggled with `p` */
	#planScrollView: ScrollView;
	#splitPane: SplitPane;
	#planSplitOpen = false;
	#focusedPane: "left" | "right" = "left";
	/** whether the last render had room to show both panes */
	#lastShowingSplit = false;
	#input: Input;
	#modelCursor = 0;
	#statusBanner?: StatusBanner;
	#scorecardExpanded = true;

	#planMarkdown: Markdown;
	#markdownCache = new Map<string, { text: string; md: Markdown }>();
	#unsubscribeSession: () => void;

	/** body scroll offset each tab had when it was last left */
	#tabScrollOffsets = new Map<string, number>();
	#lastActiveTabId = "council";
	/** the operator scrolled up during the current run; cleared when a new run starts or they return to the tail */
	#tailPausedByUser = false;
	/** session activity at the last change notification, to detect the start of a new run */
	#wasActive: boolean;
	#snapToTailOnNextRender: boolean;

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
		this.#reviewTiers = options.reviewTiers ?? [];
		// preselect the default tier, as the host's own plan review slider does
		if (this.#reviewTiers.length >= 2) {
			this.#approveTierIndex = Math.max(
				0,
				this.#reviewTiers.findIndex(t => t.role === "default"),
			);
		}
		this.#synthesizerModel = options.synthesizerModel;
		this.#synthesizerThinkingLevel = options.synthesizerThinkingLevel;
		this.#warnings = options.warnings ?? [];
		this.#autoProceed = options.autoProceed ?? false;
		this.#autoDebate = options.autoDebate ?? true;
		this.#maxDebateRounds = options.maxDebateRounds ?? 3;
		this.#done = done;

		// getMarkdownTheme also ensures the active theme exists before the verdict tab icons below color with it
		this.#planMarkdown = new Markdown(session.planContent, 1, 0, getMarkdownTheme());

		const tabBarTheme: TabBarTheme = {
			label: text => theme.bold(theme.fg("accent", text)),
			activeTab: text => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
			inactiveTab: text => theme.fg("muted", text),
			hint: text => theme.fg("muted", text),
		};

		this.#tabBar = new TabBar("", this.#buildTabs(), tabBarTheme);
		this.#tabBar.showHint = false;

		const scrollTheme = {
			track: (t: string) => theme.fg("muted", t),
			thumb: (t: string) => theme.fg("accent", t),
		};
		this.#scrollView = new ScrollView([], { height: 10, scrollbar: "auto", theme: scrollTheme });
		this.#planScrollView = new ScrollView([], { height: 10, scrollbar: "auto", theme: scrollTheme });
		this.#splitPane = new SplitPane({
			left: this.#scrollView,
			right: this.#planScrollView,
			splitAt: 120,
			leftSize: { ratio: 0.56, min: 56 },
			rightMinWidth: 44,
			narrowPane: "left",
			// both states are 3 columns wide, so focus switches never move the split
			divider: () => (this.#focusedPane === "right" ? theme.fg("accent", " ┃ ") : theme.fg("muted", " │ ")),
		});

		this.#input = new Input();
		this.#input.prompt = "Ask council > ";

		// critiques may start before the overlay mounts; treat an already-running round as the current run
		this.#wasActive = session.isActive();
		this.#snapToTailOnNextRender = this.#wasActive;

		this.#unsubscribeSession = this.#session.subscribe(() => {
			const active = this.#session.isActive();
			if (active && !this.#wasActive) {
				// a new round or auto run began (isActive stays true across auto-pipeline stages)
				this.#tailPausedByUser = false;
				this.#snapToTailOnNextRender = true;
			} else if (!active) {
				this.#snapToTailOnNextRender = false;
			}
			this.#wasActive = active;
			this.#syncTabs();
			this.#tui.requestRender();
		});

		if (this.#autoProceed) {
			void this.#runAutoPipeline(true);
		}
	}

	dispose(): void {
		this.#unsubscribeSession();
		// disposes both pane scroll views
		this.#splitPane.dispose();
	}

	#buildTabs(): Tab[] {
		const tabs: Tab[] = [{ id: "council", label: "Council", short: "Council" }];

		for (const r of this.#session.activeReviewers) {
			const latest = this.#latestTurn(r.key);
			let icon = "";
			if (latest?.status === "streaming") {
				icon = "⏳ ";
			} else if (latest?.status === "error") {
				// distinct from the ✗ BLOCK verdict glyph
				icon = `${theme.fg("error", "!")} `;
			} else if (latest?.status === "aborted") {
				icon = `${theme.fg("dim", "⊘")} `;
			} else if (latest?.status === "done") {
				const pos = this.#session.getLatestPosition(r.key);
				icon = `${pos ? formatVerdictGlyph(pos.verdict) : theme.fg("muted", "•")} `;
			}

			tabs.push({
				id: `reviewer:${r.key}`,
				label: `${icon}${r.model.id}`,
				short: `${icon}${shortModelId(r.model.id)}`,
			});
		}

		const readerEntries = this.#session.readerEntries;
		if (this.#session.hasCodeReader || readerEntries.length > 0 || this.#session.referencedFiles.length > 0) {
			const readerBusy = readerEntries.some(e => e.status === "queued" || e.status === "reading");
			tabs.push({
				id: "reader",
				label: `${readerBusy ? "⏳ " : ""}Reader${readerEntries.length > 0 ? ` (${readerEntries.length})` : ""}`,
				short: `${readerBusy ? "⏳ " : ""}Reader`,
			});
		}

		const synthReady = this.#session.latestSynthesis?.status === "done";
		tabs.push({
			id: "synthesis",
			label: `Synthesis${synthReady ? " ★" : ""}`,
			short: `Synth${synthReady ? "★" : ""}`,
		});

		tabs.push({
			id: "plan",
			label: "Plan",
			short: "Plan",
		});

		tabs.push({
			id: "models",
			label: `Models (${this.#session.activeReviewers.length})`,
			short: "Models",
		});

		return tabs;
	}

	#syncTabs(): void {
		const currentActiveId = this.#tabBar.getActiveTab()?.id;
		this.#tabBar.setTabs(this.#buildTabs(), currentActiveId);
	}

	#getEntryMarkdown(id: string, text: string): Markdown {
		const cached = this.#markdownCache.get(id);
		if (cached) {
			// setText keeps the incremental prefix caches across append-only streaming deltas
			if (cached.text !== text) {
				cached.md.setText(text);
				cached.text = text;
			}
			return cached.md;
		}
		const md = new Markdown(text, 1, 0, getMarkdownTheme());
		this.#markdownCache.set(id, { text, md });
		return md;
	}

	#latestTurn(reviewerKey: string): ReviewerTurnEntry | undefined {
		const entries = this.#session.entries;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (isReviewerTurnEntry(e) && e.reviewerKey === reviewerKey) return e;
		}
		return undefined;
	}

	/**
	 * reviewer turn header: status badge (naming reader waits), the reported verdict once done,
	 * and once settled how many codebase checks it made and how long it took
	 */
	#formatReviewerHeader(entry: ReviewerTurnEntry): string {
		let badge = "";
		if (entry.status === "streaming") {
			if (entry.readerStatus === "queued") badge = theme.fg("warning", " ⏳ queued for reader...");
			else if (entry.readerStatus === "reading") badge = theme.fg("warning", " ⏳ asking reader...");
			else badge = theme.fg("warning", " ⏳ streaming...");
		} else if (entry.status === "error") badge = theme.fg("error", " ✗ error");
		else if (entry.status === "aborted") badge = theme.fg("dim", " ⊘ aborted");
		else if (entry.position) badge = ` ${formatVerdictBadge(entry.position.verdict)}`;
		// an operator reply may leave the report out and keep the previous position
		else if (entry.kind !== "reply") badge = theme.fg("warning", " · no verdict reported");

		const checks = entry.readerQueryCount ?? 0;
		if (checks > 0 && !entry.readerStatus) {
			badge += theme.fg("muted", ` · ${checks} codebase ${checks === 1 ? "check" : "checks"}`);
		}
		const elapsed = entry.readerStatus ? undefined : formatElapsed(entry.startedAt, entry.finishedAt);
		if (elapsed) badge += theme.fg("muted", ` · ${elapsed}`);
		return theme.bold(theme.fg("accent", `[${entry.reviewerLabel} · Round ${entry.round} ${entry.kind}]`)) + badge;
	}

	/** verdicts, required revisions, disputes, and pending cross-examination at a glance */
	#renderScorecard(contentWidth: number): string[] {
		const positions = this.#session.getReviewerPositions();
		const convergence = this.#session.getConvergence();
		const revisionCount = convergence.items.length;
		const revisionWord = revisionCount === 1 ? "revision" : "revisions";
		let statusSummary: string;
		if (this.#session.isBusy()) statusSummary = theme.fg("warning", "round in progress");
		else if (convergence.converged) statusSummary = theme.fg("success", `converged · ${revisionCount} required ${revisionWord}`);
		else statusSummary = theme.fg("warning", `${openDisagreementCount(convergence)} open · ${revisionCount} ${revisionWord}`);

		if (!this.#scorecardExpanded) {
			return [
				truncateToWidth(
					`  ${theme.bold(theme.fg("accent", "▸ Consensus Scorecard"))} · ${statusSummary} ${theme.fg("muted", "(o to expand)")}`,
					contentWidth,
				),
				"",
			];
		}

		const lines = [
			truncateToWidth(
				`  ${theme.bold(theme.fg("accent", "▾ Consensus Scorecard"))} · ${statusSummary} ${theme.fg("muted", "(o to collapse)")}`,
				contentWidth,
			),
		];
		// item IDs are `provider/model#n`; the model id alone is enough to tell reviewers apart here
		const shortIdByFullId = new Map<string, string>();
		for (const { reviewer, position } of positions) {
			for (const item of position?.revisions ?? []) {
				shortIdByFullId.set(item.id, `${reviewer.model.id}${item.id.slice(item.id.lastIndexOf("#"))}`);
			}
		}

		for (const { reviewer, position } of positions) {
			const label = replaceTabs(reviewer.label);
			if (!position) {
				const status = this.#latestTurn(reviewer.key)?.status;
				let stateText: string;
				if (status === "streaming") stateText = theme.fg("warning", "⏳ streaming...");
				else if (status === "error") stateText = theme.fg("error", "! error");
				else stateText = theme.fg("muted", "no position reported");
				lines.push(truncateToWidth(`    ${theme.fg("muted", "•")} ${label}: ${stateText}`, contentWidth));
				continue;
			}
			const count = position.revisions.length;
			const countText =
				count === 0 ? "no required revisions" : `${count} required ${count === 1 ? "revision" : "revisions"}`;
			lines.push(
				truncateToWidth(
					`    ${formatVerdictBadge(position.verdict)} · ${label} ${theme.fg("muted", `(${countText})`)}`,
					contentWidth,
				),
			);
			for (const item of position.revisions) {
				const shortId = shortIdByFullId.get(item.id) ?? item.id;
				lines.push(truncateToWidth(`      • ${theme.fg("accent", shortId)}: ${replaceTabs(item.summary)}`, contentWidth));
			}
		}

		for (const d of convergence.disputes) {
			const id = shortIdByFullId.get(d.id) ?? d.id.replace(/^[^/]+\//, "");
			const reason = d.reason ? `: ${replaceTabs(d.reason)}` : "";
			lines.push(
				truncateToWidth(
					`    ${theme.fg("error", "⚡ Dispute")} on ${theme.fg("accent", id)} by ${replaceTabs(d.by)}${reason}`,
					contentWidth,
				),
			);
		}

		if (convergence.uncovered.length > 0) {
			// one aggregate row: after Round 1 every reviewer lacks a stance on every peer item
			const pendingCount = new Set(convergence.uncovered.map(u => u.id)).size;
			lines.push(
				truncateToWidth(
					theme.fg(
						"muted",
						`    • ${pendingCount} ${pendingCount === 1 ? "revision awaits" : "revisions await"} peer cross-examination (press d to debate)`,
					),
					contentWidth,
				),
			);
		}

		lines.push(theme.fg("muted", `  ${"─".repeat(Math.max(4, contentWidth - 2))}`), "");
		return lines;
	}

	#renderWarnings(contentWidth: number): string[] {
		if (this.#warnings.length === 0) return [];
		return ["", ...this.#warnings.map(w => truncateToWidth(theme.fg("warning", `  ⚠ ${replaceTabs(w)}`), contentWidth))];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const totalHeight = Math.max(12, this.#tui.terminal?.rows || process.stdout.rows || 30);

		this.#syncTabs();
		// Row 2+: TabBar; it collapses distant tabs to their short labels first, then wraps as a last resort
		const tabLines = this.#tabBar.render(safeWidth);
		const headerRows = 2 + tabLines.length;
		const footerRows = 3;
		const bodyHeight = Math.max(4, totalHeight - headerRows - footerRows);
		const activeTab = this.#tabBar.getActiveTab()?.id ?? "council";

		// measure before building the main pane so its markdown wraps to the pane instead of being truncated
		const splitActive = this.#planSplitOpen && activeTab !== "plan";
		const geometry = splitActive ? this.#splitPane.measure(safeWidth) : undefined;
		const showingSplit = geometry?.mode === "split";
		this.#lastShowingSplit = showingSplit;
		const leftWidth = showingSplit ? (geometry.left?.width ?? safeWidth) : safeWidth;
		const contentWidth = Math.max(10, leftWidth - 4);

		// Row 1: Title bar
		const hasDoneReviewer = this.#session.entries.some(e => isReviewerTurnEntry(e) && e.status === "done");
		let roundBadge = "";
		if (this.#session.round > 0) {
			roundBadge = theme.fg("accent", ` [Round ${this.#session.round}${this.#session.isBusy() ? " ⏳" : ""}]`);
			if (!this.#session.isBusy() && hasDoneReviewer) {
				const convergence = this.#session.getConvergence();
				roundBadge += convergence.converged
					? theme.fg("success", " · converged")
					: theme.fg("warning", ` · ${openDisagreementCount(convergence)} open`);
			}
		}
		const warnBadge =
			this.#warnings.length > 0
				? theme.fg("warning", ` (${this.#warnings.length} warning${this.#warnings.length === 1 ? "" : "s"})`)
				: "";
		const autoBadge = this.#autoStage ? theme.fg("accent", ` [Auto: ${this.#autoStage}]`) : "";
		let splitBadge = "";
		if (showingSplit) {
			splitBadge = theme.fg("accent", ` [Split · ${this.#focusedPane === "right" ? "Plan" : "Main"}]`);
		} else if (splitActive) {
			splitBadge = theme.fg("muted", " [Split: narrow]");
		}
		const rawTitle = `Plan Council · ${this.#session.planTitle}${roundBadge}${autoBadge}${splitBadge}${warnBadge}`;
		const titleLine = truncateToWidth(replaceTabs(rawTitle), safeWidth);

		// Header divider
		const topDivider = theme.fg("muted", "─".repeat(safeWidth));

		// Middle Body
		const lines: string[] = [];

		if (activeTab === "council") {
			if (this.#session.entries.length === 0) {
				lines.push(
					"",
					theme.fg("muted", "  No council critiques yet."),
					...this.#renderWarnings(contentWidth),
					"",
					theme.fg("accent", "  Getting started:"),
					`  • Press ${theme.bold("r")} to run Round 1 critiques across active models`,
					`  • Press ${theme.bold("m")} to view and select reviewer models`,
					`  • Press ${theme.bold("i")} to ask a question or guide the council`,
					"",
				);
			} else {
				if (hasDoneReviewer) lines.push(...this.#renderScorecard(contentWidth));
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
						const elapsed = formatElapsed(entry.startedAt, entry.finishedAt);
						if (elapsed) badge += theme.fg("muted", ` · ${elapsed}`);
						lines.push(theme.bold(theme.fg("accent", `[Synthesis · ${entry.modelLabel}]`)) + badge);
						if (entry.text) {
							const md = this.#getEntryMarkdown(entry.id, entry.text);
							lines.push(...md.render(contentWidth));
						}
						lines.push("");
					} else {
						lines.push(this.#formatReviewerHeader(entry));
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
						lines.push(this.#formatReviewerHeader(entry));
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
		} else if (activeTab === "reader") {
			const readerEntries = this.#session.readerEntries;
			const attached = this.#session.referencedFiles;
			if (attached.length > 0) {
				lines.push(
					"",
					theme.fg("accent", `  Pre-attached to Round 1 (${attached.length} ${attached.length === 1 ? "file" : "files"}):`),
					...attached.map(f =>
						truncateToWidth(replaceTabs(`  • ${f.path} ${theme.fg("muted", `(${f.rangeLabel})`)}`), contentWidth),
					),
					...(readerEntries.length > 0 ? [""] : []),
				);
			}
			if (readerEntries.length === 0 && !this.#session.hasCodeReader) {
				lines.push("", theme.fg("muted", "  On-demand codebase reader is disabled (enableCodeReader: false)."), "");
			} else if (readerEntries.length === 0) {
				const modelLabel = this.#session.readerModelLabel;
				lines.push(
					"",
					theme.fg("muted", `  No codebase reader queries yet.${modelLabel ? ` Reader model: ${modelLabel}` : ""}`),
					"",
					"  • Reviewers check files, symbols, and callers through the reader automatically while they review",
					`  • Press ${theme.bold("i")} here, or type ${theme.bold("@reader <question>")} on any tab, to ask it directly`,
					"",
				);
			} else {
				for (const entry of readerEntries) {
					let status: string;
					if (entry.status === "queued") status = theme.fg("muted", " ⏳ queued...");
					else if (entry.status === "reading") {
						status = theme.fg("warning", entry.activeTool ? ` ⏳ ${entry.activeTool}...` : " ⏳ reading codebase...");
					} else if (entry.status === "done") status = entry.cached ? theme.fg("muted", " · cached") : "";
					else if (entry.status === "error") status = theme.fg("error", " ✗ error");
					else status = theme.fg("dim", " ⊘ aborted");
					const elapsed = formatElapsed(entry.startedAt, entry.finishedAt);
					if (elapsed) status += theme.fg("muted", ` · ${elapsed}`);
					const round = entry.round > 0 ? ` · Round ${entry.round}` : "";
					lines.push(theme.bold(theme.fg("accent", replaceTabs(`[${entry.requesterLabel} → Reader${round}]`))) + status);
					entry.question.split("\n").forEach((l, i) => {
						lines.push(`${i === 0 ? "  Q: " : "     "}${replaceTabs(l)}`);
					});
					if (entry.paths && entry.paths.length > 0) {
						lines.push(theme.fg("muted", `  Paths: ${replaceTabs(entry.paths.join(", "))}`));
					}
					if (entry.status === "error" && entry.errorMessage) {
						lines.push(theme.fg("error", `  Error: ${replaceTabs(entry.errorMessage)}`));
					}
					if (entry.answer) {
						lines.push(...this.#getEntryMarkdown(`reader:${entry.id}`, entry.answer).render(contentWidth));
					}
					lines.push("");
				}
			}
		} else if (activeTab === "synthesis") {
			const latestSynth = this.#session.latestSynthesis;
			if (latestSynth) {
				let badge = "";
				if (latestSynth.status === "streaming") badge = theme.fg("warning", " ⏳ synthesizing...");
				else if (latestSynth.status === "error") badge = theme.fg("error", " ✗ error");
				const elapsed = formatElapsed(latestSynth.startedAt, latestSynth.finishedAt);
				if (elapsed) badge += theme.fg("muted", ` · ${elapsed}`);
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
				const meta = `[family: ${m.family}${m.thinkingLevel ? ` · thinking: ${m.thinkingLevel}` : ""}]`;
				lines.push(`${cursor}${box} ${m.label} ${theme.fg("muted", meta)}`);
			}
			const synth = this.#synthesizerModel;
			const synthLabel = synth
				? `${synth.id} (${synth.provider})${this.#synthesizerThinkingLevel ? ` · thinking: ${this.#synthesizerThinkingLevel}` : ""}`
				: "none";
			const readerLabel = this.#session.hasCodeReader ? (this.#session.readerModelLabel ?? "enabled") : "disabled";
			lines.push(
				"",
				truncateToWidth(theme.fg("muted", `  Synthesizer: ${replaceTabs(synthLabel)}`), contentWidth),
				truncateToWidth(theme.fg("muted", `  Codebase reader: ${replaceTabs(readerLabel)}`), contentWidth),
				...this.#renderWarnings(contentWidth),
			);
		}

		const isStreamingTab =
			this.#session.isActive() &&
			(activeTab === "council" ||
				activeTab.startsWith("reviewer:") ||
				activeTab === "reader" ||
				activeTab === "synthesis");
		const followTail = isStreamingTab && !this.#tailPausedByUser;
		const tabChanged = activeTab !== this.#lastActiveTabId;
		if (tabChanged) {
			this.#tabScrollOffsets.set(this.#lastActiveTabId, this.#scrollView.getScrollOffset());
			this.#lastActiveTabId = activeTab;
		}

		// follow-tail must be set before the new rows arrive: setLines only keeps a tail-pinned view pinned
		this.#scrollView.setHeight(bodyHeight);
		this.#scrollView.setFollowTail(followTail);
		this.#scrollView.setLines(lines);
		if (tabChanged) {
			if (followTail) this.#scrollView.scrollToBottom();
			else this.#scrollView.setScrollOffset(this.#tabScrollOffsets.get(activeTab) ?? 0);
		} else if (this.#snapToTailOnNextRender && followTail) {
			this.#scrollView.scrollToBottom();
			this.#snapToTailOnNextRender = false;
		}

		let bodyLines: readonly string[];
		if (showingSplit) {
			const rightWidth = geometry.right?.width ?? 44;
			const heading =
				this.#focusedPane === "right"
					? theme.bold(theme.fg("accent", "▸ Plan Reference"))
					: theme.fg("muted", "  Plan Reference");
			const planLines = [
				truncateToWidth(
					`${heading} ${theme.fg("muted", `(${replaceTabs(this.#session.planFilePath)})`)}`,
					Math.max(10, rightWidth - 2),
				),
				theme.fg("muted", "─".repeat(Math.max(4, rightWidth - 2))),
				...this.#planMarkdown.render(Math.max(10, rightWidth - 4)),
			];
			this.#planScrollView.setHeight(bodyHeight);
			this.#planScrollView.setLines(planLines);
			this.#splitPane.setHeight(bodyHeight);
			bodyLines = this.#splitPane.render(safeWidth);
		} else {
			bodyLines = this.#scrollView.render(safeWidth);
		}

		// Bottom chrome
		// Footer Row 1: Divider + transient status banner
		let statusLine: string;
		if (this.#statusBanner) {
			const color = this.#statusBanner.isError ? "error" : "accent";
			statusLine = theme.fg(color, replaceTabs(truncateToWidth(this.#statusBanner.text, safeWidth)));
		} else {
			statusLine = theme.fg(this.#mode === "approve" ? "accent" : "muted", "─".repeat(safeWidth));
		}

		// Footer Row 2: Input composer, or the approval picker
		let inputLine: string;
		if (this.#mode === "approve") {
			inputLine = this.#renderApproveBar(safeWidth);
		} else {
			if (activeTab.startsWith("reviewer:")) {
				const reviewerKey = activeTab.slice("reviewer:".length);
				const reviewer = this.#session.availableReviewers.find(r => r.key === reviewerKey);
				this.#input.prompt = `Reply @${reviewer?.model.id ?? "model"} > `;
			} else if (activeTab === "reader" && this.#session.hasCodeReader) {
				this.#input.prompt = "Ask @reader > ";
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
			inputLine = this.#input.render(safeWidth)[0] ?? "";
		}

		// Footer Row 3: Key hints
		let hints: string;
		if (this.#mode === "approve") {
			hints =
				this.#reviewTiers.length >= 2
					? "←/→ select approval · Tab/t execution tier · Enter confirm · Esc cancel"
					: "←/→ select approval · Enter confirm · Esc cancel";
		} else if (this.#mode === "compose") {
			hints = "Enter submit question · Esc back to browse mode";
		} else if (activeTab === "models") {
			hints = "Tab tabs · ↑↓/jk select model · Space toggle · Enter start critiques · Esc close";
		} else {
			const parts = ["Space Auto-run", "r critique", "d debate", "i ask", "s synth", "f refine", "a approve", "x stop"];
			if (activeTab === "council" && hasDoneReviewer) parts.push("o scorecard");
			parts.push("p split plan");
			if (showingSplit) parts.push("←/→ pane");
			parts.push("Esc close");
			hints = parts.join(" · ");
		}
		const hintLine = truncateToWidth(theme.fg("muted", hints), safeWidth);

		return [titleLine, ...tabLines, topDivider, ...bodyLines, statusLine, inputLine, hintLine];
	}

	/** `Approve:` followed by the enabled approval choices and, with two or more tiers, the execution tier */
	#renderApproveBar(width: number): string {
		const choices = this.#enabledApprovalOptions();
		const selected = Math.min(this.#approveChoiceIndex, choices.length - 1);
		const selectedLabel = theme.bold(
			theme.bg("selectedBg", theme.fg("text", ` ${replaceTabs(choices[selected]?.label ?? "")} `)),
		);
		const options = choices
			.map((opt, i) => (i === selected ? selectedLabel : theme.fg("muted", ` ${replaceTabs(opt.label)} `)))
			.join(" ");
		const heading = theme.bold(theme.fg("accent", "Approve:"));
		let tierSegment = "";
		const tier = this.#reviewTiers.length >= 2 ? this.#reviewTiers[this.#approveTierIndex] : undefined;
		if (tier) {
			const model = `${tier.model}${tier.thinkingLevel ? `:${tier.thinkingLevel}` : ""}`;
			tierSegment = `  ${theme.fg("muted", "│")} ${theme.fg("accent", "Tier:")} ◂ ${theme.bold(replaceTabs(tier.role))} ${theme.fg("muted", `(${replaceTabs(model)})`)} ▸`;
		}
		const bar = `${heading} ${options}${tierSegment}`;
		if (visibleWidth(bar) <= width) return bar;
		// host labels are long ("Approve and compact context"); keep what Enter would confirm visible
		const compact = `${heading} ◂${selectedLabel}▸ ${theme.fg("muted", `${selected + 1}/${choices.length}`)}${tierSegment}`;
		return truncateToWidth(compact, width);
	}

	/** approval choices the host review currently allows, in its display order */
	#enabledApprovalOptions(): Array<PlanReviewOption & { id: ApprovalChoice }> {
		return this.#reviewOptions.filter(
			(opt): opt is PlanReviewOption & { id: ApprovalChoice } =>
				!opt.disabled && (opt.id === "execute" || opt.id === "compact" || opt.id === "keep"),
		);
	}

	/** vim-style and navigation-key scrolling for one pane; true when the key was a scroll key */
	#applyScrollInput(target: ScrollView, data: string): boolean {
		const prevOffset = target.getScrollOffset();
		if (data === "k") target.scroll(-1);
		else if (data === "j") target.scroll(1);
		else if (data === "g") target.scrollToTop();
		else if (data === "G") target.scrollToBottom();
		else if (!target.handleScrollKey(data)) return false;
		this.#updateTailPause(target, prevOffset, data);
		return true;
	}

	/** scrolling up during a run pauses tail-follow until the operator returns to the bottom */
	#updateTailPause(target: ScrollView, prevOffset: number, data: string): void {
		if (target !== this.#scrollView) return;
		const nextOffset = target.getScrollOffset();
		const maxOffset = target.getMaxScrollOffset();
		if (data === "G" || matchesKey(data, "end") || (maxOffset > 0 && nextOffset >= maxOffset)) {
			this.#tailPausedByUser = false;
		} else if (this.#session.isActive() && (nextOffset < prevOffset || data === "g" || matchesKey(data, "home"))) {
			this.#tailPausedByUser = true;
		}
	}

	/** dispatch council controls with the configured synthesizer model and thinking level */
	handleInput(data: string): void {
		// SGR mouse scroll support
		if (data.startsWith("\x1b[<")) {
			const m = parseSgrMouse(data);
			if (m?.wheel) {
				const target = this.#lastShowingSplit && this.#focusedPane === "right" ? this.#planScrollView : this.#scrollView;
				const prevOffset = target.getScrollOffset();
				target.scroll(m.wheel * 3);
				this.#updateTailPause(target, prevOffset, data);
				this.#tui.requestRender();
			}
			return;
		}

		if (this.#mode === "approve") {
			this.#handleApproveInput(data);
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
				} else if (activeTab === "reader" && this.#session.hasCodeReader) {
					defaultTargetKey = READER_TARGET_KEY;
				}
				// watch the reader stream its answer live
				if (this.#session.hasCodeReader && /^@(reader|scout)\b/i.test(text)) {
					this.#tabBar.selectTab("reader");
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

		if (this.#lastShowingSplit && activeTab !== "models") {
			let nextPane: "left" | "right" | undefined;
			if (matchesKey(data, "left") || data === "h") nextPane = "left";
			else if (matchesKey(data, "right") || data === "l") nextPane = "right";
			else if (data === "w") nextPane = this.#focusedPane === "left" ? "right" : "left";
			if (nextPane) {
				this.#focusedPane = nextPane;
				this.#tui.requestRender();
				return;
			}
		}

		if (activeTab === "models") {
			if (matchesKey(data, "up") || data === "k") {
				this.#modelCursor = Math.max(0, this.#modelCursor - 1);
				this.#tui.requestRender();
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				this.#modelCursor = Math.max(
					0,
					Math.min(this.#session.availableReviewers.length - 1, this.#modelCursor + 1),
				);
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
		} else if (
			this.#applyScrollInput(
				this.#lastShowingSplit && this.#focusedPane === "right" ? this.#planScrollView : this.#scrollView,
				data,
			)
		) {
			this.#tui.requestRender();
			return;
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
					const round = this.#session.round;
					const convergence = this.#session.getConvergence();
					this.#statusBanner = {
						text: convergence.converged
							? `Converged after round ${round}.`
							: `${openDisagreementCount(convergence)} open disagreement(s) after round ${round}; press d to debate again.`,
						isError: false,
					};
					this.#tui.requestRender();
				})
				.catch(err => {
					this.#statusBanner = { text: err.message, isError: true };
					this.#tui.requestRender();
				});
			return;
		}

		if (data === "p") {
			this.#planSplitOpen = !this.#planSplitOpen;
			if (this.#planSplitOpen) {
				// the plan already fills the Plan tab; pair it with the council discussion instead
				if (activeTab === "plan") this.#tabBar.selectTab("council");
			} else {
				this.#focusedPane = "left";
			}
			this.#tui.requestRender();
			return;
		}

		if (data === "o") {
			this.#scorecardExpanded = !this.#scorecardExpanded;
			this.#tui.requestRender();
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
			const choices = this.#enabledApprovalOptions();
			if (choices.length === 0) {
				this.#statusBanner = { text: "No approval option is enabled for this review.", isError: true };
				this.#tui.requestRender();
				return;
			}
			// the operator is deciding: neither an auto run nor an in-flight `f` may close the overlay under them
			this.#autoRefineDisarmed = true;
			++this.#manualRefineSeq;
			this.#approveChoiceIndex = Math.min(this.#approveChoiceIndex, choices.length - 1);
			this.#statusBanner = undefined;
			this.#mode = "approve";
			this.#tui.requestRender();
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
			this.#finish({ action: "close" });
		}
	}

	/** approval picker: choose an approval and tier, confirm, or cancel back to browsing; other keys are ignored */
	#handleApproveInput(data: string): void {
		const choices = this.#enabledApprovalOptions();
		const tiers = this.#reviewTiers.length >= 2 ? this.#reviewTiers : undefined;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.#mode = "browse";
			const synth = this.#session.latestSynthesis;
			if (synth?.status === "done" && synth.text.trim()) {
				this.#statusBanner = { text: SYNTHESIS_READY_BANNER, isError: false };
			}
			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "a") {
			const picked = choices[Math.min(this.#approveChoiceIndex, choices.length - 1)];
			if (!picked) return;
			const tier = tiers?.[this.#approveTierIndex];
			this.#mode = "browse";
			this.#session.abortActiveRound();
			this.#finish(
				tier ? { action: "approve", choice: picked.id, role: tier.role } : { action: "approve", choice: picked.id },
			);
			return;
		}

		if (matchesKey(data, "left") || data === "h") {
			this.#approveChoiceIndex = (this.#approveChoiceIndex - 1 + choices.length) % choices.length;
		} else if (matchesKey(data, "right") || data === "l") {
			this.#approveChoiceIndex = (this.#approveChoiceIndex + 1) % choices.length;
		} else if (tiers && (matchesKey(data, "tab") || matchesKey(data, "down") || data === "j" || data === "t")) {
			this.#approveTierIndex = (this.#approveTierIndex + 1) % tiers.length;
		} else if (tiers && (matchesKey(data, "shift+tab") || matchesKey(data, "up") || data === "k" || data === "T")) {
			this.#approveTierIndex = (this.#approveTierIndex - 1 + tiers.length) % tiers.length;
		} else {
			return;
		}
		this.#tui.requestRender();
	}

	/** report the outcome once; async synthesis settling after a keypress already resolved the overlay is dropped */
	#finish(outcome: CouncilOverlayOutcome): void {
		if (this.#resolved) return;
		this.#resolved = true;
		this.#done(outcome);
	}

	/** apply synthesis using the configured thinking level when a request is needed */
	async #refineWithSynthesis(): Promise<void> {
		const cached = this.#session.latestSynthesis;
		if (cached?.status === "done" && cached.text.trim()) {
			this.#finish({ action: "refine", feedback: cached.text.trim() });
			return;
		}

		if (!this.#session.isBusy()) {
			const seq = ++this.#manualRefineSeq;
			this.#tabBar.selectTab("synthesis");
			this.#tui.requestRender();
			try {
				const synth = await this.#session.synthesizeFeedback(this.#synthesizerModel, this.#synthesizerThinkingLevel);
				if (this.#resolved) return;
				const ready = synth.status === "done" && synth.text.trim() !== "";
				if (seq !== this.#manualRefineSeq || this.#mode === "approve") {
					// the picker superseded this request: keep the synthesis, but leave the decision to the operator
					if (this.#mode !== "approve" && ready) {
						this.#statusBanner = { text: SYNTHESIS_READY_BANNER, isError: false };
						this.#tui.requestRender();
					}
					return;
				}
				if (ready) this.#finish({ action: "refine", feedback: synth.text.trim() });
			} catch (err) {
				if (this.#resolved) return;
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
				maxDebateRounds: this.#maxDebateRounds,
				synthesizerThinkingLevel: this.#synthesizerThinkingLevel,
				onStageChange: stage => {
					this.#autoStage = stage;
					this.#tui.requestRender();
				},
			});
			if (this.#resolved) return;

			this.#autoStage = undefined;
			// never pull the tab out from under an open approval picker
			if (this.#mode !== "approve") this.#tabBar.selectTab("synthesis");

			if (
				autoApplyRefine &&
				!this.#autoRefineDisarmed &&
				this.#mode !== "approve" &&
				synth.status === "done" &&
				synth.text.trim()
			) {
				this.#finish({ action: "refine", feedback: synth.text.trim() });
			} else {
				this.#statusBanner = {
					text: this.#autoRefineDisarmed
						? SYNTHESIS_READY_BANNER
						: "Council complete! Press f to apply revisions to plan, or a to approve.",
					isError: false,
				};
				this.#tui.requestRender();
			}
		} catch (err) {
			if (this.#resolved) return;
			this.#autoStage = undefined;
			this.#statusBanner = {
				text: err instanceof Error ? err.message : String(err),
				isError: true,
			};
			this.#tui.requestRender();
		}
	}
}
