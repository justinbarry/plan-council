import type { ApiKey, AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { ReviewerMember } from "./models";
import {
	renderCritiqueRound,
	renderCritiqueSystem,
	renderDebateRebuttal,
	renderSynthesizeSystem,
	renderSynthesizeUser,
	renderUserFollowup,
} from "./prompts/render";

export type EntryStatus = "streaming" | "done" | "error" | "aborted";

export type CouncilTurnEntry =
	| {
			id: string;
			kind: "critique" | "rebuttal" | "reply";
			round: number;
			reviewerKey: string;
			reviewerLabel: string;
			status: EntryStatus;
			text: string;
			errorMessage?: string;
			startedAt: number;
			finishedAt?: number;
	  }
	| {
			id: string;
			kind: "user";
			round: number;
			targetReviewerKey?: string;
			targetLabel?: string;
			text: string;
			createdAt: number;
	  }
	| {
			id: string;
			kind: "synthesis";
			round: number;
			modelLabel: string;
			status: EntryStatus;
			text: string;
			errorMessage?: string;
			startedAt: number;
			finishedAt?: number;
	  };

export type ReviewerTurnEntry = CouncilTurnEntry & { kind: "critique" | "rebuttal" | "reply" };

export function isReviewerTurnEntry(e: CouncilTurnEntry): e is ReviewerTurnEntry {
	return e.kind === "critique" || e.kind === "rebuttal" || e.kind === "reply";
}

function createUserMessage(content: string): Message {
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}

export type ModelStreamFn = (
	model: Model,
	context: Context,
	options: { signal: AbortSignal; apiKey?: ApiKey },
) => AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };

export interface CouncilSessionOptions {
	planTitle: string;
	planFilePath: string;
	planContent: string;
	sessionContext?: string;
	availableReviewers: readonly ReviewerMember[];
	initialReviewers: readonly ReviewerMember[];
	streamFn?: ModelStreamFn;
	getApiKey?: (model: Model) => ApiKey | Promise<ApiKey | undefined> | undefined;
	sessionId?: string;
}

export function extractSessionGoalContext(entries: readonly SessionEntry[], maxChars = 2000): string | undefined {
	const userPrompts: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "user") continue;

		let promptText = "";
		if (typeof msg.content === "string") {
			promptText = msg.content;
		} else if (Array.isArray(msg.content)) {
			promptText = msg.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
				.map(part => part.text)
				.join("\n");
		}

		// Strip control characters (except newline \n and tab \t)
		const cleaned = replaceTabs(promptText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")).trim();
		if (cleaned) {
			userPrompts.push(cleaned);
		}
	}

	if (userPrompts.length === 0) {
		return undefined;
	}

	const joined = userPrompts.join("\n\n---\n\n");
	if (joined.length <= maxChars) {
		return joined;
	}

	return `${joined.slice(0, maxChars)}…`;
}

export class CouncilSession {
	#planTitle: string;
	#planFilePath: string;
	#planContent: string;
	#sessionContext?: string;
	#availableReviewers: ReviewerMember[];
	#activeReviewers: ReviewerMember[];
	#entries: CouncilTurnEntry[] = [];
	#round = 0;
	#histories = new Map<string, Message[]>();
	#latestSynthesis?: CouncilTurnEntry & { kind: "synthesis" };
	#busy = false;
	#roundAbortController: AbortController | null = null;
	#listeners = new Set<() => void>();
	#streamFn: ModelStreamFn;
	#getApiKey?: (model: Model) => ApiKey | Promise<ApiKey | undefined> | undefined;
	#sessionId?: string;

	constructor(options: CouncilSessionOptions) {
		this.#planTitle = options.planTitle;
		this.#planFilePath = options.planFilePath;
		this.#planContent = options.planContent;
		this.#sessionContext = options.sessionContext;
		this.#availableReviewers = [...options.availableReviewers];
		this.#activeReviewers = [...options.initialReviewers];
		this.#getApiKey = options.getApiKey;
		this.#sessionId = options.sessionId;

		this.#streamFn =
			options.streamFn ??
			((model, context, opts) =>
				streamSimple(model, context, {
					signal: opts.signal,
					apiKey: opts.apiKey,
					sessionId: this.#sessionId,
				}));
	}

	get round(): number {
		return this.#round;
	}

	get planTitle(): string {
		return this.#planTitle;
	}

	get planFilePath(): string {
		return this.#planFilePath;
	}

	get planContent(): string {
		return this.#planContent;
	}

	get sessionContext(): string | undefined {
		return this.#sessionContext;
	}

	get availableReviewers(): readonly ReviewerMember[] {
		return this.#availableReviewers;
	}

