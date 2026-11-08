import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { CouncilCodeReader, type ReaderSessionHandle } from "../src/code-reader";

type FakeMessage = { role: string; content?: unknown; stopReason?: string; errorMessage?: string };
/** what the fake model does for one prompt: the messages it appends and the session events it emits */
type FakeTurn = { messages?: FakeMessage[]; events?: unknown[]; hang?: boolean };

const readerModel = { id: "smol-reader", provider: "test" } as unknown as Model;

function assistant(text: string, stopReason = "stop", errorMessage?: string): FakeMessage {
	return { role: "assistant", stopReason, errorMessage, content: text ? [{ type: "text", text }] : [] };
}

interface FakeSessions {
	createSession: () => Promise<ReaderSessionHandle>;
	prompts: string[];
	stats: { created: number; aborts: number; beginDispose: number; disposed: number };
	/** resolves once the session has received `count` prompts */
	prompted: (count: number) => Promise<void>;
	/** settle the oldest hanging turn with its scripted messages */
	release: () => void;
}

/** a fake AgentSession: each prompt appends the scripted turn; hanging turns settle as aborted on abort() */
function makeFakeSessions(script: (prompt: string, index: number) => FakeTurn): FakeSessions {
	const prompts: string[] = [];
	const stats = { created: 0, aborts: 0, beginDispose: 0, disposed: 0 };
	const gates: Array<() => void> = [];
	const promptWaiters: Array<{ count: number; resolve: () => void }> = [];
	const createSession = async (): Promise<ReaderSessionHandle> => {
		stats.created++;
		const messages: FakeMessage[] = [{ role: "user", content: "earlier" }, assistant("stale answer from before")];
		const listeners = new Set<(event: unknown) => void>();
		let pendingAbort: (() => void) | undefined;
		return {
			state: { messages },
			subscribe: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			abort: async () => {
				stats.aborts++;
				pendingAbort?.();
			},
			beginDispose: () => {
				stats.beginDispose++;
			},
			dispose: async () => {
				stats.disposed++;
			},
			prompt: async text => {
				const index = prompts.length;
				prompts.push(text);
				for (const waiter of promptWaiters.filter(w => prompts.length >= w.count)) {
					promptWaiters.splice(promptWaiters.indexOf(waiter), 1);
					waiter.resolve();
				}
				messages.push({ role: "user", content: text });
				const turn = script(text, index);
				if (turn.hang) {
					const { promise, resolve } = Promise.withResolvers<void>();
					pendingAbort = () => {
						messages.push(assistant("", "aborted"));
						resolve();
					};
					gates.push(() => {
						messages.push(...(turn.messages ?? []));
						resolve();
					});
					await promise;
					pendingAbort = undefined;
					return true;
				}
				for (const event of turn.events ?? []) {
					for (const listener of listeners) listener(event);
				}
				messages.push(...(turn.messages ?? []));
				return true;
			},
		};
	};

	return {
		createSession,
		prompts,
		stats,
		prompted: count => {
			if (prompts.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			promptWaiters.push({ count, resolve });
			return promise;
		},
		release: () => gates.shift()?.(),
	};
}

function newReader(fake: FakeSessions, limits: { queryStallMs?: number; queryMaxMs?: number } = {}): CouncilCodeReader {
	return new CouncilCodeReader({
		cwd: process.cwd(),
		model: readerModel,
		planTitle: "Reader Plan",
		planFilePath: "plan.md",
		...limits,
		createSession: fake.createSession,
	});
}

/**
 * a reader session that reports a tool call every `everyMs` until it answers after `answerAfterMs` or is aborted;
 * real timers, because the reader's limits run on the platform clock (AbortSignal.timeout), which fake timers do not drive
 */
function busySession(answerAfterMs: number, everyMs: number): FakeSessions {
	const stats = { created: 0, aborts: 0, beginDispose: 0, disposed: 0 };
	const createSession = async (): Promise<ReaderSessionHandle> => {
		stats.created++;
		const messages: FakeMessage[] = [];
		const listeners = new Set<(event: unknown) => void>();
		let abort: (() => void) | undefined;
		return {
			state: { messages },
			subscribe: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			abort: async () => {
				stats.aborts++;
				abort?.();
			},
			dispose: async () => {
				stats.disposed++;
			},
			prompt: async () => {
				const { promise, resolve } = Promise.withResolvers<FakeMessage>();
				const ticker = setInterval(() => {
					for (const listener of listeners) listener({ type: "tool_execution_start", toolName: "grep" });
				}, everyMs);
				const done = setTimeout(() => resolve(assistant("found it after a long search")), answerAfterMs);
				abort = () => resolve(assistant("", "aborted"));
				messages.push(await promise);
				clearInterval(ticker);
				clearTimeout(done);
				return true;
			},
		};
	};
	return { createSession, prompts: [], stats, prompted: () => Promise.resolve(), release: () => {} };
}

describe("CouncilCodeReader", () => {
	it("creates its session on the first query and reuses it for later queries", async () => {
		const fake = makeFakeSessions((_prompt, i) => ({ messages: [assistant(`answer ${i}`)] }));
		const reader = newReader(fake);
		expect(fake.stats.created).toBe(0);

		expect(await reader.query({ requesterLabel: "A", question: "first?" })).toEqual({ answer: "answer 0", cached: false });
		expect(await reader.query({ requesterLabel: "B", question: "second?" })).toEqual({ answer: "answer 1", cached: false });
		expect(fake.stats.created).toBe(1);
		expect(fake.prompts).toHaveLength(2);
	});

	it("answers repeated questions from cache regardless of whitespace and path order", async () => {
		const fake = makeFakeSessions(() => ({ messages: [assistant("`src/a.ts:10` defines foo")] }));
		const reader = newReader(fake);

		await reader.query({ requesterLabel: "A", question: "Where  is\nfoo {{bar}}?", paths: ["src/b.ts", "src/a.ts"] });
		const deltas: string[] = [];
		const repeat = await reader.query({
			requesterLabel: "B",
			question: "  Where is foo {{bar}}? ",
			paths: ["src/a.ts", " src/b.ts ", "src/a.ts", ""],
			onTextDelta: (_delta, snapshot) => deltas.push(snapshot),
		});

		expect(repeat).toEqual({ answer: "`src/a.ts:10` defines foo", cached: true });
		expect(deltas).toEqual(["`src/a.ts:10` defines foo"]);
		expect(fake.prompts).toHaveLength(1);
		// the question reaches the model verbatim, template-like braces included
		expect(fake.prompts[0]).toContain("[From A]");
		expect(fake.prompts[0]).toContain("Priority paths: src/b.ts, src/a.ts");
		expect(fake.prompts[0]).toContain("Where  is\nfoo {{bar}}?");

		// a different path set is a different question
		await reader.query({ requesterLabel: "C", question: "Where is foo {{bar}}?", paths: ["src/a.ts"] });
		expect(fake.prompts).toHaveLength(2);
	});

	it("coalesces concurrent identical queries and keeps serving waiters that did not abort", async () => {
		const fake = makeFakeSessions(() => ({ hang: true, messages: [assistant("shared answer")] }));
		const reader = newReader(fake);

		const first = new AbortController();
		const a = reader.query({ requesterLabel: "A", question: "callers of foo?", signal: first.signal });
		const statuses: string[] = [];
		const b = reader.query({ requesterLabel: "B", question: "callers of  foo?", onStatusChange: s => statuses.push(s) });
		await fake.prompted(1);

		first.abort();
		await expect(a).rejects.toThrow("Aborted");
		fake.release();
		expect(await b).toEqual({ answer: "shared answer", cached: true });
		expect(statuses).toEqual(["reading"]);
		expect(fake.prompts).toHaveLength(1);
		expect(fake.stats.aborts).toBe(0);
	});

	it("aborts the running turn only when every waiter aborted, and starts identical later queries fresh", async () => {
		const fake = makeFakeSessions((_prompt, i) => (i === 0 ? { hang: true } : { messages: [assistant("fresh answer")] }));
		const reader = newReader(fake);

		const one = new AbortController();
		const two = new AbortController();
		const a = reader.query({ requesterLabel: "A", question: "q?", signal: one.signal });
		const b = reader.query({ requesterLabel: "B", question: "q?", signal: two.signal });
		await fake.prompted(1);
		one.abort();
		expect(fake.stats.aborts).toBe(0);
		two.abort();

		await expect(a).rejects.toThrow("Aborted");
		await expect(b).rejects.toThrow("Aborted");
		expect(fake.stats.aborts).toBe(1);
		expect(await reader.query({ requesterLabel: "C", question: "q?" })).toEqual({ answer: "fresh answer", cached: false });
	});

	it("drops a queued query whose waiters all aborted without touching the session", async () => {
		const fake = makeFakeSessions((_prompt, i) => (i === 0 ? { hang: true, messages: [assistant("first")] } : { messages: [assistant("third")] }));
		const reader = newReader(fake);

		const first = reader.query({ requesterLabel: "A", question: "first?" });
		const queued = new AbortController();
		const second = reader.query({ requesterLabel: "B", question: "second?", signal: queued.signal });
		const third = reader.query({ requesterLabel: "C", question: "third?" });
		await fake.prompted(1);
		queued.abort();
		await expect(second).rejects.toThrow("Aborted");

		fake.release();
		expect((await first).answer).toBe("first");
		expect((await third).answer).toBe("third");
		expect(fake.prompts.map(p => p.split("\n")[0])).toEqual(["[From A]", "[From C]"]);
		expect(fake.stats.aborts).toBe(0);
	});

	it("runs distinct queries one at a time in arrival order and reads only each turn's own reply", async () => {
		const fake = makeFakeSessions((_prompt, i) => {
			if (i === 0) return { hang: true, messages: [assistant("first answer")] };
			if (i === 1) return { messages: [assistant("", "error", "rate limited")] };
			// a turn that produced no text must not surface an earlier turn's answer
			return { messages: [assistant("")] };
		});
		const reader = newReader(fake);

		const statuses: string[] = [];
		const first = reader.query({ requesterLabel: "A", question: "one?" });
		const second = reader.query({ requesterLabel: "B", question: "two?", onStatusChange: s => statuses.push(s) });
		const third = reader.query({ requesterLabel: "C", question: "three?" });
		await fake.prompted(1);
		expect(fake.prompts).toHaveLength(1);
		expect(statuses).toEqual(["queued"]);

		fake.release();
		expect(await first).toEqual({ answer: "first answer", cached: false });
		await expect(second).rejects.toThrow("rate limited");
		expect(await third).toEqual({ answer: "(No relevant codebase findings returned.)", cached: false });
		expect(statuses).toEqual(["queued", "reading"]);
		expect(fake.prompts.map(p => p.split("\n")[0])).toEqual(["[From A]", "[From B]", "[From C]"]);

		// failed and empty answers are not cached
		await expect(reader.query({ requesterLabel: "B", question: "two?" })).resolves.toEqual({
			answer: "(No relevant codebase findings returned.)",
			cached: false,
		});
	});

	it("streams text across tool steps as separate paragraphs and reports tool activity", async () => {
		const events = [
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Searching." } },
			{ type: "tool_execution_start", toolName: "grep" },
			{ type: "message_start", message: { role: "assistant" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it" } },
			{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " in src/a.ts." } },
		];
		const fake = makeFakeSessions(() => ({ events, messages: [assistant("Searching."), assistant("Found it in src/a.ts.")] }));
		const reader = newReader(fake);

		const snapshots: string[] = [];
		const tools: string[] = [];
		const result = await reader.query({
			requesterLabel: "A",
			question: "where?",
			onTextDelta: (_delta, snapshot) => snapshots.push(snapshot),
			onToolActivity: tool => tools.push(tool),
		});

		expect(snapshots.at(-1)).toBe("Searching.\n\nFound it in src/a.ts.");
		expect(tools).toEqual(["grep"]);
		// the final answer is the last assistant message, not the narration before tool calls
		expect(result.answer).toBe("Found it in src/a.ts.");
	});

	it("abandons a query whose session goes silent, aborting the session turn", async () => {
		const fake = makeFakeSessions(() => ({ hang: true }));
		// the limits run on the platform clock, which fake timers do not drive
		const reader = newReader(fake, { queryStallMs: 20 });

		await expect(reader.query({ requesterLabel: "A", question: "slow?" })).rejects.toThrow("stalled");
		expect(fake.stats.aborts).toBe(1);
	});

	it("lets a query that keeps reporting activity run past the stall window", async () => {
		const reader = newReader(busySession(120, 10), { queryStallMs: 40 });
		expect(await reader.query({ requesterLabel: "A", question: "deep search?" })).toEqual({
			answer: "found it after a long search",
			cached: false,
		});
	});

	it("stops a query that stays busy past the per-query ceiling", async () => {
		const fake = busySession(10_000, 10);
		const reader = newReader(fake, { queryStallMs: 40, queryMaxMs: 80 });
		await expect(reader.query({ requesterLabel: "A", question: "endless?" })).rejects.toThrow("exceeded");
		expect(fake.stats.aborts).toBe(1);
	});

	it("dispose rejects pending queries, disposes the session, and refuses new queries", async () => {
		const fake = makeFakeSessions(() => ({ hang: true }));
		const reader = newReader(fake);

		const running = reader.query({ requesterLabel: "A", question: "one?" });
		const queued = reader.query({ requesterLabel: "B", question: "two?" });
		await fake.prompted(1);
		await reader.dispose();

		await expect(running).rejects.toThrow("aborted");
		await expect(queued).rejects.toThrow("aborted");
		expect(fake.stats).toMatchObject({ created: 1, aborts: 1, beginDispose: 1, disposed: 1 });
		await expect(reader.query({ requesterLabel: "C", question: "three?" })).rejects.toThrow(
			"Codebase reader has been disposed.",
		);
	});
});
