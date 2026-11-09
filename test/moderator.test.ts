import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ReviewerMember } from "../src/models";
import {
	type AgendaTopic,
	agendaStatuses,
	applyAgenda,
	applyAssignments,
	pickFraming,
	reconcileAgenda,
} from "../src/moderator";
import type { ConvergenceReport, RevisionItem } from "../src/position";

function makeFakeReviewer(provider: string, id: string, family = id): ReviewerMember {
	const model: Model = {
		id,
		provider,
		name: `${id} model`,
		description: "fake model",
		contextWindow: 128000,
		maxTokens: 4096,
		thinking: false,
		identity: {
			family,
			class: family,
			archetype: family,
			vendor: provider,
		},
	} as unknown as Model;

	return {
		key: `${provider}/${id}`,
		label: `${id} (${provider})`,
		family,
		model,
	};
}

describe("reconcileAgenda", () => {
	it("removes a retracted item and drops its emptied topic", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Single Item Topic", itemIds: ["openai/gpt-4o#1"], duplicates: false },
			{ id: "T2", title: "Multi Item Topic", itemIds: ["anthropic/claude-3-7-sonnet#1", "openai/gpt-4o#2"], duplicates: true },
		];
		// Held only keeps claude#1; gpt#1 is retracted (emptying T1) and gpt#2 is retracted from T2
		const held: RevisionItem[] = [
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Keep claude revision" },
		];

		const result = reconcileAgenda(initialAgenda, held, 3);

		// T1 should be dropped completely; T2 should keep only claude#1
		expect(result.topics.map(t => t.id)).toEqual(["T2"]);
		expect(result.topics[0]).toEqual({
			id: "T2",
			title: "Multi Item Topic",
			itemIds: ["anthropic/claude-3-7-sonnet#1"],
			duplicates: false, // membership changed, so duplicates is cleared
		});
		expect(result.placedIds).toEqual([]);
		expect(result.nextTopicNumber).toBe(3);
	});

	it("places a new item into the existing topic holding an item with the same concern label", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Error Handling", itemIds: ["openai/gpt-4o#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Catch timeout errors", concern: "Error handling" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Handle network failures", concern: "  error  HANDLING  " },
		];

		const result = reconcileAgenda(initialAgenda, held, 2);

		expect(result.topics).toEqual([
			{
				id: "T1",
				title: "Error Handling",
				itemIds: ["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
		]);
		expect(result.placedIds).toEqual(["anthropic/claude-3-7-sonnet#1"]);
		expect(result.nextTopicNumber).toBe(2);
	});

	it("groups unplaced items sharing a label into ONE new topic titled by the label and gives unlabeled items their own topics titled by summary", () => {
		const initialAgenda: AgendaTopic[] = [];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Limit negative values in budget", concern: "Negative budgets" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Reject negative budget allocations", concern: " negative  BUDGETS" },
			{ id: "google/gemini-2.5-pro#1", summary: "Add cache eviction policy" }, // unlabeled
		];

		const result = reconcileAgenda(initialAgenda, held, 1);

		expect(result.topics).toEqual([
			{
				id: "T1",
				title: "Negative budgets",
				itemIds: ["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
			{
				id: "T2",
				title: "Add cache eviction policy",
				itemIds: ["google/gemini-2.5-pro#1"],
				duplicates: false,
			},
		]);
		expect(result.placedIds).toEqual([
			"openai/gpt-4o#1",
			"anthropic/claude-3-7-sonnet#1",
			"google/gemini-2.5-pro#1",
		]);
		expect(result.nextTopicNumber).toBe(3);
	});

	it("clears duplicates on a topic whose membership changes", () => {
		const initialAgenda: AgendaTopic[] = [
			{
				id: "T1",
				title: "Topic With Retraction",
				itemIds: ["anthropic/claude-3-7-sonnet#1", "openai/gpt-4o#1"],
				duplicates: true,
			},
			{
				id: "T2",
				title: "Topic With Addition",
				itemIds: ["google/gemini-2.5-pro#1"],
				duplicates: true,
			},
			{
				id: "T3",
				title: "Unchanged Topic",
				itemIds: ["openai/gpt-4o#2"],
				duplicates: true,
			},
		];

		const held: RevisionItem[] = [
			// T1 loses gpt-4o#1
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item", concern: "topic 1" },
			// T2 gains claude#2 via concern match
			{ id: "google/gemini-2.5-pro#1", summary: "Gemini item", concern: "topic 2" },
			{ id: "anthropic/claude-3-7-sonnet#2", summary: "New item for T2", concern: "topic 2" },
			// T3 unchanged
			{ id: "openai/gpt-4o#2", summary: "GPT item unchanged" },
		];

		const result = reconcileAgenda(initialAgenda, held, 4);

		const t1 = result.topics.find(t => t.id === "T1");
		const t2 = result.topics.find(t => t.id === "T2");
		const t3 = result.topics.find(t => t.id === "T3");

		expect(t1?.duplicates).toBe(false);
		expect(t2?.duplicates).toBe(false);
		expect(t3?.duplicates).toBe(true);
	});

	it("never reuses a topic ID (nextTopicNumber only grows, IDs of dropped topics are not reissued)", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Dropped Topic", itemIds: ["openai/gpt-4o#1"], duplicates: false },
			{ id: "T2", title: "Preserved Topic", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		// gpt-4o#1 is dropped, claude#1 kept, gemini#1 is new
		const held: RevisionItem[] = [
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Preserved" },
			{ id: "google/gemini-2.5-pro#1", summary: "New item" },
		];

		const result = reconcileAgenda(initialAgenda, held, 3);

		// T1 was dropped, but new topic must get T3, not T1
		expect(result.topics.map(t => t.id)).toEqual(["T2", "T3"]);
		expect(result.nextTopicNumber).toBe(4);
	});

	it("returns placedIds for newly placed items only", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Existing", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Already on agenda" },
			{ id: "openai/gpt-4o#1", summary: "First new item" },
			{ id: "google/gemini-2.5-pro#1", summary: "Second new item" },
		];

		const result = reconcileAgenda(initialAgenda, held, 2);

		expect(result.placedIds).toEqual(["openai/gpt-4o#1", "google/gemini-2.5-pro#1"]);
	});
});

