import { type, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { AgentRegistry, createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { renderReaderQuery, renderReaderSystem } from "./prompts/render";
import { StallTimer } from "./stall-timer";

export const ASK_CODEBASE_TOOL_NAME = "ask_codebase";

export const askCodebaseSchema = type({
	question: type("string > 0").describe(
		"Focused codebase verification question (symbols, signatures, file paths, line anchors, callers, or edge-case behavior). Batch related checks into one question.",
	),
	"paths?": type("string > 0")
		.array()
		.describe("Optional repo-relative file or directory paths to check first."),
});

export const ASK_CODEBASE_TOOL: Tool = {
	name: ASK_CODEBASE_TOOL_NAME,
	description:
		"Message the council's shared read-only codebase subagent to verify files, symbols, signatures, callers, and tests against the repository before finalizing your review.",
	parameters: askCodebaseSchema,
};

export type CodeReaderStatus = "queued" | "reading";

export interface CodeReaderQueryInput {
	requesterLabel: string;
	question: string;
	paths?: readonly string[];
	signal?: AbortSignal;
	onStatusChange?: (status: CodeReaderStatus) => void;
	onToolActivity?: (toolName: string) => void;
	onTextDelta?: (delta: string, snapshot: string) => void;
}

export interface CodeReaderQueryResult {
	answer: string;
	/** true when the answer came from an earlier or concurrently running identical query */
	cached: boolean;
}

export interface CodebaseReader {
	readonly modelLabel: string;
	query(input: CodeReaderQueryInput): Promise<CodeReaderQueryResult>;
	dispose(): Promise<void> | void;
}

/** the slice of AgentSession the reader drives; tests substitute a fake */
export interface ReaderSessionHandle {
	readonly state: {
		readonly messages: readonly { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }[];
	};
	prompt(
		text: string,
		options?: { expandPromptTemplates?: boolean; runCommands?: boolean; attribution?: "user" | "agent" },
	): Promise<boolean>;
	subscribe(listener: (event: unknown) => void): () => void;
	abort(): Promise<void>;
	beginDispose?(): void;
	dispose(options?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface CouncilCodeReaderOptions {
	cwd: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	planTitle: string;
	planFilePath: string;
	sessionId?: string;
	modelRegistry?: ExtensionContext["modelRegistry"];
	localProtocolOptions?: ExtensionContext["localProtocolOptions"];
	/** a running query is abandoned after this long without any session event (tool call, text); default 120s */
	queryStallMs?: number;
	/** backstop for a query that stays busy but never finishes, counted once dequeued; default 10 min */
	queryMaxMs?: number;
	/** test seam; defaults to an in-memory SDK agent session restricted to read-only tools */
	createSession?: () => Promise<ReaderSessionHandle>;
}

const DEFAULT_QUERY_STALL_MS = 120_000;
const DEFAULT_QUERY_MAX_MS = 600_000;
const NO_FINDINGS_ANSWER = "(No relevant codebase findings returned.)";
const READER_TOOL_NAMES = ["read", "grep", "glob", "find", "ast_grep", "lsp"];

/** trimmed, non-empty, first-occurrence order */
function cleanPaths(paths: readonly string[] | undefined): string[] {
	if (!paths) return [];
	const seen = new Set<string>();
	for (const path of paths) {
		const trimmed = path.trim();
		if (trimmed) seen.add(trimmed);
	}
	return [...seen];
}

/** identical questions (modulo whitespace runs and path order) share one answer */
export function normalizeReaderQueryKey(question: string, paths?: readonly string[]): string {
	const normalizedQuestion = question.trim().replace(/\s+/g, " ");
	const sortedPaths = cleanPaths(paths).sort();
	return JSON.stringify([normalizedQuestion, sortedPaths]);
}

function abortError(): DOMException {
	return new DOMException("Reader query aborted", "AbortError");
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string",
		)
		.map(block => block.text)
		.join("");
}

interface QueryWaiter {
	input: CodeReaderQueryInput;
	aborted: boolean;
	/** the caller that created the execution; coalesced waiters report `cached: true` */
	initiator: boolean;
	resolve: (result: CodeReaderQueryResult) => void;
	reject: (error: unknown) => void;
	detach?: () => void;
}

interface SharedQueryExecution {
	key: string;
	requesterLabel: string;
	question: string;
	paths: string[];
	status: CodeReaderStatus;
	waiters: QueryWaiter[];
	controller: AbortController;
	streamedText: string;
	/** a new assistant step began; its first text is separated from earlier steps' prose */
	stepBoundary: boolean;
	activeTool?: string;
}

/**
 * One persistent read-only subagent per council: queries run one at a time through a FIFO mailbox so the
 * session's already-read files and prompt cache serve every reviewer, and identical questions are answered once.
 */
export class CouncilCodeReader implements CodebaseReader {
	readonly modelLabel: string;
	#options: CouncilCodeReaderOptions;
	#queryStallMs: number;
	#queryMaxMs: number;
	#createSession: () => Promise<ReaderSessionHandle>;
	#sessionPromise?: Promise<ReaderSessionHandle>;
	#cache = new Map<string, string>();
	#inFlight = new Map<string, SharedQueryExecution>();
	#queue: SharedQueryExecution[] = [];
	#running?: SharedQueryExecution;
	#draining = false;
	#disposed = false;

	constructor(options: CouncilCodeReaderOptions) {
		this.#options = options;
		this.modelLabel = `${options.model.id} (${options.model.provider})`;
		this.#queryStallMs = options.queryStallMs ?? DEFAULT_QUERY_STALL_MS;
		this.#queryMaxMs = options.queryMaxMs ?? DEFAULT_QUERY_MAX_MS;
		this.#createSession = options.createSession ?? (() => this.#createDefaultSession());
	}

	query(input: CodeReaderQueryInput): Promise<CodeReaderQueryResult> {
		if (this.#disposed) {
			return Promise.reject(new Error("Codebase reader has been disposed."));
		}
		if (input.signal?.aborted) {
			return Promise.reject(new DOMException("Aborted", "AbortError"));
		}
		const question = input.question.trim();
		if (!question) {
			return Promise.reject(new Error("Reader question must not be empty."));
		}

		const paths = cleanPaths(input.paths);
		const key = normalizeReaderQueryKey(question, paths);
		const cachedAnswer = this.#cache.get(key);
		if (cachedAnswer !== undefined) {
			input.onTextDelta?.(cachedAnswer, cachedAnswer);
			return Promise.resolve({ answer: cachedAnswer, cached: true });
		}

		let exec = this.#inFlight.get(key);
		const initiator = !exec;
		if (!exec) {
			exec = {
				key,
				requesterLabel: input.requesterLabel,
				question,
				paths,
				status: "queued",
				waiters: [],
				controller: new AbortController(),
				streamedText: "",
				stepBoundary: false,
			};
			this.#inFlight.set(key, exec);
			this.#queue.push(exec);
		}

		const { promise, resolve, reject } = Promise.withResolvers<CodeReaderQueryResult>();
		const waiter: QueryWaiter = { input, aborted: false, initiator, resolve, reject };
		exec.waiters.push(waiter);
		const signal = input.signal;
		if (signal) {
			const target = exec;
			const onAbort = () => this.#abortWaiter(target, waiter, new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
			waiter.detach = () => signal.removeEventListener("abort", onAbort);
		}

		input.onStatusChange?.(exec.status);
		// a late joiner sees the shared turn's progress so far
		if (exec.activeTool) input.onToolActivity?.(exec.activeTool);
		if (exec.streamedText) input.onTextDelta?.(exec.streamedText, exec.streamedText);

		if (initiator) void this.#drain();
		return promise;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;

		const pending = [...this.#queue];
		this.#queue = [];
		for (const exec of pending) {
			this.#settle(exec, { error: abortError() });
		}
		this.#running?.controller.abort();
		this.#inFlight.clear();

		const sessionPromise = this.#sessionPromise;
		if (!sessionPromise) return;
		try {
			const session = await sessionPromise;
			session.beginDispose?.();
			await session.dispose({ drainTimeoutMs: 1_000 });
		} catch {
			// teardown is best-effort: a failed creation or dispose leaves nothing to release
		}
	}

	#abortWaiter(exec: SharedQueryExecution, waiter: QueryWaiter, error: unknown): void {
		if (waiter.aborted) return;
		waiter.aborted = true;
		waiter.detach?.();
		waiter.reject(error);
		if (exec.waiters.some(w => !w.aborted)) return;

		// nobody is waiting anymore: drop it, and let a later identical query start fresh
		if (this.#inFlight.get(exec.key) === exec) this.#inFlight.delete(exec.key);
		const queuedIndex = this.#queue.indexOf(exec);
		if (queuedIndex >= 0) {
			this.#queue.splice(queuedIndex, 1);
		} else {
			exec.controller.abort();
		}
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (!this.#disposed) {
				const exec = this.#queue.shift();
				if (!exec) break;
				this.#running = exec;
				try {
					await this.#run(exec);
				} finally {
					this.#running = undefined;
				}
			}
		} finally {
			this.#draining = false;
		}
	}

	#liveWaiters(exec: SharedQueryExecution): QueryWaiter[] {
		return exec.waiters.filter(w => !w.aborted);
	}

	#settle(exec: SharedQueryExecution, outcome: { answer: string } | { error: unknown }): void {
		if (this.#inFlight.get(exec.key) === exec) this.#inFlight.delete(exec.key);
		for (const waiter of this.#liveWaiters(exec)) {
			waiter.aborted = true;
			waiter.detach?.();
			if ("answer" in outcome) {
				waiter.resolve({ answer: outcome.answer, cached: !waiter.initiator });
			} else {
				waiter.reject(outcome.error);
			}
		}
	}

	async #run(exec: SharedQueryExecution): Promise<void> {
		exec.status = "reading";
		for (const waiter of this.#liveWaiters(exec)) waiter.input.onStatusChange?.("reading");

		const stall = new StallTimer(this.#queryStallMs);
		const maxSignal = AbortSignal.timeout(this.#queryMaxMs);
		const signal = AbortSignal.any([exec.controller.signal, stall.signal, maxSignal]);
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;

		try {
			const session = await this.#ensureSession();
			if (signal.aborted) throw abortError();

			const startMessageIndex = session.state.messages.length;
			unsubscribe = session.subscribe(event => {
				stall.touch();
				this.#handleSessionEvent(exec, event);
			});
			onAbort = () => {
				void session.abort().catch(() => {});
			};
			signal.addEventListener("abort", onAbort, { once: true });

			await session.prompt(
				renderReaderQuery({ requesterLabel: exec.requesterLabel, question: exec.question, paths: exec.paths }),
				{ expandPromptTemplates: false, runCommands: false, attribution: "agent" },
			);

			const turnMessages = session.state.messages.slice(startMessageIndex);
			const assistantMessages = turnMessages.filter(m => m.role === "assistant");
			const lastAssistant = assistantMessages.at(-1);
			if (signal.aborted || lastAssistant?.stopReason === "aborted") throw abortError();
			if (lastAssistant?.stopReason === "error") {
				throw new Error(lastAssistant.errorMessage || "Codebase reader model request failed");
			}

			let answer = "";
			for (let i = assistantMessages.length - 1; i >= 0 && !answer; i--) {
				answer = messageText(assistantMessages[i].content).trim();
			}
			if (!answer) answer = exec.streamedText.trim();
			if (answer) {
				this.#cache.set(exec.key, answer);
			} else {
				answer = NO_FINDINGS_ANSWER;
			}
			this.#settle(exec, { answer });
		} catch (err) {
			let error = err;
			if (!exec.controller.signal.aborted && stall.stalled) {
				error = new DOMException(
					`Codebase reader stalled: no activity for ${Math.round(this.#queryStallMs / 1000)}s`,
					"TimeoutError",
				);
			} else if (!exec.controller.signal.aborted && maxSignal.aborted) {
				error = new DOMException(
					`Codebase reader query exceeded ${Math.round(this.#queryMaxMs / 1000)}s`,
					"TimeoutError",
				);
			} else if (signal.aborted) {
				error = abortError();
			}
			this.#settle(exec, { error });
		} finally {
			stall.dispose();
			unsubscribe?.();
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	#handleSessionEvent(exec: SharedQueryExecution, event: unknown): void {
		if (typeof event !== "object" || event === null) return;
		const e = event as {
			type?: string;
			message?: { role?: string };
			assistantMessageEvent?: { type?: string; delta?: unknown };
			toolName?: unknown;
		};

		if (e.type === "message_start" && e.message?.role === "assistant") {
			exec.stepBoundary = true;
			return;
		}

		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			const raw = e.assistantMessageEvent.delta;
			if (typeof raw !== "string" || !raw) return;
			const separator = exec.stepBoundary && exec.streamedText.trim().length > 0 ? "\n\n" : "";
			exec.stepBoundary = false;
			const delta = separator + raw;
			exec.streamedText += delta;
			for (const waiter of this.#liveWaiters(exec)) waiter.input.onTextDelta?.(delta, exec.streamedText);
			return;
		}

		if (e.type === "tool_execution_start" && e.toolName !== undefined) {
			const toolName = String(e.toolName);
			exec.activeTool = toolName;
			for (const waiter of this.#liveWaiters(exec)) waiter.input.onToolActivity?.(toolName);
		}
	}

	#ensureSession(): Promise<ReaderSessionHandle> {
		if (!this.#sessionPromise) {
			const created = this.#createSession();
			this.#sessionPromise = created;
			// a failed creation (e.g. missing credentials) is retried by the next query
			created.catch(() => {
				if (this.#sessionPromise === created) this.#sessionPromise = undefined;
			});
		}
		return this.#sessionPromise;
	}

	async #createDefaultSession(): Promise<ReaderSessionHandle> {
		const options = this.#options;
		const registry = options.modelRegistry;
		const hasFullRegistry = Boolean(registry && "authStorage" in registry && registry.authStorage);
		const { session } = await createAgentSession({
			cwd: options.cwd,
			modelRegistry: hasFullRegistry ? registry : undefined,
			credentialSourceSessionId: options.sessionId,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			// in-memory: the reader must not write session files into the user's session history
			sessionManager: SessionManager.inMemory(options.cwd),
			localProtocolOptions: options.localProtocolOptions,
			// private registry: the global one already holds the host's "Main" agent
			agentRegistry: new AgentRegistry(),
			agentId: `CouncilReader-${crypto.randomUUID().slice(0, 8)}`,
			agentDisplayName: "reader",
			agentName: "scout",
			taskDepth: 1,
			bindProcessState: false,
			hasUI: false,
			autoApprove: true,
			cacheWarming: false,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableIrc: false,
			enableLsp: true,
			lspReadOnly: true,
			skipPythonPreflight: true,
			noContextFiles: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			customTools: [],
			toolNames: [...READER_TOOL_NAMES],
			restrictToolNames: true,
			// append, not replace: the built-in prompt carries the tool and selector instructions
			appendSystemPrompt: renderReaderSystem({
				planTitle: options.planTitle,
				planFilePath: options.planFilePath,
			}).trim(),
		});
		return session;
	}
}
