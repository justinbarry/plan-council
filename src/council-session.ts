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
import { StallTimer } from "./stall-timer";
import type { ReviewerMember } from "./models";
import type { PlanFileExcerpt } from "./plan-files";
import {
	computeConvergence,
	computePositionDelta,
	type ConvergenceReport,
	formatConvergence,
	formatReportedPositions,
	isUnanimousApproval,
	parseReviewerPosition,
	type PositionDelta,
	REPORT_POSITION_TOOL,
	REPORT_POSITION_TOOL_NAME,
	type ReviewerPosition,
	type RevisionItem,
	stabilizeRevisionIds,
	validateReportedPosition,
} from "./position";
import {
	type OwnDisputeItem,
	type PeerRevisionPromptItem,
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
			/** the turn's place in a sequential Round 2+ roundtable */
			roundtableTurn?: { step: number };
			/** how the turn's report moved the reviewer's previous reported position */
			positionDelta?: PositionDelta;
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

/** the reviewer holding the floor in a sequential debate round or operator Q&A pass */
export interface ActiveSpeaker {
	reviewerKey: string;
	modelId: string;
	label: string;
	kind: "rebuttal" | "reply";
	step: number;
}

/** `queued`: the council was busy; `target` names the reviewer an `@model` message gives the next turn */
export type AskCouncilResult = { status: "answered" } | { status: "queued"; target?: ReviewerMember };

/** a reviewer's question to the operator that no later operator message has answered */
export interface OpenOperatorQuestion {
	reviewerKey: string;
	reviewerLabel: string;
	question: string;
	/** the reviewer turn whose report asked it */
	entryId: string;
}

/** an auto run paused because reviewers asked the operator something; each question pauses it once */
export class OperatorQuestionPending extends Error {
	constructor(readonly questions: readonly OpenOperatorQuestion[]) {
		super(
			`${questions.map(q => `${q.reviewerLabel} asks: "${q.question}"`).join(" · ")} — press i to answer, or Space to continue without answering.`,
		);
		this.name = "OperatorQuestionPending";
	}
}

/** entries a reviewer has not yet been shown, and the IDs a completed turn marks seen */
interface UnseenContext {
	peerTurns: ReviewerTurnEntry[];
	userEntries: (CouncilTurnEntry & { kind: "user" })[];
	operatorReaderEntries: ReaderTurnEntry[];
	/** every unseen completed peer turn, including skipped older and tool-only ones */
	consumedPeerIds: string[];
	consumedOperatorIds: string[];
}

/** composer target key that routes an operator question to the codebase reader */
export const READER_TARGET_KEY = "@reader";

/** a model request is abandoned after this long without any stream event (text, reasoning, or tool call) */
const DEFAULT_MODEL_STALL_MS = 180_000;

/** turns one reviewer may start in one debate round; an operator's queued `@model` message may exceed it */
const MAX_ROUNDTABLE_TURNS_PER_REVIEWER = 2;

/** an operator message sent while the council was busy, answered once it is idle */
type PendingAsk =
	| {
			kind: "ask";
			userEntry: CouncilTurnEntry & { kind: "user" };
			reviewers: ReviewerMember[];
			/** a debate round already gave the single addressee its turn for this message */
			preempted: boolean;
	  }
	| { kind: "reader"; question: string };

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
	/** how long a model stream may go without any event before its request is abandoned; default 180s */
	modelStallMs?: number;
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
	#modelStallMs: number;
	/** next never-used revision number per reviewer, so a dropped `#N` is never reissued to a different item */
	#nextRevisionNumber = new Map<string, number>();
	/** per reviewer: peer turns, operator messages, and operator reader answers already delivered in a completed turn */
	#seenEntryIds = new Map<string, Set<string>>();
	#activeSpeaker?: ActiveSpeaker;
	#pendingAsks: PendingAsk[] = [];
	#draining = false;
	#disposed = false;
	/** question-bearing entry IDs auto-run has already paused on; a question pauses it once */
	#pausedQuestionIds = new Set<string>();
	/**
	 * transcript length when a question-bearing turn finished: an entry is pushed when its turn starts, so only
	 * operator messages from this index on were sent after the operator could see the question
	 */
	#questionReportedAt = new Map<string, number>();

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
		this.#modelStallMs = options.modelStallMs ?? DEFAULT_MODEL_STALL_MS;

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

	/** the reviewer holding the floor while a debate round runs; undefined for parallel rounds and when idle */
	get activeSpeaker(): ActiveSpeaker | undefined {
		return this.#activeSpeaker;
	}

	/** operator messages waiting for the council to go idle */
	get pendingAskCount(): number {
		return this.#pendingAsks.length;
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
			this.#afterRound();
		}
	}

	/**
	 * Round 2+ is a sequential roundtable: each speaker sees earlier speakers' replies and position updates from
	 * the same round. The floor is reactive: a reviewer named by `nextSpeaker` and the authors of items a speaker
	 * disputes speak next, peers who already spoke confirm new wording, and a queued `@model` operator message gives
	 * that reviewer the next turn. The round ends when no one is queued or every held revision is agreed.
	 */
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

		// an operator-requested round on an already converged council runs every speaker
		const startedConverged = this.getConvergence().converged;
		this.#round++;
		const controller = this.#beginRound();
		this.#emitChange();

		const roundNum = this.#round;
		const queue = this.#orderDebateSpeakers();
		const turnsStarted = new Map<string, number>();
		let step = 0;
		try {
			while (!controller.signal.aborted) {
				let reviewer: ReviewerMember;
				const preempt = this.#operatorPreemptedSpeaker();
				if (preempt) {
					const at = queue.findIndex(r => r.key === preempt.key);
					if (at !== -1) queue.splice(at, 1);
					reviewer = preempt;
				} else {
					const next = queue[0];
					if (!next) break;
					if (
						step > 0 &&
						!startedConverged &&
						this.getConvergence().converged &&
						queue.every(s => !this.#hasUnseenOperatorInput(s.key))
					) {
						break;
					}
					queue.shift();
					reviewer = next;
				}
				step++;
				turnsStarted.set(reviewer.key, (turnsStarted.get(reviewer.key) ?? 0) + 1);
				const before = this.#latestDefinedPosition(reviewer.key);

				const unseen = this.#collectUnseenContext(reviewer.key, roundNum);
				const peerItems = this.#annotatedPeerItems(reviewer.key);
				// stances count only on peer items; challenges to the speaker's own items are answered via revisions
				const promptedItemIds = peerItems.map(i => i.id);
				const notes = [
					...unseen.userEntries.map(u => (u.targetLabel ? `[To ${u.targetLabel}]: ${u.text}` : u.text)),
					...unseen.operatorReaderEntries.map(r => `[Operator → Reader]: ${r.question}\n[Reader]: ${r.answer}`),
				];
				const promptText = renderDebateRebuttal({
					round: roundNum,
					peerCritiques: unseen.peerTurns.map(e => ({
						reviewerLabel: e.reviewerLabel,
						critiqueText: e.text,
						round: e.round,
						kind: e.kind,
					})),
					peerItems,
					ownDisputes: this.#ownDisputes(reviewer.key),
					roundtable: {
						speaker: step,
						peerHandles: this.#activeReviewers.filter(r => r.key !== reviewer.key).map(r => `@${r.model.id}`),
					},
					operatorNotes: notes.length > 0 ? notes.join("\n\n") : undefined,
					hasCodeReader: Boolean(this.#codeReader),
				});

				let history = this.#histories.get(reviewer.key);
				if (!history) {
					history = [];
					this.#histories.set(reviewer.key, history);
					// a newly joined reviewer starts from the Round 1 plan prompt
					history.push(createUserMessage(this.#renderInitialPlanPrompt()));
				}

				if (this.#roundAbortController === controller) {
					this.#activeSpeaker = {
						reviewerKey: reviewer.key,
						modelId: reviewer.model.id,
						label: reviewer.label,
						kind: "rebuttal",
						step,
					};
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
					roundtableTurn: { step },
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
				// a failed or aborted turn leaves everything unseen so the retry delivers it again
				if (entry.status === "done") {
					this.#markSeen(reviewer.key, [...unseen.consumedPeerIds, ...unseen.consumedOperatorIds]);
					// a queued message every addressee has now read in a debate turn needs no reply pass
					this.#pendingAsks = this.#pendingAsks.filter(
						p => p.kind === "reader" || p.reviewers.some(r => !this.#seenSet(r.key).has(p.userEntry.id)),
					);
					this.#enqueueReactions(queue, reviewer, before, entry, turnsStarted);
				}
			}
		} finally {
			this.#endRound(controller);
			this.#emitChange();
			this.#afterRound();
		}
	}

	/**
	 * parse an operator message without sending it: a leading `@model` targets one reviewer (exact model id or key,
	 * else a unique substring) and `@reader`/`@scout` the codebase reader; otherwise the default target applies
	 */
	resolveAskTarget(rawInput: string, defaultTargetKey?: string): { text: string; target?: ReviewerMember; reader: boolean } {
		const match = rawInput.match(/^@([a-zA-Z0-9_\-./]+)\s*(.*)$/s);
		let target: ReviewerMember | undefined;
		let text = rawInput.trim();
		let reader = false;

		const allKnownReviewers = [...this.#availableReviewers];
		for (const r of this.#activeReviewers) {
			if (!allKnownReviewers.some(k => k.key === r.key)) {
				allKnownReviewers.push(r);
			}
		}

		if (match) {
			const token = match[1].toLowerCase();
			text = match[2].trim();
			if (!text) {
				throw new Error("Please provide a question or comment following the @mention.");
			}

			// Exact match first
			const exact = allKnownReviewers.find(
				r => r.model.id.toLowerCase() === token || r.key.toLowerCase() === token,
			);

			if (exact) {
				target = exact;
			} else if (token === "reader" || token === "scout") {
				reader = true;
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
				target = candidates[0];
			}
		} else if (defaultTargetKey === READER_TARGET_KEY) {
			reader = true;
		} else if (defaultTargetKey) {
			target = allKnownReviewers.find(r => r.key === defaultTargetKey);
		}

		if (!text) {
			throw new Error("Please enter a question or comment.");
		}
		if (reader && !this.#codeReader) {
			throw new Error("Codebase reader is disabled or unavailable.");
		}
		return { text, target, reader };
	}

	/**
	 * answer an operator message now when the council is idle; otherwise queue it until the running round or auto
	 * run ends. Meanwhile debate turns receive it as Operator Guidance, and an `@model` message gives that reviewer
	 * the next debate turn.
	 */
	async askCouncil(rawInput: string, defaultTargetKey?: string): Promise<AskCouncilResult> {
		const ask = this.resolveAskTarget(rawInput, defaultTargetKey);
		if (ask.reader) {
			if (this.isActive()) {
				this.#pendingAsks.push({ kind: "reader", question: ask.text });
				this.#emitChange();
				return { status: "queued" };
			}
			await this.#askCodeReader(ask.text);
			return { status: "answered" };
		}

		const reviewers = ask.target ? [ask.target] : [...this.#activeReviewers];
		if (reviewers.length === 0) {
			throw new Error("No reviewers available to answer.");
		}

		const userEntry: CouncilTurnEntry & { kind: "user" } = {
			id: crypto.randomUUID(),
			kind: "user",
			round: this.#round,
			targetReviewerKey: ask.target?.key,
			targetLabel: ask.target?.label,
			text: ask.text,
			createdAt: Date.now(),
		};
		this.#entries.push(userEntry);
		const queued = this.isActive();
		if (queued) {
			this.#pendingAsks.push({ kind: "ask", userEntry, reviewers, preempted: false });
		}
		this.#emitChange();
		if (queued) {
			return { status: "queued", target: ask.target };
		}
		await this.#runOperatorPass(userEntry, reviewers);
		return { status: "answered" };
	}

	/**
	 * the addressed reviewers answer one at a time in the given order, each seeing the answers before its own;
	 * replies report only when something changed, so a missing report is not forced
	 */
	async #runOperatorPass(
		userEntry: CouncilTurnEntry & { kind: "user" },
		reviewers: readonly ReviewerMember[],
	): Promise<void> {
		const controller = this.#beginRound();
		this.#emitChange();
		try {
			for (let i = 0; i < reviewers.length; i++) {
				if (controller.signal.aborted) break;
				const reviewer = reviewers[i];
				// the current round delivers every earlier answer in this pass, not only the latest per peer
				const unseen = this.#collectUnseenContext(reviewer.key, this.#round);
				const peerItems = this.#peerItems(reviewer.key);
				const promptedItemIds = peerItems.map(item => item.id);
				const promptText = renderUserFollowup({
					userMessage: userEntry.text,
					peerUpdates: unseen.peerTurns.map(e => ({
						reviewerLabel: `${e.reviewerLabel} · Round ${e.round} ${e.kind}`,
						updateText: e.text,
					})),
					peerItems,
					roundtable: reviewers.length > 1 ? { speaker: i + 1, total: reviewers.length } : undefined,
				});

				let history = this.#histories.get(reviewer.key);
				if (!history) {
					history = [];
					this.#histories.set(reviewer.key, history);
					history.push(createUserMessage(this.#renderInitialPlanPrompt()));
				}

				if (this.#roundAbortController === controller) {
					this.#activeSpeaker = {
						reviewerKey: reviewer.key,
						modelId: reviewer.model.id,
						label: reviewer.label,
						kind: "reply",
						step: i + 1,
					};
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
				await this.#runReviewerTurn({
					reviewer,
					entry,
					signal: controller.signal,
					baseMessages: history,
					promptText,
					promptedItemIds,
					forcePosition: false,
				});
				// earlier operator questions to other reviewers and reader answers wait for this reviewer's next debate turn
				if (entry.status === "done") {
					this.#markSeen(reviewer.key, [userEntry.id, ...unseen.consumedPeerIds]);
				}
			}
		} finally {
			this.#endRound(controller);
			this.#emitChange();
			this.#afterRound();
		}
	}

	/** once the council is idle, answer queued operator messages; an auto run's stages leave them to its end */
	#afterRound(): void {
		if (this.#busy || this.isActive() || this.#disposed || this.#draining || this.#pendingAsks.length === 0) return;
		void this.#drainPendingAsks();
	}

	async #drainPendingAsks(): Promise<void> {
		this.#draining = true;
		try {
			while (!this.isActive() && !this.#disposed) {
				const next = this.#pendingAsks.shift();
				if (!next) break;
				try {
					if (next.kind === "reader") {
						await this.#askCodeReader(next.question);
					} else {
						// reviewers a debate turn already delivered the message to need no reply
						const left = next.reviewers.filter(r => !this.#seenSet(r.key).has(next.userEntry.id));
						if (left.length > 0) await this.#runOperatorPass(next.userEntry, left);
					}
				} catch {
					// the reader or reply entry records the failure; later messages still get answered
				}
			}
		} finally {
			this.#draining = false;
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

		// the reader abandons a silent or overlong query itself, so waiting in its queue never times out here
		try {
			const result = await reader.query({
				requesterLabel: readerEntry.requesterLabel,
				question,
				signal: controller.signal,
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
				readerEntry.errorMessage = err instanceof Error ? err.message : String(err);
			}
		} finally {
			readerEntry.activeTool = undefined;
			readerEntry.finishedAt = Date.now();
			this.#endRound(controller);
			this.#emitChange();
			this.#afterRound();
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
		// a turn may run as long as it keeps making progress; it is abandoned only when the model goes silent
		const stall = new StallTimer(this.#modelStallMs);
		const combinedSignal = AbortSignal.any([turn.signal, stall.signal]);
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
					stall.touch();
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
						onActivity: () => stall.touch(),
					});
					// abortActiveRound marks streaming entries aborted while a report follow-up runs
					if (entry.status === "streaming") {
						const rawPosition = report.position ?? fallbackPosition;
						if (rawPosition) {
							// the previous IDs and the sequence are read and advanced with no await in between
							const prior = this.#latestDefinedPosition(reviewer.key);
							const startSeq = this.#nextRevisionNumber.get(reviewer.key) ?? 1;
							const stabilized = stabilizeRevisionIds(reviewer.key, rawPosition.revisions, prior?.revisions ?? [], startSeq);
							entry.position = { ...rawPosition, revisions: stabilized.revisions };
							this.#nextRevisionNumber.set(reviewer.key, stabilized.nextNumber);
							if (prior) entry.positionDelta = computePositionDelta(prior, entry.position);
						}
						entry.status = "done";
						if (entry.position?.operatorQuestion) this.#questionReportedAt.set(entry.id, this.#entries.length);
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
					// the reader enforces its own inactivity limit, so queueing behind other reviewers is not a stall
					stall.pause();
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
						stall.touch();
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
			stall.dispose();
			if (entry.status === "aborted" && stall.stalled && !turn.signal.aborted) {
				entry.status = "error";
				entry.errorMessage = `Stalled: no response from ${reviewer.model.id} for ${Math.round(this.#modelStallMs / 1000)}s`;
			}
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

		// long syntheses are fine while they stream; only a silent synthesizer is abandoned
		const stall = new StallTimer(this.#modelStallMs);
		const combinedSignal = AbortSignal.any([controller.signal, stall.signal]);

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
				stall.touch();
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
			stall.dispose();
			if (entry.status === "aborted" && stall.stalled && !controller.signal.aborted) {
				entry.status = "error";
				entry.errorMessage = `Stalled: no response from ${synthesizerModel.id} for ${Math.round(this.#modelStallMs / 1000)}s`;
			}
			entry.finishedAt = Date.now();
			this.#endRound(controller);
			this.#emitChange();
			this.#afterRound();
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
		request: { signal: AbortSignal; apiKey: ApiKey | undefined; force: boolean; onActivity: () => void },
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
				request.onActivity();
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

	/** newest reported position, skipping completed turns that failed to report; the base for revision ID reuse */
	#latestDefinedPosition(reviewerKey: string): ReviewerPosition | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			const e = this.#entries[i];
			if (isReviewerTurnEntry(e) && e.reviewerKey === reviewerKey && e.status === "done" && e.position) {
				return e.position;
			}
		}
		return undefined;
	}

	/** required revisions currently held by every other active reviewer, in roster order */
	#peerItems(reviewerKey: string): RevisionItem[] {
		return this.#activeReviewers
			.filter(r => r.key !== reviewerKey)
			.flatMap(r => this.#latestPosition(r.key)?.revisions ?? []);
	}

	#seenSet(reviewerKey: string): Set<string> {
		let seen = this.#seenEntryIds.get(reviewerKey);
		if (!seen) {
			seen = new Set();
			this.#seenEntryIds.set(reviewerKey, seen);
		}
		return seen;
	}

	#markSeen(reviewerKey: string, ids: readonly string[]): void {
		const seen = this.#seenSet(reviewerKey);
		for (const id of ids) seen.add(id);
	}

	/**
	 * what the reviewer has not yet been shown: every unseen peer critique, per peer at most the latest unseen
	 * earlier-round rebuttal and the latest unseen earlier-round reply (bounded replay), every unseen current-round
	 * turn, and unseen operator messages and reader answers
	 */
	#collectUnseenContext(reviewerKey: string, currentRound?: number): UnseenContext {
		const seen = this.#seenSet(reviewerKey);
		const consumedPeerIds: string[] = [];
		const deliver = new Set<ReviewerTurnEntry>();
		const latestRebuttal = new Map<string, ReviewerTurnEntry>();
		const latestReply = new Map<string, ReviewerTurnEntry>();
		for (const e of this.#entries) {
			if (!isReviewerTurnEntry(e) || e.reviewerKey === reviewerKey || e.status !== "done" || seen.has(e.id)) continue;
			consumedPeerIds.push(e.id);
			// a tool-only turn has nothing to read and must not displace an earlier substantive one
			if (e.text.trim() === "") continue;
			if (e.kind === "critique" || (currentRound !== undefined && e.round === currentRound)) {
				deliver.add(e);
			} else if (e.kind === "rebuttal") {
				latestRebuttal.set(e.reviewerKey, e);
			} else {
				latestReply.set(e.reviewerKey, e);
			}
		}
		for (const e of latestRebuttal.values()) deliver.add(e);
		for (const e of latestReply.values()) deliver.add(e);

		const peerTurns = this.#entries.filter((e): e is ReviewerTurnEntry => isReviewerTurnEntry(e) && deliver.has(e));
		const userEntries = this.#entries.filter(
			(e): e is CouncilTurnEntry & { kind: "user" } => e.kind === "user" && !seen.has(e.id),
		);
		const operatorReaderEntries = this.#readerEntries.filter(
			r => r.requesterKind === "operator" && r.status === "done" && !seen.has(r.id),
		);
		return {
			peerTurns,
			userEntries,
			operatorReaderEntries,
			consumedPeerIds,
			consumedOperatorIds: [...userEntries.map(u => u.id), ...operatorReaderEntries.map(r => r.id)],
		};
	}

	#hasUnseenOperatorInput(reviewerKey: string): boolean {
		return this.#collectUnseenContext(reviewerKey).consumedOperatorIds.length > 0;
	}

	/** active peers' current disputes of the reviewer's own current revisions */
	#ownDisputes(reviewerKey: string): OwnDisputeItem[] {
		const ownItems = this.#latestPosition(reviewerKey)?.revisions ?? [];
		if (ownItems.length === 0) return [];
		const disputes: OwnDisputeItem[] = [];
		for (const peer of this.#activeReviewers) {
			if (peer.key === reviewerKey) continue;
			const peerPos = this.#latestPosition(peer.key);
			if (!peerPos) continue;
			for (const item of ownItems) {
				// the first stance on an ID counts, as in computeConvergence
				const stance = peerPos.positions.find(p => p.id === item.id);
				if (peerPos.promptedItemIds.includes(item.id) && stance?.stance === "dispute") {
					disputes.push({ id: item.id, summary: item.summary, by: peer.label, reason: stance.reason });
				}
			}
		}
		return disputes;
	}

	/** #peerItems, each annotated with disputes from reviewers other than its owner and the prompted reviewer */
	#annotatedPeerItems(reviewerKey: string): PeerRevisionPromptItem[] {
		const positions = new Map(this.#activeReviewers.map(r => [r.key, this.#latestPosition(r.key)]));
		const items: PeerRevisionPromptItem[] = [];
		for (const owner of this.#activeReviewers) {
			if (owner.key === reviewerKey) continue;
			for (const item of positions.get(owner.key)?.revisions ?? []) {
				const disputes: { by: string; reason: string }[] = [];
				for (const peer of this.#activeReviewers) {
					if (peer.key === reviewerKey || peer.key === owner.key) continue;
					const peerPos = positions.get(peer.key);
					const stance = peerPos?.positions.find(p => p.id === item.id);
					if (peerPos?.promptedItemIds.includes(item.id) && stance?.stance === "dispute") {
						disputes.push({ by: peer.label, reason: stance.reason });
					}
				}
				items.push(disputes.length > 0 ? { ...item, disputes } : item);
			}
		}
		return items;
	}

	/**
	 * contested authors defend, narrow, or retract before their challengers speak; with nothing disputed, reviewers
	 * holding fewer revisions examine the others' proposals before those authors speak. Ties keep roster order.
	 */
	#orderDebateSpeakers(): ReviewerMember[] {
		const initial = this.getConvergence();
		const score =
			initial.disputes.length > 0
				? (r: ReviewerMember) => -initial.disputes.filter(d => d.id.startsWith(`${r.key}#`)).length
				: (r: ReviewerMember) => this.#latestPosition(r.key)?.revisions.length ?? 0;
		const scores = new Map(this.#activeReviewers.map(r => [r.key, score(r)]));
		// Array#sort is stable, so equal scores stay in roster order
		return [...this.#activeReviewers].sort((a, b) => (scores.get(a.key) ?? 0) - (scores.get(b.key) ?? 0));
	}

	/** the reviewer a queued `@model` message names, once per message, while that reviewer has not read it */
	#operatorPreemptedSpeaker(): ReviewerMember | undefined {
		for (const ask of this.#pendingAsks) {
			if (ask.kind !== "ask" || ask.preempted || ask.reviewers.length !== 1) continue;
			const target = this.#activeReviewers.find(r => r.key === ask.reviewers[0].key);
			if (!target || this.#seenSet(target.key).has(ask.userEntry.id)) continue;
			ask.preempted = true;
			return target;
		}
		return undefined;
	}

	/**
	 * route the floor after a completed debate turn: the peer the speaker named in `nextSpeaker`, then the authors of
	 * items it disputes, speak next; when it reported new wording, peers who already spoke are re-queued last to
	 * confirm it. Only reviewers under MAX_ROUNDTABLE_TURNS_PER_REVIEWER this round are added.
	 */
	#enqueueReactions(
		queue: ReviewerMember[],
		speaker: ReviewerMember,
		before: ReviewerPosition | undefined,
		entry: ReviewerTurnEntry,
		turnsStarted: ReadonlyMap<string, number>,
	): void {
		const position = entry.position;
		if (!position) return;
		const canSpeak = (r: ReviewerMember) =>
			r.key !== speaker.key && (turnsStarted.get(r.key) ?? 0) < MAX_ROUNDTABLE_TURNS_PER_REVIEWER;
		const front: ReviewerMember[] = [];

		const handoff = position.nextSpeaker ? this.#matchPeerHandle(position.nextSpeaker, speaker.key) : undefined;
		if (handoff && canSpeak(handoff)) front.push(handoff);

		const disputedIds = position.positions.filter(p => p.stance === "dispute").map(p => p.id);
		for (const owner of this.#activeReviewers) {
			if (!canSpeak(owner) || front.some(f => f.key === owner.key)) continue;
			const held = this.#latestPosition(owner.key)?.revisions ?? [];
			if (disputedIds.some(id => id.startsWith(`${owner.key}#`) && held.some(item => item.id === id))) {
				front.push(owner);
			}
		}

		const priorIds = new Set(before?.revisions.map(r => r.id));
		if (position.revisions.some(r => !priorIds.has(r.id))) {
			// peers still queued will see the new item on their turn anyway
			for (const peer of this.#activeReviewers) {
				if (
					(turnsStarted.get(peer.key) ?? 0) > 0 &&
					canSpeak(peer) &&
					!queue.some(q => q.key === peer.key) &&
					!front.some(f => f.key === peer.key)
				) {
					queue.push(peer);
				}
			}
		}

		for (const r of front) {
			const at = queue.findIndex(q => q.key === r.key);
			if (at !== -1) queue.splice(at, 1);
		}
		queue.unshift(...front);
	}

	/** the active peer a `nextSpeaker` handle names: exact model id or key, else a unique substring match */
	#matchPeerHandle(handle: string, speakerKey: string): ReviewerMember | undefined {
		const token = handle.toLowerCase();
		const peers = this.#activeReviewers.filter(r => r.key !== speakerKey);
		const exact = peers.find(r => r.model.id.toLowerCase() === token || r.key.toLowerCase() === token);
		if (exact) return exact;
		const candidates = peers.filter(r => r.model.id.toLowerCase().includes(token) || r.key.toLowerCase().includes(token));
		return candidates.length === 1 ? candidates[0] : undefined;
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

	/**
	 * per active reviewer, the operator question in its newest reported position, unless an operator message to the
	 * council or to that reviewer came after it
	 */
	getOpenOperatorQuestions(): OpenOperatorQuestion[] {
		const open: OpenOperatorQuestion[] = [];
		for (const reviewer of this.#activeReviewers) {
			const index = this.#entries.findLastIndex(
				e => isReviewerTurnEntry(e) && e.reviewerKey === reviewer.key && e.status === "done" && e.position !== undefined,
			);
			const entry = this.#entries[index];
			if (!entry || !isReviewerTurnEntry(entry)) continue;
			const question = entry.position?.operatorQuestion;
			if (!question) continue;
			const answered = this.#entries
				.slice(this.#questionReportedAt.get(entry.id) ?? index + 1)
				.some(e => e.kind === "user" && (e.targetReviewerKey === undefined || e.targetReviewerKey === reviewer.key));
			if (!answered) {
				open.push({ reviewerKey: reviewer.key, reviewerLabel: reviewer.label, question, entryId: entry.id });
			}
		}
		return open;
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
			// synthesis needs a finished critique: say why the run ends here instead of failing on an empty council
			if (!run.stopped && this.#completedReviewerCount() === 0) {
				throw new Error("No reviewer finished Round 1 (see the Council tab) — press r to retry.");
			}
			if (!run.stopped) this.#pauseForOperatorQuestions();

			const maxDebateRounds = options.maxDebateRounds ?? 3;
			if (options.autoDebate !== false) {
				if (!this.approvedUnanimously()) {
					// a run resumed after a pause counts the debate rounds already held
					const remaining = Math.max(0, maxDebateRounds - Math.max(0, this.#round - 1));
					for (let i = 0; i < remaining; i++) {
						if (this.#completedReviewerCount() < 2) break;
						stage(`Round ${this.#round + 1} Debate`);
						await this.runDebateRound();
						if (!run.stopped) this.#pauseForOperatorQuestions();
						if (this.getConvergence().converged) break;
					}
				}
			}

			stage("Synthesizing Consensus");
			return await this.synthesizeFeedback(synthesizerModel, options.synthesizerThinkingLevel);
		} finally {
			if (this.#autoRun === run) this.#autoRun = undefined;
			this.#emitChange();
			this.#afterRound();
		}
	}

	/** stop an auto run on reviewer questions it has not yet paused on, so the operator can answer them */
	#pauseForOperatorQuestions(): void {
		const open = this.getOpenOperatorQuestions().filter(q => !this.#pausedQuestionIds.has(q.entryId));
		if (open.length === 0) return;
		for (const q of open) this.#pausedQuestionIds.add(q.entryId);
		throw new OperatorQuestionPending(open);
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
		this.#activeSpeaker = undefined;
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
		// unsent messages stay in the transcript; any later turn still delivers them as unseen input
		this.#pendingAsks = [];
		this.#busy = false;
		this.#activeSpeaker = undefined;
		this.#emitChange();
	}

	dispose(): void {
		this.#disposed = true;
		this.abortActiveRound();
		void this.#codeReader?.dispose();
		this.#listeners.clear();
	}
}