describe("applyAgenda", () => {
	it("drops unknown item IDs", () => {
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Real item" },
		];
		const args = {
			topics: [
				{
					title: "Topic with ghosts",
					itemIds: ["ghost/nonexistent#1", "openai/gpt-4o#1", "ghost/nonexistent#2"],
					duplicates: false,
				},
				{
					title: "Entirely ghost topic",
					itemIds: ["ghost/nonexistent#3"],
					duplicates: false,
				},
			],
			nextSpeaker: "gpt-4o",
			question: "What about the real item?",
		};

		const result = applyAgenda(args, [], held, 1);

		expect(result.topics).toEqual([
			{
				id: "T1",
				title: "Topic with ghosts",
				itemIds: ["openai/gpt-4o#1"],
				duplicates: false,
			},
		]);
	});

	it("assigns an item listed in two topics to the first topic only", () => {
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Contested item" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item" },
		];
		const args = {
			topics: [
				{
					title: "First Topic",
					itemIds: ["openai/gpt-4o#1"],
					duplicates: false,
				},
				{
					title: "Second Topic",
					itemIds: ["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"],
					duplicates: false,
				},
			],
			nextSpeaker: "gpt-4o",
			question: "Which topic wins?",
		};

		const result = applyAgenda(args, [], held, 1);

		expect(result.topics).toEqual([
			{
				id: "T1",
				title: "First Topic",
				itemIds: ["openai/gpt-4o#1"],
				duplicates: false,
			},
			{
				id: "T2",
				title: "Second Topic",
				itemIds: ["anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
		]);
	});

	it("keeps a valid existing topic ID and mints a new one for an unknown proposed ID", () => {
		const existingAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Existing T1", itemIds: ["openai/gpt-4o#1"], duplicates: false },
			{ id: "T2", title: "Existing T2", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Item 1" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Item 2" },
			{ id: "google/gemini-2.5-pro#1", summary: "Item 3" },
		];
		const args = {
			topics: [
				{
					id: "T2", // existing valid ID
					title: "Updated T2",
					itemIds: ["anthropic/claude-3-7-sonnet#1"],
					duplicates: false,
				},
				{
					id: "T99", // unknown proposed ID
					title: "New topic with invalid ID",
					itemIds: ["openai/gpt-4o#1"],
					duplicates: false,
				},
				{
					// omitted ID
					title: "Brand new topic",
					itemIds: ["google/gemini-2.5-pro#1"],
					duplicates: false,
				},
			],
			nextSpeaker: "gpt-4o",
			question: "How do IDs resolve?",
		};

		const result = applyAgenda(args, existingAgenda, held, 3);

		expect(result.topics.map(t => t.id)).toEqual(["T2", "T3", "T4"]);
		expect(result.nextTopicNumber).toBe(5);
	});

	it("clears duplicates on a single-owner topic but keeps it on a multi-owner one", () => {
		// Topic 1 has items from single owner (openai/gpt-4o); Topic 2 has items from two owners
		const heldMulti: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "GPT item 1" },
			{ id: "openai/gpt-4o#2", summary: "GPT item 2" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item 1" },
			{ id: "google/gemini-2.5-pro#1", summary: "Gemini item 1" },
		];
		const argsMulti = {
			topics: [
				{
					title: "Single Owner Topic",
					itemIds: ["openai/gpt-4o#1", "openai/gpt-4o#2"],
					duplicates: true, // single owner: should clear
				},
				{
					title: "Multi Owner Topic",
					itemIds: ["anthropic/claude-3-7-sonnet#1", "google/gemini-2.5-pro#1"],
					duplicates: true, // multi-owner: should keep
				},
			],
			nextSpeaker: "claude-3-7-sonnet",
			question: "Are these duplicates?",
		};

		const result = applyAgenda(argsMulti, [], heldMulti, 1);

		expect(result.topics[0].duplicates).toBe(false);
		expect(result.topics[1].duplicates).toBe(true);
	});

	it("places leftover held items that the moderator omitted", () => {
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Addressed item" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Leftover item", concern: "Omitted concern" },
		];
		const args = {
			topics: [
				{
					title: "Addressed Topic",
					itemIds: ["openai/gpt-4o#1"],
					duplicates: false,
				},
			],
			nextSpeaker: "gpt-4o",
			question: "What about the leftover?",
		};

		const result = applyAgenda(args, [], held, 1);

		expect(result.topics).toEqual([
			{
				id: "T1",
				title: "Addressed Topic",
				itemIds: ["openai/gpt-4o#1"],
				duplicates: false,
			},
			{
				id: "T2",
				title: "Omitted concern",
				itemIds: ["anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
		]);
		expect(result.nextTopicNumber).toBe(3);
	});
});

