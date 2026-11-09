import { describe, expect, it } from "bun:test";
import type { CouncilRun, CouncilTurnEntry } from "../src/council-session";
import { buildTranscript, firstProseLine } from "../src/transcript";

describe("buildTranscript", () => {
	it("yields a section for a zero-turn stopped run", () => {
		const stoppedRun: CouncilRun = {
			id: 1,
			kind: "debate",
			round: 2,
			status: "stopped",
			summary: {
				turns: 0,
				converged: false,
				open: 2,
				revisions: 1,
				disputes: [],
				unjudged: 0,
				unreported: [],
			},
		};

		const sections = buildTranscript([stoppedRun], []);
		expect(sections).toHaveLength(1);
		expect(sections[0].run).toBe(stoppedRun);
		expect(sections[0].entries).toEqual([]);
		expect(sections[0].answering).toBeUndefined();
	});

	it("yields its own section for a retry critique run", () => {
		const initialRun: CouncilRun = {
			id: 1,
			kind: "critiques",
			round: 1,
			status: "done",
			summary: {
				turns: 2,
				converged: false,
				open: 1,
				revisions: 1,
				disputes: [],
				unjudged: 0,
				unreported: [],
			},
		};
		const retryRun: CouncilRun = {
			id: 2,
			kind: "critiques",
			round: 1,
			status: "done",
			retry: true,
			summary: {
				turns: 2,
				converged: true,
				open: 0,
				revisions: 1,
				disputes: [],
				unjudged: 0,
				unreported: [],
			},
		};

		const entries: CouncilTurnEntry[] = [
			{
				id: "crit-1",
				kind: "critique",
				round: 1,
				reviewerKey: "anthropic/claude-3-7-sonnet",
				reviewerLabel: "claude-3-7-sonnet",
				status: "done",
				text: "Initial critique",
				startedAt: 100,
				finishedAt: 200,
				runId: 1,
			},
			{
				id: "crit-2",
				kind: "critique",
				round: 1,
				reviewerKey: "anthropic/claude-3-7-sonnet",
				reviewerLabel: "claude-3-7-sonnet",
				status: "done",
				text: "Retry critique",
				startedAt: 300,
				finishedAt: 400,
				runId: 2,
			},
		];

		const sections = buildTranscript([initialRun, retryRun], entries);
		expect(sections).toHaveLength(2);
		expect(sections[0].run).toBe(initialRun);
		expect(sections[0].entries).toHaveLength(1);
		expect(sections[0].entries[0].id).toBe("crit-1");

		expect(sections[1].run).toBe(retryRun);
		expect(sections[1].run.retry).toBe(true);
		expect(sections[1].entries).toHaveLength(1);
		expect(sections[1].entries[0].id).toBe("crit-2");
	});

	it("sets answering on a Q&A run when the user entry has an earlier run's id, but not when it has the Q&A run's id", () => {
		const debateRun: CouncilRun = {
			id: 1,
			kind: "debate",
			round: 2,
			status: "done",
		};
		const qaRunFromEarlier: CouncilRun = {
			id: 2,
			kind: "qa",
			round: 2,
			status: "done",
			userEntryId: "user-queued-during-debate",
		};
		const qaRunDirect: CouncilRun = {
			id: 3,
			kind: "qa",
			round: 2,
			status: "done",
			userEntryId: "user-idle",
		};

		const userQueuedDuringDebate: CouncilTurnEntry = {
			id: "user-queued-during-debate",
			kind: "user",
			round: 2,
			text: "What about step 3?",
			createdAt: 1000,
			runId: 1, // queued during debate run 1
		};
		const userIdle: CouncilTurnEntry = {
			id: "user-idle",
			kind: "user",
			round: 2,
			text: "Clarify scope please",
			createdAt: 2000,
			runId: 3, // associated with the Q&A run itself
		};
		const reply1: CouncilTurnEntry = {
			id: "reply-1",
			kind: "reply",
			round: 2,
			reviewerKey: "openai/gpt-4o",
			reviewerLabel: "gpt-4o",
			status: "done",
			text: "Step 3 is safe.",
			startedAt: 1100,
			finishedAt: 1200,
			runId: 2,
		};
		const reply2: CouncilTurnEntry = {
			id: "reply-2",
			kind: "reply",
			round: 2,
			reviewerKey: "openai/gpt-4o",
			reviewerLabel: "gpt-4o",
			status: "done",
			text: "Scope is limited to src/.",
			startedAt: 2100,
			finishedAt: 2200,
			runId: 3,
		};

		const entries: CouncilTurnEntry[] = [userQueuedDuringDebate, reply1, userIdle, reply2];
		const sections = buildTranscript([debateRun, qaRunFromEarlier, qaRunDirect], entries);

		expect(sections).toHaveLength(3);

		// debate run section contains the user entry queued during it
		expect(sections[0].run).toBe(debateRun);
		expect(sections[0].entries.map(e => e.id)).toEqual(["user-queued-during-debate"]);
		expect(sections[0].answering).toBeUndefined();

		// Q&A run 2 answering message from run 1 sets answering
		expect(sections[1].run).toBe(qaRunFromEarlier);
		expect(sections[1].entries.map(e => e.id)).toEqual(["reply-1"]);
		expect(sections[1].answering).toBe(userQueuedDuringDebate);

		// Q&A run 3 where user entry has runId === 3 does NOT set answering
		expect(sections[2].run).toBe(qaRunDirect);
		expect(sections[2].entries.map(e => e.id)).toEqual(["user-idle", "reply-2"]);
		expect(sections[2].answering).toBeUndefined();
	});

	it("groups entries by runId and preserves their insertion order", () => {
		const run1: CouncilRun = { id: 1, kind: "critiques", round: 1, status: "done" };
		const run2: CouncilRun = { id: 2, kind: "debate", round: 2, status: "done" };

		const e1: CouncilTurnEntry = {
			id: "e1",
			kind: "critique",
			round: 1,
			reviewerKey: "anthropic/claude-3-7-sonnet",
			reviewerLabel: "claude-3-7-sonnet",
			status: "done",
			text: "critique 1",
			startedAt: 10,
			runId: 1,
		};
		const e2: CouncilTurnEntry = {
			id: "e2",
			kind: "user",
			round: 1,
			text: "user interjection during critique",
			createdAt: 20,
			runId: 1,
		};
		const e3: CouncilTurnEntry = {
			id: "e3",
			kind: "rebuttal",
			round: 2,
			reviewerKey: "anthropic/claude-3-7-sonnet",
			reviewerLabel: "claude-3-7-sonnet",
			status: "done",
			text: "debate 1",
			startedAt: 30,
			runId: 2,
		};
		const e4: CouncilTurnEntry = {
			id: "e4",
			kind: "critique",
			round: 1,
			reviewerKey: "openai/gpt-4o",
			reviewerLabel: "gpt-4o",
			status: "done",
			text: "critique 2 finished late",
			startedAt: 15,
			runId: 1,
		};
		const e5: CouncilTurnEntry = {
			id: "e5",
			kind: "rebuttal",
			round: 2,
			reviewerKey: "openai/gpt-4o",
			reviewerLabel: "gpt-4o",
			status: "done",
			text: "debate 2",
			startedAt: 40,
			runId: 2,
		};

		// entries provided in specific insertion order with interleaved runIds
		const entries = [e1, e2, e3, e4, e5];
		const sections = buildTranscript([run1, run2], entries);

		expect(sections).toHaveLength(2);
		expect(sections[0].run).toBe(run1);
		expect(sections[0].entries).toEqual([e1, e2, e4]);

		expect(sections[1].run).toBe(run2);
		expect(sections[1].entries).toEqual([e3, e5]);
	});

	it("keeps entries that belong to no run in their own sections, in timeline order", () => {
		const run: CouncilRun = { id: 1, kind: "critiques", round: 1, status: "done" };
		const message = (id: string, runId?: number): CouncilTurnEntry => ({ id, kind: "user", round: 1, text: id, createdAt: 0, runId });
		const critique: CouncilTurnEntry = {
			id: "c1",
			kind: "critique",
			round: 1,
			reviewerKey: "openai/gpt-4o",
			reviewerLabel: "gpt-4o",
			status: "done",
			text: "critique",
			startedAt: 0,
			runId: 1,
		};
		// two messages queued before any run, then the run, then one whose run no longer exists
		const sections = buildTranscript([run], [message("m1"), message("m2"), critique, message("m3", 99)]);

		expect(sections.map(s => [s.unassigned === true, s.entries.map(e => e.id)])).toEqual([
			[true, ["m1", "m2"]],
			[false, ["c1"]],
			[true, ["m3"]],
		]);
		// stand-in runs never collide with real run IDs
		expect(sections.filter(s => s.unassigned).every(s => s.run.id < 0)).toBe(true);
	});
});

