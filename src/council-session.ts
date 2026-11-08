import type {
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { streamSimple, validateToolArguments } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	ASK_CODEBASE_TOOL,
	ASK_CODEBASE_TOOL_NAME,
	type askCodebaseSchema,
	type CodebaseReader,
	type CodeReaderQueryInput,
} from "./code-reader";
import type { ReviewerMember } from "./models";
import type { PlanFileExcerpt } from "./plan-files";
import {
	computeConvergence,
	type ConvergenceReport,
	formatConvergence,
	formatReportedPositions,
	isUnanimousApproval,
	parseReviewerPosition,
	REPORT_POSITION_TOOL,
	REPORT_POSITION_TOOL_NAME,
	type ReviewerPosition,
	type RevisionItem,
	validateReportedPosition,
} from "./position";
import {
	renderCritiqueRound,
	renderCritiqueSystem,
	renderDebateRebuttal,
	renderPositionFollowup,
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
			position?: ReviewerPosition;
			positionError?: string;
			startedAt: number;
			finishedAt?: number;
			/** the turn is waiting on the codebase reader */
			readerStatus?: "queued" | "reading";
			/** ask_codebase queries this turn has made */
			readerQueryCount?: number;
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

/** composer target key that routes an operator question to the codebase reader */
export const READER_TARGET_KEY = "@reader";

/** operator questions wait in the reader's queue behind reviewer checks, so the budget covers both */
const OPERATOR_READER_TIMEOUT_MS = 90_000;

export interface ReaderTurnEntry {
	id: string;
	round: number;
	requesterKind: "reviewer" | "operator";
	requesterKey?: string;
	requesterLabel: string;
	question: string;
	paths?: string[];
	status: "queued" | "reading" | "done" | "error" | "aborted";
	activeTool?: string;
	answer: string;
	cached?: boolean;
	errorMessage?: string;
	startedAt: number;
	finishedAt?: number;
}

function createUserMessage(content: string): Message {
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}

function createToolResult(block: ToolCall, text: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: block.id,
		toolName: block.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

export type ModelStreamFn = (
	model: Model,
	context: Context,
	options: Pick<SimpleStreamOptions, "apiKey" | "reasoning" | "disableReasoning" | "toolChoice"> & { signal: AbortSignal },
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
	/** shared read-only codebase subagent reviewers and the operator may query */
	codeReader?: CodebaseReader;
	maxReaderQueriesPerTurn?: number;
	/** plan-referenced file excerpts attached to every reviewer's Round 1 prompt */
	referencedFiles?: readonly PlanFileExcerpt[];
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
	/** the running auto pipeline; abortActiveRound stops it so it cannot continue after the overlay closes */
	#autoRun?: { stopped: boolean };
	#codeReader?: CodebaseReader;
	#maxReaderQueriesPerTurn: number;
	#readerEntries: ReaderTurnEntry[] = [];
	#referencedFiles: PlanFileExcerpt[];

	/** preserve reviewer request options when forwarding to the native model stream */
	constructor(options: CouncilSessionOptions) {
		this.#planTitle = options.planTitle;
		this.#planFilePath = options.planFilePath;
		this.#planContent = options.planContent;
		this.#sessionContext = options.sessionContext;
		this.#availableReviewers = [...options.availableReviewers];
		this.#activeReviewers = [...options.initialReviewers];
		this.#getApiKey = options.getApiKey;
		this.#sessionId = options.sessionId;
		this.#codeReader = options.codeReader;
		this.#maxReaderQueriesPerTurn = Math.min(6, Math.max(1, Math.round(options.maxReaderQueriesPerTurn ?? 3)));
		this.#referencedFiles = [...(options.referencedFiles ?? [])];

		this.#streamFn =
			options.streamFn ??
			((model, context, opts) =>
				streamSimple(model, context, {
					...opts,
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

	/** construction-time snapshot; late joiners see the same excerpts */
	get referencedFiles(): readonly PlanFileExcerpt[] {
		return this.#referencedFiles;
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

	get hasCodeReader(): boolean {
		return Boolean(this.#codeReader);
	}

	get readerModelLabel(): string | undefined {
		return this.#codeReader?.modelLabel;
	}

	get readerEntries(): readonly ReaderTurnEntry[] {
		return this.#readerEntries;
	}

	isBusy(): boolean {
		return this.#busy;
	}

	/** a round is running, or an auto run that has not been stopped is between stages */
	isActive(): boolean {
		return this.#busy || (this.#autoRun !== undefined && !this.#autoRun.stopped);
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

	/** the Round 1 plan prompt every reviewer history starts from, including late joiners */
	#renderInitialPlanPrompt(): string {
		return renderCritiqueRound({
			round: 1,
			planTitle: this.#planTitle,
			planFilePath: this.#planFilePath,
			planContent: this.#planContent,
			sessionContext: this.#sessionContext,
			referencedFiles: this.#referencedFiles,
		});
	}

	/** request initial critiques using each selected reviewer and its thinking level */
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

		const controller = this.#beginRound();
		this.#emitChange();

		const userPrompt = this.#renderInitialPlanPrompt();

		const tasks = reviewersToRun.map(async reviewer => {
			const entry: ReviewerTurnEntry = {
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
			await this.#runReviewerTurn({
				reviewer,
				entry,
				signal: controller.signal,
				baseMessages: [],
				promptText: userPrompt,
				promptedItemIds: [],
				forcePosition: true,
			});
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#endRound(controller);
			this.#emitChange();
		}
	}

	/** debate peer critiques with the same thinking levels used for initial review */
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
		const controller = this.#beginRound();
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
			// operator codebase checks completed since the reviewer's last turn travel with the operator guidance
			const recentReaderAnswers = this.#readerEntries.filter(
				r => r.requesterKind === "operator" && r.status === "done" && (r.finishedAt ?? 0) > lastTurnTime,
			);
			const notes = [
				...recentUserMessages.map(u => (u.targetLabel ? `[To ${u.targetLabel}]: ${u.text}` : u.text)),
				...recentReaderAnswers.map(r => `[Operator → Reader]: ${r.question}\n[Reader]: ${r.answer}`),
			];
			const operatorNotes = notes.length > 0 ? notes.join("\n\n") : undefined;

			const peerItems = this.#peerItems(reviewer.key);
			const promptedItemIds = peerItems.map(i => i.id);
			const promptText = renderDebateRebuttal({
				round: roundNum,
				peerCritiques,
				peerItems,
				operatorNotes,
				hasCodeReader: Boolean(this.#codeReader),
			});

			// Per-reviewer history setup
			let history = this.#histories.get(reviewer.key);
			if (!history) {
				history = [];
				this.#histories.set(reviewer.key, history);
				// Newly joined reviewer seeds with Round 1 plan prompt
				const initialUserPrompt = this.#renderInitialPlanPrompt();
				history.push(createUserMessage(initialUserPrompt));
			}

			const entry: ReviewerTurnEntry = {
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
			await this.#runReviewerTurn({
				reviewer,
				entry,
				signal: controller.signal,
				baseMessages: history,
				promptText,
				promptedItemIds,
				forcePosition: true,
			});
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#endRound(controller);
			this.#emitChange();
		}
	}

	/** send operator questions without losing the targeted reviewers thinking settings */
	async askCouncil(rawInput: string, defaultTargetKey?: string): Promise<void> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}

		const match = rawInput.match(/^@([a-zA-Z0-9_\-./]+)\s*(.*)$/s);
		let targetReviewer: ReviewerMember | undefined;
		let userText = rawInput.trim();
		let askReader = false;

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
			} else if (token === "reader" || token === "scout") {
				askReader = true;
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
		} else if (defaultTargetKey === READER_TARGET_KEY) {
			askReader = true;
		} else if (defaultTargetKey) {
			targetReviewer = allKnownReviewers.find(r => r.key === defaultTargetKey);
		}

		if (!userText) {
			throw new Error("Please enter a question or comment.");
		}

		if (askReader) {
			await this.#askCodeReader(userText);
			return;
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
		const controller = this.#beginRound();
		this.#emitChange();

		const tasks = reviewersToStream.map(async reviewer => {
			const peerItems = this.#peerItems(reviewer.key);
			const promptedItemIds = peerItems.map(i => i.id);
			const promptText = renderUserFollowup({ userMessage: userText, peerItems });

			let history = this.#histories.get(reviewer.key);
			if (!history) {
				history = [];
				this.#histories.set(reviewer.key, history);
				const initialUserPrompt = this.#renderInitialPlanPrompt();
				history.push(createUserMessage(initialUserPrompt));
			}

			const entry: ReviewerTurnEntry = {
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
			// replies report only when something changed, so a missing report is not forced
			await this.#runReviewerTurn({
				reviewer,
				entry,
				signal: controller.signal,
				baseMessages: history,
				promptText,
				promptedItemIds,
				forcePosition: false,
			});
		});

		try {
			await Promise.allSettled(tasks);
		} finally {
			this.#endRound(controller);
			this.#emitChange();
		}
	}

	/** answer an operator question with the shared reader; the exchange lives in the Reader tab, not the council log */
	async #askCodeReader(question: string): Promise<void> {
		const reader = this.#codeReader;
		if (!reader) {
			throw new Error("Codebase reader is disabled or unavailable.");
		}

		const controller = this.#beginRound();
		const readerEntry: ReaderTurnEntry = {
			id: crypto.randomUUID(),
			round: this.#round,
			requesterKind: "operator",
			requesterLabel: "Operator",
			question,
			status: "queued",
			answer: "",
			startedAt: Date.now(),
		};
		this.#readerEntries.push(readerEntry);
		this.#emitChange();

		const timeoutSignal = AbortSignal.timeout(OPERATOR_READER_TIMEOUT_MS);
		try {
			const result = await reader.query({
				requesterLabel: readerEntry.requesterLabel,
				question,
				signal: AbortSignal.any([controller.signal, timeoutSignal]),
				...this.#readerProgress(readerEntry),
			});
			readerEntry.status = "done";
			readerEntry.answer = result.answer;
			readerEntry.cached = result.cached;
		} catch (err) {
			if (controller.signal.aborted) {
				readerEntry.status = "aborted";
			} else {
				readerEntry.status = "error";
				readerEntry.errorMessage = timeoutSignal.aborted
					? `Codebase reader query timed out after ${OPERATOR_READER_TIMEOUT_MS / 1000}s`
					: err instanceof Error
						? err.message
						: String(err);
			}
		} finally {
			readerEntry.activeTool = undefined;
			readerEntry.finishedAt = Date.now();
			this.#endRound(controller);
			this.#emitChange();
		}
	}

	/** live reader progress for the Reader tab; a reviewer turn mirrors the queued/reading status for its badge */
	#readerProgress(
		readerEntry: ReaderTurnEntry,
		turnEntry?: ReviewerTurnEntry,
	): Pick<CodeReaderQueryInput, "onStatusChange" | "onToolActivity" | "onTextDelta"> {
		return {
			onStatusChange: status => {
				readerEntry.status = status;
				if (turnEntry) turnEntry.readerStatus = status;
				this.#emitChange();
			},
			onToolActivity: toolName => {
				readerEntry.activeTool = toolName;
				this.#emitChange();
			},
			onTextDelta: (_delta, snapshot) => {
				readerEntry.answer = snapshot;
				this.#emitChange();
			},
		};
	}

	/**
	 * stream one reviewer turn: a step that calls ask_codebase gets the reader's answers as tool results and the
	 * turn continues; the first step without reader calls is finalized through #collectPosition
	 */
	async #runReviewerTurn(turn: {
		reviewer: ReviewerMember;
		entry: ReviewerTurnEntry;
		signal: AbortSignal;
		baseMessages: readonly Message[];
		promptText: string;
		promptedItemIds: string[];
		forcePosition: boolean;
	}): Promise<void> {
		const { reviewer, entry } = turn;
		const reader = this.#codeReader;
		const maxQueries = this.#maxReaderQueriesPerTurn;
		// reader round trips share the turn budget, so reader-enabled turns get more of it
		const combinedSignal = AbortSignal.any([turn.signal, AbortSignal.timeout(reader ? 240_000 : 120_000)]);
		const systemPrompt = renderCritiqueSystem({ hasCodeReader: Boolean(reader), maxReaderQueriesPerTurn: maxQueries });
		const turnPrompt = createUserMessage(turn.promptText);
		const stepMessages: Message[] = [];
		let queriesUsed = 0;
		// invalid ask_codebase calls spend no query budget, so reader steps are capped separately
		let readerSteps = 0;
		// a report_position sent alongside ask_codebase stands if the final step does not report again
		let fallbackPosition: ReviewerPosition | undefined;

		try {
			const apiKey = this.#getApiKey ? await this.#getApiKey(reviewer.model) : undefined;
			const level = concreteThinkingLevel(reviewer.thinkingLevel);

			while (!combinedSignal.aborted) {
				const canQueryReader = reader !== undefined && queriesUsed < maxQueries && readerSteps <= maxQueries;
				const context: Context = {
					systemPrompt: [systemPrompt],
					messages: [...turn.baseMessages, turnPrompt, ...stepMessages],
					tools: canQueryReader ? [ASK_CODEBASE_TOOL, REPORT_POSITION_TOOL] : [REPORT_POSITION_TOOL],
				};
				const stream = this.#streamFn(reviewer.model, context, {
					signal: combinedSignal,
					apiKey,
					reasoning: toReasoningEffort(level),
					disableReasoning: shouldDisableReasoning(level),
				});
				// prose from a continuation step starts its own paragraph
				const separator = stepMessages.length > 0 && entry.text.trim() && !entry.text.endsWith("\n\n") ? "\n\n" : "";
				let stepText = "";
				for await (const event of stream) {
					if (event.type === "text_delta" && event.delta) {
						entry.text += (stepText ? "" : separator) + event.delta;
						stepText += event.delta;
						this.#emitChange();
					}
				}

				const msg = await stream.result();
				if (combinedSignal.aborted || msg.stopReason === "aborted") {
					entry.status = "aborted";
					return;
				}
				if (msg.stopReason === "error") {
					entry.status = "error";
					entry.errorMessage = msg.errorMessage || "Model request failed";
					return;
				}
				if (!stepText) {
					const text = msg.content
						.filter(c => c.type === "text")
						.map(c => c.text)
						.join("");
					if (text) entry.text += separator + text;
				}

				if (!canQueryReader || !msg.content.some(b => b.type === "toolCall" && b.name === ASK_CODEBASE_TOOL_NAME)) {
					const report = await this.#collectPosition(reviewer, context, msg, turn.promptedItemIds, {
						signal: combinedSignal,
						apiKey,
						force: turn.forcePosition,
					});
					// abortActiveRound marks streaming entries aborted while a report follow-up runs
					if (entry.status === "streaming") {
						entry.status = "done";
						entry.position = report.position ?? fallbackPosition;
						entry.positionError = report.position || !fallbackPosition ? report.positionError : undefined;
						let history = this.#histories.get(reviewer.key);
						if (!history) {
							history = [];
							this.#histories.set(reviewer.key, history);
						}
						history.push(turnPrompt, ...stepMessages, ...report.messages);
					}
					return;
				}

				readerSteps++;
				// providers reject unanswered calls, so every call in the step gets a result
				const toolResults: ToolResultMessage[] = [];
				for (const block of msg.content) {
					if (block.type !== "toolCall") continue;

					if (block.name === REPORT_POSITION_TOOL_NAME) {
						try {
							fallbackPosition = validateReportedPosition(block, reviewer.key, turn.promptedItemIds);
							toolResults.push(
								createToolResult(
									block,
									`Codebase results attached; incorporate them into your review and call ${REPORT_POSITION_TOOL_NAME} again with your final verdict.`,
									false,
								),
							);
						} catch (err) {
							toolResults.push(createToolResult(block, err instanceof Error ? err.message : String(err), true));
						}
						continue;
					}
					if (block.name !== ASK_CODEBASE_TOOL_NAME) {
						toolResults.push(
							createToolResult(
								block,
								`Unknown tool "${block.name}"; available tools: ${ASK_CODEBASE_TOOL_NAME}, ${REPORT_POSITION_TOOL_NAME}.`,
								true,
							),
						);
						continue;
					}

					let args: typeof askCodebaseSchema.infer;
					try {
						args = validateToolArguments(ASK_CODEBASE_TOOL, block) as typeof askCodebaseSchema.infer;
					} catch (err) {
						toolResults.push(createToolResult(block, err instanceof Error ? err.message : String(err), true));
						continue;
					}
					if (queriesUsed >= maxQueries) {
						toolResults.push(
							createToolResult(
								block,
								`Codebase reader query limit (${maxQueries}) reached for this turn. Write your review and call ${REPORT_POSITION_TOOL_NAME} using the evidence gathered so far.`,
								true,
							),
						);
						continue;
					}

					queriesUsed++;
					entry.readerQueryCount = queriesUsed;
					const readerEntry: ReaderTurnEntry = {
						id: crypto.randomUUID(),
						round: entry.round,
						requesterKind: "reviewer",
						requesterKey: reviewer.key,
						requesterLabel: reviewer.label,
						question: args.question,
						paths: args.paths,
						status: "queued",
						answer: "",
						startedAt: Date.now(),
					};
					this.#readerEntries.push(readerEntry);
					entry.readerStatus = "queued";
					this.#emitChange();
					try {
						const result = await reader.query({
							requesterLabel: reviewer.label,
							question: args.question,
							paths: args.paths,
							signal: combinedSignal,
							...this.#readerProgress(readerEntry, entry),
						});
						readerEntry.status = "done";
						readerEntry.answer = result.answer;
						readerEntry.cached = result.cached;
						toolResults.push(createToolResult(block, result.answer, false));
					} catch (err) {
						if (combinedSignal.aborted) {
							readerEntry.status = "aborted";
							break;
						}
						const message = err instanceof Error ? err.message : String(err);
						readerEntry.status = "error";
						readerEntry.errorMessage = message;
						// a reader failure degrades the review to plan-text evidence instead of failing the turn
						toolResults.push(
							createToolResult(
								block,
								`Codebase reader error: ${message}. Continue your review from the plan text and note any unverified codebase assumptions.`,
								true,
							),
						);
					} finally {
						readerEntry.activeTool = undefined;
						readerEntry.finishedAt = Date.now();
						this.#emitChange();
					}
				}

				entry.readerStatus = undefined;
				if (combinedSignal.aborted) break;
				stepMessages.push(msg, ...toolResults);
				this.#emitChange();
			}
			entry.status = "aborted";
		} catch (err) {
			if (combinedSignal.aborted) {
				entry.status = "aborted";
			} else {
				entry.status = "error";
				entry.errorMessage = err instanceof Error ? err.message : String(err);
			}
		} finally {
			entry.readerStatus = undefined;
			entry.finishedAt = Date.now();
			this.#emitChange();
		}
	}

	/** synthesize discussion with the selected model and optional thinking level */
	async synthesizeFeedback(
		synthesizerModel: Model | undefined,
		synthesizerThinkingLevel?: ConfiguredThinkingLevel,
	): Promise<CouncilTurnEntry & { kind: "synthesis" }> {
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

		const controller = this.#beginRound();

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
		const reviewerPositions = this.#reviewerPositions();
		const convergence = computeConvergence(reviewerPositions);
		historyLines.push(`### Reported Positions\n${formatReportedPositions(reviewerPositions)}\n`);
		historyLines.push(`### Convergence\n${formatConvergence(convergence, convergence.items)}\n`);

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
		const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

		try {
			const apiKey = this.#getApiKey ? await this.#getApiKey(synthesizerModel) : undefined;
			const context: Context = {
				systemPrompt: [renderSynthesizeSystem()],
				messages: [createUserMessage(synthUserPrompt)],
			};

			const level = concreteThinkingLevel(synthesizerThinkingLevel);
			const stream = this.#streamFn(synthesizerModel, context, {
				signal: combinedSignal,
				apiKey,
				reasoning: toReasoningEffort(level),
				disableReasoning: shouldDisableReasoning(level),
			});
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
			this.#endRound(controller);
			this.#emitChange();
		}

		return entry;
	}

	/**
	 * parse the turn's report; when `force` is set and it is missing or invalid, ask once more on the same history
	 * with report_position forced, since some models write the review but skip or malform the call.
	 * Returns the assistant/tool messages to append to the reviewer history after the turn's prompt.
	 */
	async #collectPosition(
		reviewer: ReviewerMember,
		context: Context,
		msg: AssistantMessage,
		promptedItemIds: string[],
		request: { signal: AbortSignal; apiKey: ApiKey | undefined; force: boolean },
	): Promise<{ position?: ReviewerPosition; positionError?: string; messages: Message[] }> {
		// the error for an unknown call names the tools the turn actually offered
		const offeredTools = context.tools?.map(t => t.name);
		const first = parseReviewerPosition(msg, reviewer.key, promptedItemIds, offeredTools);
		const messages: Message[] = [msg, ...first.toolResults];
		if (first.position || !request.force || request.signal.aborted) {
			return { position: first.position, positionError: first.positionError, messages };
		}

		const followUpPrompt = createUserMessage(renderPositionFollowup());
		const level = concreteThinkingLevel(reviewer.thinkingLevel);
		try {
			const stream = this.#streamFn(
				reviewer.model,
				{ ...context, messages: [...context.messages, ...messages, followUpPrompt] },
				{
					signal: request.signal,
					apiKey: request.apiKey,
					reasoning: toReasoningEffort(level),
					disableReasoning: shouldDisableReasoning(level),
					toolChoice: { type: "function", name: REPORT_POSITION_TOOL_NAME },
				},
			);
			// the forced report is bookkeeping, not part of the visible review text
			for await (const _event of stream) {
			}
			const followUp = await stream.result();
			if (followUp.stopReason === "error" || followUp.stopReason === "aborted") {
				return { positionError: first.positionError, messages };
			}
			const second = parseReviewerPosition(followUp, reviewer.key, promptedItemIds, offeredTools);
			return {
				position: second.position,
				positionError: second.positionError,
				messages: [...messages, followUpPrompt, followUp, ...second.toolResults],
			};
		} catch {
			return { positionError: first.positionError, messages };
		}
	}

	/**
	 * position of the reviewer's latest completed turn; a critique or rebuttal without a valid report clears it,
	 * while an operator reply (whose prompt makes the report optional) without one keeps the previous position
	 */
	#latestPosition(reviewerKey: string): ReviewerPosition | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			const e = this.#entries[i];
			if (!isReviewerTurnEntry(e) || e.reviewerKey !== reviewerKey || e.status !== "done") continue;
			if (e.kind === "reply" && !e.position) continue;
			return e.position;
		}
		return undefined;
	}

	/** required revisions currently held by every other active reviewer, in roster order */
	#peerItems(reviewerKey: string): RevisionItem[] {
		return this.#activeReviewers
			.filter(r => r.key !== reviewerKey)
			.flatMap(r => this.#latestPosition(r.key)?.revisions ?? []);
	}

	#completedReviewerCount(): number {
		const completedKeys = new Set(
			this.#entries
				.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && e.status === "done")
				.map(e => e.reviewerKey),
		);
		return completedKeys.size;
	}

	/** the reviewer's current position, under the same reply-retention rule synthesis and convergence use */
	getLatestPosition(reviewerKey: string): ReviewerPosition | undefined {
		return this.#latestPosition(reviewerKey);
	}

	/** every active reviewer with its current position, in roster order */
	getReviewerPositions(): Array<{ reviewer: ReviewerMember; position?: ReviewerPosition }> {
		return this.#activeReviewers.map(reviewer => ({
			reviewer,
			position: this.#latestPosition(reviewer.key),
		}));
	}

	#reviewerPositions(): { label: string; position?: ReviewerPosition }[] {
		return this.getReviewerPositions().map(({ reviewer, position }) => ({ label: reviewer.label, position }));
	}

	getConvergence(): ConvergenceReport {
		return computeConvergence(this.#reviewerPositions());
	}

	/** every active reviewer currently approves and requires no change, so there is nothing to debate or refine */
	approvedUnanimously(): boolean {
		return isUnanimousApproval(
			this.getConvergence(),
			this.#activeReviewers.map(r => this.#latestPosition(r.key)?.verdict),
		);
	}

	/** run the council stages while retaining the synthesizer thinking selection */
	async runAutoPipeline(
		synthesizerModel: Model | undefined,
		options: {
			autoDebate?: boolean;
			maxDebateRounds?: number;
			synthesizerThinkingLevel?: ConfiguredThinkingLevel;
			onStageChange?: (stage: string) => void;
		} = {},
	): Promise<CouncilTurnEntry & { kind: "synthesis" }> {
		if (this.#busy) {
			throw new Error("Council is busy.");
		}

		const run = { stopped: false };
		this.#autoRun = run;
		const stage = (name: string) => {
			if (run.stopped) throw new Error("Auto council stopped.");
			options.onStageChange?.(name);
		};

		try {
			stage("Round 1 Critiques");
			await this.startInitialCritiques();

			const maxDebateRounds = options.maxDebateRounds ?? 3;
			if (options.autoDebate !== false) {
				if (!this.approvedUnanimously()) {
					for (let i = 0; i < maxDebateRounds; i++) {
						if (this.#completedReviewerCount() < 2) break;
						stage(`Round ${this.#round + 1} Debate`);
						await this.runDebateRound();
						if (this.getConvergence().converged) break;
					}
				}
			}

			stage("Synthesizing Consensus");
			return await this.synthesizeFeedback(synthesizerModel, options.synthesizerThinkingLevel);
		} finally {
			if (this.#autoRun === run) this.#autoRun = undefined;
			this.#emitChange();
		}
	}

	/** claim the session for one round; the returned controller identifies the round to #endRound */
	#beginRound(): AbortController {
		const controller = new AbortController();
		this.#busy = true;
		this.#roundAbortController = controller;
		return controller;
	}

	/**
	 * abortActiveRound frees the session immediately, so an aborted round can settle after a newer one started;
	 * only the current round may release the session and its controller
	 */
	#endRound(controller: AbortController): void {
		if (this.#roundAbortController !== controller) return;
		this.#busy = false;
		this.#roundAbortController = null;
	}

	abortActiveRound(): void {
		if (this.#autoRun) {
			this.#autoRun.stopped = true;
		}
		if (this.#roundAbortController) {
			this.#roundAbortController.abort();
		}
		for (const entry of this.#entries) {
			if (isReviewerTurnEntry(entry)) {
				entry.readerStatus = undefined;
			}
			if (entry.kind !== "user" && entry.status === "streaming") {
				entry.status = "aborted";
				entry.finishedAt = Date.now();
			}
		}
		for (const readerEntry of this.#readerEntries) {
			if (readerEntry.status === "queued" || readerEntry.status === "reading") {
				readerEntry.status = "aborted";
				readerEntry.activeTool = undefined;
				readerEntry.finishedAt = Date.now();
			}
		}
		this.#busy = false;
		this.#emitChange();
	}

	dispose(): void {
		this.abortActiveRound();
		void this.#codeReader?.dispose();
		this.#listeners.clear();
	}
}