describe("applyAssignments", () => {
	it("moves a provisional item to an existing topic and to a new titled topic", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Source Topic", itemIds: ["openai/gpt-4o#1", "openai/gpt-4o#2"], duplicates: false },
			{ id: "T2", title: "Target Topic", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Moving to T2" },
			{ id: "openai/gpt-4o#2", summary: "Moving to new topic" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item" },
		];
		const provisionalIds = new Set(["openai/gpt-4o#1", "openai/gpt-4o#2"]);
		const args = {
			assignments: [
				{ itemId: "openai/gpt-4o#1", topicId: "T2" },
				{ itemId: "openai/gpt-4o#2", newTopicTitle: "Brand New Topic" },
			],
			nextSpeaker: "claude-3-7-sonnet",
			question: "Can you confirm these moves?",
		};

		const result = applyAssignments(args, initialAgenda, held, provisionalIds, 3);

		// T1 is emptied because both items were moved, so T1 is dropped
		expect(result.topics.find(t => t.id === "T1")).toBeUndefined();
		const t2 = result.topics.find(t => t.id === "T2");
		expect(t2?.itemIds).toEqual(["anthropic/claude-3-7-sonnet#1", "openai/gpt-4o#1"]);
		const t3 = result.topics.find(t => t.id === "T3");
		expect(t3?.title).toBe("Brand New Topic");
		expect(t3?.itemIds).toEqual(["openai/gpt-4o#2"]);
		expect(result.nextTopicNumber).toBe(4);
	});

	it("ignores a non-provisional item", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Topic 1", itemIds: ["openai/gpt-4o#1"], duplicates: false },
			{ id: "T2", title: "Topic 2", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Non-provisional item" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item" },
		];
		// provisionalIds is empty; gpt-4o#1 is not provisional
		const provisionalIds = new Set<string>();
		const args = {
			assignments: [
				{ itemId: "openai/gpt-4o#1", topicId: "T2" },
			],
			nextSpeaker: "gpt-4o",
			question: "Ignored move?",
		};

		const result = applyAssignments(args, initialAgenda, held, provisionalIds, 3);

		// T1 still has gpt-4o#1, T2 still has claude#1
		expect(result.topics.find(t => t.id === "T1")?.itemIds).toEqual(["openai/gpt-4o#1"]);
		expect(result.topics.find(t => t.id === "T2")?.itemIds).toEqual(["anthropic/claude-3-7-sonnet#1"]);
	});

	it("sameChangeTopicIds sets duplicates only on multi-owner topics", () => {
		const initialAgenda: AgendaTopic[] = [
			{
				id: "T1",
				title: "Multi-owner Topic",
				itemIds: ["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
			{
				id: "T2",
				title: "Single-owner Topic",
				itemIds: ["openai/gpt-4o#2", "openai/gpt-4o#3"],
				duplicates: false,
			},
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Item 1" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Item 2" },
			{ id: "openai/gpt-4o#2", summary: "Item 3" },
			{ id: "openai/gpt-4o#3", summary: "Item 4" },
		];
		const args = {
			sameChangeTopicIds: ["T1", "T2"],
			nextSpeaker: "gpt-4o",
			question: "Duplicate check?",
		};

		const result = applyAssignments(args, initialAgenda, held, new Set(), 3);

		const t1 = result.topics.find(t => t.id === "T1");
		const t2 = result.topics.find(t => t.id === "T2");
		expect(t1?.duplicates).toBe(true);
		expect(t2?.duplicates).toBe(false);
	});

	it("drops a topic that is emptied by a move", () => {
		const initialAgenda: AgendaTopic[] = [
			{ id: "T1", title: "Will Be Emptied", itemIds: ["openai/gpt-4o#1"], duplicates: false },
			{ id: "T2", title: "Destination", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		];
		const held: RevisionItem[] = [
			{ id: "openai/gpt-4o#1", summary: "Only item in T1" },
			{ id: "anthropic/claude-3-7-sonnet#1", summary: "Claude item in T2" },
		];
		const provisionalIds = new Set(["openai/gpt-4o#1"]);
		const args = {
			assignments: [
				{ itemId: "openai/gpt-4o#1", topicId: "T2" },
			],
			nextSpeaker: "claude-3-7-sonnet",
			question: "Is T1 dropped?",
		};

		const result = applyAssignments(args, initialAgenda, held, provisionalIds, 3);

		expect(result.topics.map(t => t.id)).toEqual(["T2"]);
		expect(result.topics[0].itemIds).toEqual(["anthropic/claude-3-7-sonnet#1", "openai/gpt-4o#1"]);
	});
});