describe("firstProseLine", () => {
	it("skips blank lines and markdown headings", () => {
		const text = `
# Plan Review

### Verdict

NEEDS REVISION — x
More details here.
`;
		expect(firstProseLine(text)).toBe("NEEDS REVISION — x");
	});

	it("strips list markers, blockquotes, backticks, and bold markers while keeping snake_case_name", () => {
		expect(firstProseLine("- Check `snake_case_name` carefully")).toBe("Check snake_case_name carefully");
		expect(firstProseLine("1. **Bold title**: check `snake_case_name`")).toBe("Bold title: check snake_case_name");
		expect(firstProseLine("10) **Important**: fix `my_identifier` now")).toBe("Important: fix my_identifier now");
		expect(firstProseLine("> Quoted `snake_case_name` with **bold** text")).toBe("Quoted snake_case_name with bold text");
		expect(firstProseLine(">> - **Nested**: use `snake_case_name`")).toBe("Nested: use snake_case_name");
		expect(firstProseLine("* List item with *italic* and `snake_case_name`")).toBe("List item with *italic* and snake_case_name");
		expect(firstProseLine("+ Plus list with `snake_case_name`")).toBe("Plus list with snake_case_name");
	});

	it("returns empty string when no prose line exists", () => {
		expect(firstProseLine("")).toBe("");
		expect(firstProseLine("\n\n   \n")).toBe("");
		expect(firstProseLine("# Title\n\n## Subtitle\n\n### Heading 3")).toBe("");
	});
});