	get activeReviewers(): readonly ReviewerMember[] {
		return this.#activeReviewers;
	}

	get entries(): readonly CouncilTurnEntry[] {
		return this.#entries;
	}

	get latestSynthesis(): (CouncilTurnEntry & { kind: "synthesis" }) | undefined {
		return this.#latestSynthesis;
	}

	isBusy(): boolean {
		return this.#busy;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emitChange(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}

	setReviewers(keys: readonly string[]): void {
		if (this.#busy) {
			throw new Error("Cannot modify reviewers while council is busy.");
		}
		const keySet = new Set(keys);
		this.#activeReviewers = this.#availableReviewers.filter(r => keySet.has(r.key));
		this.#emitChange();
	}

	async startInitialCritiques(): Promise<void> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}
		this.#round = Math.max(1, this.#round);

		// Find active reviewers lacking a "done" critique entry in Round 1
		const reviewersToRun = this.#activeReviewers.filter(r => {
			const hasDone = this.#entries.some(
				e => e.kind === "critique" && e.round === 1 && e.reviewerKey === r.key && e.status === "done",
			);
			return !hasDone;
		});

		if (reviewersToRun.length === 0) {
			return;
		}

		this.#busy = true;
		this.#roundAbortController = new AbortController();
		this.#emitChange();

		const systemPrompt = renderCritiqueSystem();
		const userPrompt = renderCritiqueRound({
			round: 1,
			planTitle: this.#planTitle,
			planFilePath: this.#planFilePath,
			planContent: this.#planContent,
			sessionContext: this.#sessionContext,
		});

		const tasks = reviewersToRun.map(async reviewer => {
			const entry: CouncilTurnEntry = {
				id: crypto.randomUUID(),
				kind: "critique",
				round: 1,
				reviewerKey: reviewer.key,
				reviewerLabel: reviewer.label,
				status: "streaming",
				text: "",
				startedAt: Date.now(),
			};
			this.#entries.push(entry);
			this.#emitChange();

			const timeoutSignal = AbortSignal.timeout(120_000);
			const combinedSignal = AbortSignal.any([this.#roundAbortController!.signal, timeoutSignal]);

			try {
				const apiKey = this.#getApiKey ? await this.#getApiKey(reviewer.model) : undefined;
				const context: Context = {
					systemPrompt: [systemPrompt],
					messages: [createUserMessage(userPrompt)],
				};

				const stream = this.#streamFn(reviewer.model, context, { signal: combinedSignal, apiKey });
				for await (const event of stream) {
					if (event.type === "text_delta") {
						entry.text += event.delta;
						this.#emitChange();
					}
				}

				const msg = await stream.result();
				if (combinedSignal.aborted || msg.stopReason === "aborted") {
					entry.status = "aborted";
				} else if (msg.stopReason === "error") {
					entry.status = "error";
					entry.errorMessage = msg.errorMessage || "Model request failed";
				} else {
					entry.status = "done";
					if (!entry.text && msg.content) {
						entry.text = msg.content
							.filter(c => c.type === "text")
							.map(c => c.text)
							.join("");
					}
					let history = this.#histories.get(reviewer.key);
					if (!history) {
						history = [];
						this.#histories.set(reviewer.key, history);
					}
					history.push(createUserMessage(userPrompt));
					history.push(msg);
				}
			} catch (err) {
				if (combinedSignal.aborted) {
					entry.status = "aborted";
				} else {
					entry.status = "error";
					entry.errorMessage = err instanceof Error ? err.message : String(err);
				}
			} finally {
				entry.finishedAt = Date.now();
				this.#emitChange();
			}
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#busy = false;
			this.#roundAbortController = null;
			this.#emitChange();
		}
	}

	async runDebateRound(): Promise<void> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}
		if (this.#activeReviewers.length < 1) {
			throw new Error("No active reviewers selected.");
		}

		const completedModelKeys = new Set(
			this.#entries
				.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.status === "done")
				.map(e => e.reviewerKey),
		);
		const hasUser = this.#entries.some(e => e.kind === "user");

		if (completedModelKeys.size < 2 && !(completedModelKeys.size >= 1 && hasUser)) {
			throw new Error("Run initial critiques from at least two models (or post a message) before starting a debate round.");
		}

		this.#round++;
		this.#busy = true;
		this.#roundAbortController = new AbortController();
		this.#emitChange();

		const roundNum = this.#round;
		const tasks = this.#activeReviewers.map(async reviewer => {
			// Find peer critiques: latest completed entry from every other model
			const peerCritiques: Array<{ reviewerLabel: string; critiqueText: string }> = [];
			for (const otherKey of completedModelKeys) {
				if (otherKey === reviewer.key) continue;
				const otherEntries = this.#entries.filter(
					(e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === otherKey && e.status === "done",
				);
				const latestOther = otherEntries[otherEntries.length - 1];
				if (latestOther && latestOther.text.trim()) {
					peerCritiques.push({
						reviewerLabel: latestOther.reviewerLabel,
						critiqueText: latestOther.text,
					});
				}
			}

			// Find user notes posted since reviewer's last completed turn
			const reviewerCompletedEntries = this.#entries.filter(
				(e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.reviewerKey === reviewer.key && e.status === "done",
			);
			const lastTurnTime =
				reviewerCompletedEntries.length > 0
					? reviewerCompletedEntries[reviewerCompletedEntries.length - 1].finishedAt ?? 0
					: 0;

			const recentUserMessages = this.#entries.filter(
				(e): e is CouncilTurnEntry & { kind: "user" } => e.kind === "user" && e.createdAt > lastTurnTime,
			);
			let operatorNotes: string | undefined;
			if (recentUserMessages.length > 0) {
				operatorNotes = recentUserMessages
					.map(u => (u.targetLabel ? `[To ${u.targetLabel}]: ${u.text}` : u.text))
					.join("\n\n");
			}

			const promptText = renderDebateRebuttal({
				round: roundNum,
				peerCritiques,
				operatorNotes,
			});

			// Per-reviewer history setup
			let history = this.#histories.get(reviewer.key);
			if (!history) {
				history = [];
				this.#histories.set(reviewer.key, history);
				// Newly joined reviewer seeds with Round 1 plan prompt
				const initialUserPrompt = renderCritiqueRound({
					round: 1,
					planTitle: this.#planTitle,
					planFilePath: this.#planFilePath,
					planContent: this.#planContent,
					sessionContext: this.#sessionContext,
				});
				history.push(createUserMessage(initialUserPrompt));
			}

			const entry: CouncilTurnEntry = {
				id: crypto.randomUUID(),
				kind: "rebuttal",
				round: roundNum,
				reviewerKey: reviewer.key,
				reviewerLabel: reviewer.label,
				status: "streaming",
				text: "",
				startedAt: Date.now(),
			};
			this.#entries.push(entry);
			this.#emitChange();

			const timeoutSignal = AbortSignal.timeout(120_000);
			const combinedSignal = AbortSignal.any([this.#roundAbortController!.signal, timeoutSignal]);

			try {
				const apiKey = this.#getApiKey ? await this.#getApiKey(reviewer.model) : undefined;
				const context: Context = {
					systemPrompt: [renderCritiqueSystem()],
					messages: [...history, createUserMessage(promptText)],
				};

				const stream = this.#streamFn(reviewer.model, context, { signal: combinedSignal, apiKey });
				for await (const event of stream) {
					if (event.type === "text_delta") {
						entry.text += event.delta;
						this.#emitChange();
					}
				}

				const msg = await stream.result();
				if (combinedSignal.aborted || msg.stopReason === "aborted") {
					entry.status = "aborted";
				} else if (msg.stopReason === "error") {
					entry.status = "error";
					entry.errorMessage = msg.errorMessage || "Model request failed";
				} else {
					entry.status = "done";
					if (!entry.text && msg.content) {
						entry.text = msg.content
							.filter(c => c.type === "text")
							.map(c => c.text)
							.join("");
					}
					history.push(createUserMessage(promptText));
					history.push(msg);
				}
			} catch (err) {
				if (combinedSignal.aborted) {
					entry.status = "aborted";
				} else {
					entry.status = "error";
					entry.errorMessage = err instanceof Error ? err.message : String(err);
				}
			} finally {
				entry.finishedAt = Date.now();
				this.#emitChange();
			}
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#busy = false;
			this.#roundAbortController = null;
			this.#emitChange();
		}
	}

	async askCouncil(rawInput: string, defaultTargetKey?: string): Promise<void> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}

		const match = rawInput.match(/^@([a-zA-Z0-9_\-./]+)\s*(.*)$/s);
		let targetReviewer: ReviewerMember | undefined;
		let userText = rawInput.trim();

		const allKnownReviewers = [...this.#availableReviewers];
		for (const r of this.#activeReviewers) {
			if (!allKnownReviewers.some(k => k.key === r.key)) {
				allKnownReviewers.push(r);
			}
		}

		if (match) {
			const token = match[1].toLowerCase();
			userText = match[2].trim();
			if (!userText) {
				throw new Error("Please provide a question or comment following the @mention.");
			}

			// Exact match first
			const exact = allKnownReviewers.find(
				r => r.model.id.toLowerCase() === token || r.key.toLowerCase() === token,
			);

			if (exact) {
				targetReviewer = exact;
			} else {
				// Substring match
				const candidates = allKnownReviewers.filter(
					r => r.model.id.toLowerCase().includes(token) || r.key.toLowerCase().includes(token),
				);
				if (candidates.length === 0) {
					throw new Error(`Unknown reviewer model "@${match[1]}".`);
				}
				if (candidates.length > 1) {
					throw new Error(
						`Ambiguous reviewer "@${match[1]}". Matches multiple models: ${candidates.map(c => c.label).join(", ")}`,
					);
				}
				targetReviewer = candidates[0];
			}
		} else if (defaultTargetKey) {
			targetReviewer = allKnownReviewers.find(r => r.key === defaultTargetKey);
		}

		if (!userText) {
			throw new Error("Please enter a question or comment.");
		}

		const targetKey = targetReviewer?.key;
		const targetLabel = targetReviewer?.label;
		const reviewersToStream = targetReviewer ? [targetReviewer] : [...this.#activeReviewers];

		if (reviewersToStream.length === 0) {
			throw new Error("No reviewers available to answer.");
		}

		const userEntry: CouncilTurnEntry = {
			id: crypto.randomUUID(),
			kind: "user",
			round: this.#round,
			targetReviewerKey: targetKey,
			targetLabel,
			text: userText,
			createdAt: Date.now(),
		};
		this.#entries.push(userEntry);
		this.#busy = true;
		this.#roundAbortController = new AbortController();
		this.#emitChange();

		const promptText = renderUserFollowup({ userMessage: userText });

		const tasks = reviewersToStream.map(async reviewer => {
			let history = this.#histories.get(reviewer.key);
			if (!history) {
				history = [];
				this.#histories.set(reviewer.key, history);
				const initialUserPrompt = renderCritiqueRound({
					round: 1,
					planTitle: this.#planTitle,
					planFilePath: this.#planFilePath,
					planContent: this.#planContent,
					sessionContext: this.#sessionContext,
				});
				history.push(createUserMessage(initialUserPrompt));
			}

			const entry: CouncilTurnEntry = {
				id: crypto.randomUUID(),
				kind: "reply",
				round: this.#round,
				reviewerKey: reviewer.key,
				reviewerLabel: reviewer.label,
				status: "streaming",
				text: "",
				startedAt: Date.now(),
			};
			this.#entries.push(entry);
			this.#emitChange();

			const timeoutSignal = AbortSignal.timeout(120_000);
			const combinedSignal = AbortSignal.any([this.#roundAbortController!.signal, timeoutSignal]);

			try {
				const apiKey = this.#getApiKey ? await this.#getApiKey(reviewer.model) : undefined;
				const context: Context = {
					systemPrompt: [renderCritiqueSystem()],
					messages: [...history, createUserMessage(promptText)],
				};

				const stream = this.#streamFn(reviewer.model, context, { signal: combinedSignal, apiKey });
				for await (const event of stream) {
					if (event.type === "text_delta") {
						entry.text += event.delta;
						this.#emitChange();
					}
				}

				const msg = await stream.result();
				if (combinedSignal.aborted || msg.stopReason === "aborted") {
					entry.status = "aborted";
				} else if (msg.stopReason === "error") {
					entry.status = "error";
					entry.errorMessage = msg.errorMessage || "Model request failed";
				} else {
					entry.status = "done";
					if (!entry.text && msg.content) {
						entry.text = msg.content
							.filter(c => c.type === "text")
							.map(c => c.text)
							.join("");
					}
					history.push(createUserMessage(promptText));
					history.push(msg);
				}
			} catch (err) {
				if (combinedSignal.aborted) {
					entry.status = "aborted";
				} else {
					entry.status = "error";
					entry.errorMessage = err instanceof Error ? err.message : String(err);
				}
			} finally {
				entry.finishedAt = Date.now();
				this.#emitChange();
			}
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#busy = false;
			this.#roundAbortController = null;
			this.#emitChange();
		}
	}

	async synthesizeFeedback(synthesizerModel: Model | undefined): Promise<CouncilTurnEntry & { kind: "synthesis" }> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}
		if (!synthesizerModel) {
			throw new Error("No synthesizer model available.");
		}

		const hasContent = this.#entries.some(
			e => (e.kind !== "user" && e.status === "done") || e.kind === "user",
		);
		if (!hasContent) {
			throw new Error("Run at least one critique or message before synthesizing.");
		}

		this.#busy = true;
		this.#roundAbortController = new AbortController();

		const historyLines: string[] = [];
		for (const e of this.#entries) {
			if (e.kind === "user") {
				historyLines.push(`### Operator [To ${e.targetLabel ?? "Council"}]:\n${e.text}\n`);
			} else if (e.kind === "synthesis") {
				// Don't include previous synthesis drafts in new synthesis
				continue;
			} else if (e.status === "done" && e.text.trim()) {
				historyLines.push(`### ${e.reviewerLabel} (Round ${e.round} ${e.kind}):\n${e.text}\n`);
			}
		}

		const synthUserPrompt = renderSynthesizeUser({
			planTitle: this.#planTitle,
			planFilePath: this.#planFilePath,
			planContent: this.#planContent,
			discussionHistory: historyLines.join("\n---\n"),
		});

		const entry: CouncilTurnEntry & { kind: "synthesis" } = {
			id: crypto.randomUUID(),
			kind: "synthesis",
			round: this.#round,
			modelLabel: `${synthesizerModel.id} (${synthesizerModel.provider})`,
			status: "streaming",
			text: "",
			startedAt: Date.now(),
		};
		this.#entries.push(entry);
		this.#latestSynthesis = entry;
		this.#emitChange();

		const timeoutSignal = AbortSignal.timeout(120_000);
		const combinedSignal = AbortSignal.any([this.#roundAbortController.signal, timeoutSignal]);

		try {
			const apiKey = this.#getApiKey ? await this.#getApiKey(synthesizerModel) : undefined;
			const context: Context = {
				systemPrompt: [renderSynthesizeSystem()],
				messages: [createUserMessage(synthUserPrompt)],
			};

			const stream = this.#streamFn(synthesizerModel, context, { signal: combinedSignal, apiKey });
			for await (const event of stream) {
				if (event.type === "text_delta") {
					entry.text += event.delta;
					this.#emitChange();
				}
			}

			const msg = await stream.result();
			if (combinedSignal.aborted || msg.stopReason === "aborted") {
				entry.status = "aborted";
			} else if (msg.stopReason === "error") {
				entry.status = "error";
				entry.errorMessage = msg.errorMessage || "Synthesizer model request failed";
			} else {
				entry.status = "done";
				if (!entry.text && msg.content) {
					entry.text = msg.content
						.filter(c => c.type === "text")
						.map(c => c.text)
						.join("");
				}
			}
		} catch (err) {
			if (combinedSignal.aborted) {
				entry.status = "aborted";
			} else {
				entry.status = "error";
				entry.errorMessage = err instanceof Error ? err.message : String(err);
			}
		} finally {
			entry.finishedAt = Date.now();
			this.#busy = false;
			this.#roundAbortController = null;
			this.#emitChange();
		}

		return entry;
	}

	hasCritiqueDisagreements(): boolean {
		const critiques = this.#entries.filter(
			(e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.kind === "critique" && e.round === 1 && e.status === "done",
		);
		if (critiques.length < 2) return false;

		for (const c of critiques) {
			const upper = c.text.toUpperCase();
			if (upper.includes("NEEDS REVISION") || upper.includes("BLOCK")) {
				return true;
			}
			const lower = c.text.toLowerCase();
			if (lower.includes("### blocking issues") && !lower.includes("no blocking issues")) {
				return true;
			}
		}
		return false;
	}

	async runAutoPipeline(
		synthesizerModel: Model | undefined,
		options: {
			autoDebate?: boolean;
			onStageChange?: (stage: string) => void;
		} = {},
	): Promise<CouncilTurnEntry & { kind: "synthesis" }> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}

		options.onStageChange?.("Round 1 Critiques");
		await this.startInitialCritiques();

		const completedKeys = new Set(
			this.#entries
				.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.status === "done")
				.map(e => e.reviewerKey),
		);

		const shouldDebate =
			options.autoDebate !== false &&
			completedKeys.size >= 2 &&
			(options.autoDebate === true || this.hasCritiqueDisagreements());

		if (shouldDebate) {
			options.onStageChange?.("Round 2 Debate");
			await this.runDebateRound();
		}

		options.onStageChange?.("Synthesizing Consensus");
		return await this.synthesizeFeedback(synthesizerModel);
	}

	abortActiveRound(): void {
		if (this.#roundAbortController) {
			this.#roundAbortController.abort();
		}
		for (const entry of this.#entries) {
			if (entry.kind !== "user" && entry.status === "streaming") {
				entry.status = "aborted";
				entry.finishedAt = Date.now();
			}
		}
		this.#busy = false;
		this.#emitChange();
	}

	dispose(): void {
		this.abortActiveRound();
		this.#listeners.clear();
	}
}