describe("pickFraming", () => {
	const claude = makeFakeReviewer("anthropic", "claude-3-7-sonnet", "claude");
	const gpt = makeFakeReviewer("openai", "gpt-4o", "gpt");
	const gemini = makeFakeReviewer("google", "gemini-2.5-pro", "gemini");
	const queue = [claude, gpt, gemini];
	const agenda: AgendaTopic[] = [
		{ id: "T1", title: "Topic 1", itemIds: ["anthropic/claude-3-7-sonnet#1"], duplicates: false },
		{ id: "T2", title: "Topic 2", itemIds: ["openai/gpt-4o#1"], duplicates: false },
	];

	it("accepts a queued reviewer by exact model id, @-prefixed handle, or unique substring", () => {
		// Exact model id
		const framing1 = pickFraming(
			{ nextSpeaker: "claude-3-7-sonnet", topicId: "T1", question: "Defend your proposal." },
			queue,
			agenda,
		);
		expect(framing1).toEqual({
			speakerKey: "anthropic/claude-3-7-sonnet",
			topicId: "T1",
			question: "Defend your proposal.",
		});

		// @-prefixed handle
		const framing2 = pickFraming(
			{ nextSpeaker: "@claude-3-7-sonnet", topicId: "T1", question: "Defend your proposal." },
			queue,
			agenda,
		);
		expect(framing2?.speakerKey).toBe("anthropic/claude-3-7-sonnet");

		// Unique substring
		const framing3 = pickFraming(
			{ nextSpeaker: "4o", topicId: "T2", question: "Do you agree with claude?" },
			queue,
			agenda,
		);
		expect(framing3?.speakerKey).toBe("openai/gpt-4o");

		// Unique substring with @ prefix
		const framing4 = pickFraming(
			{ nextSpeaker: "@gemini", topicId: "T1", question: "What is your stance?" },
			queue,
			agenda,
		);
		expect(framing4?.speakerKey).toBe("google/gemini-2.5-pro");
	});

	it("rejects a reviewer not in the queue, an ambiguous substring, or an empty question", () => {
		// Reviewer not in queue (only claude and gpt are queued)
		const shortQueue = [claude, gpt];
		const framingNotQueued = pickFraming(
			{ nextSpeaker: "gemini-2.5-pro", topicId: "T1", question: "Why?" },
			shortQueue,
			agenda,
		);
		expect(framingNotQueued).toBeUndefined();

		// Ambiguous substring
		const claudeHaiku = makeFakeReviewer("anthropic", "claude-3-5-haiku", "claude");
		const ambiguousQueue = [claude, claudeHaiku];
		const framingAmbiguous = pickFraming(
			{ nextSpeaker: "claude", topicId: "T1", question: "Which claude?" },
			ambiguousQueue,
			agenda,
		);
		expect(framingAmbiguous).toBeUndefined();

		// Empty question (empty string or whitespace only)
		const framingEmptyQ = pickFraming(
			{ nextSpeaker: "gpt-4o", topicId: "T1", question: "" },
			queue,
			agenda,
		);
		expect(framingEmptyQ).toBeUndefined();

		const framingWhitespaceQ = pickFraming(
			{ nextSpeaker: "gpt-4o", topicId: "T1", question: "   \n\t  " },
			queue,
			agenda,
		);
		expect(framingWhitespaceQ).toBeUndefined();
	});

	it("drops an unknown topicId", () => {
		const framing = pickFraming(
			{ nextSpeaker: "gpt-4o", topicId: "T99", question: "Valid question on missing topic." },
			queue,
			agenda,
		);
		expect(framing).toEqual({
			speakerKey: "openai/gpt-4o",
			question: "Valid question on missing topic.",
		});
		expect(framing?.topicId).toBeUndefined();
	});

	it("truncates a >500-char question with …", () => {
		const longQuestion = "a".repeat(600);
		const framing = pickFraming(
			{ nextSpeaker: "gpt-4o", topicId: "T1", question: longQuestion },
			queue,
			agenda,
		);

		expect(framing).toBeDefined();
		expect(framing?.question.length).toBe(500);
		expect(framing?.question.endsWith("…")).toBe(true);
		expect(framing?.question).toBe(`${"a".repeat(499)}…`);
	});
});

describe("agendaStatuses", () => {
	it("prioritizes contested over open over settled", () => {
		const agenda: AgendaTopic[] = [
			{
				id: "T1",
				title: "Contested Topic",
				itemIds: ["openai/gpt-4o#1", "anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
			{
				id: "T2",
				title: "Open Topic",
				itemIds: ["google/gemini-2.5-pro#1"],
				duplicates: false,
			},
			{
				id: "T3",
				title: "Settled Topic",
				itemIds: ["anthropic/claude-3-7-sonnet#2"],
				duplicates: false,
			},
		];

		const convergence: ConvergenceReport = {
			converged: false,
			items: [
				{ id: "openai/gpt-4o#1", summary: "Disputed item" },
				{ id: "anthropic/claude-3-7-sonnet#1", summary: "Uncovered item in T1" },
				{ id: "google/gemini-2.5-pro#1", summary: "Uncovered item in T2" },
				{ id: "anthropic/claude-3-7-sonnet#2", summary: "Agreed item" },
			],
			disputes: [
				{ id: "openai/gpt-4o#1", by: "anthropic/claude-3-7-sonnet", reason: "Flawed approach" },
			],
			uncovered: [
				{ id: "anthropic/claude-3-7-sonnet#1", by: "google/gemini-2.5-pro" },
				{ id: "google/gemini-2.5-pro#1", by: "openai/gpt-4o" },
			],
			unreported: [],
		};

		const statuses = agendaStatuses(agenda, convergence);

		// T1 has both a dispute and an uncovered item; contested beats open
		expect(statuses.find(s => s.id === "T1")?.status).toBe("contested");
		// T2 has an uncovered item and no disputes -> open
		expect(statuses.find(s => s.id === "T2")?.status).toBe("open");
		// T3 has neither disputes nor uncovered items, and unreported is empty -> settled
		expect(statuses.find(s => s.id === "T3")?.status).toBe("settled");
	});

	it("marks a topic whose items are all agreed as open while convergence.unreported is non-empty", () => {
		const agenda: AgendaTopic[] = [
			{
				id: "T1",
				title: "Agreed Topic",
				itemIds: ["anthropic/claude-3-7-sonnet#1"],
				duplicates: false,
			},
		];

		const convergenceWithUnreported: ConvergenceReport = {
			converged: false,
			items: [
				{ id: "anthropic/claude-3-7-sonnet#1", summary: "Agreed by all who reported" },
			],
			disputes: [],
			uncovered: [],
			unreported: ["gemini-2.5-pro (google)"],
		};

		const statusesWithUnreported = agendaStatuses(agenda, convergenceWithUnreported);
		expect(statusesWithUnreported[0].status).toBe("open");

		// When unreported becomes empty, it becomes settled
		const convergenceAllReported: ConvergenceReport = {
			...convergenceWithUnreported,
			unreported: [],
		};
		const statusesAllReported = agendaStatuses(agenda, convergenceAllReported);
		expect(statusesAllReported[0].status).toBe("settled");
	});
});
