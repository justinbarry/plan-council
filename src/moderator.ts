import { type, type Tool } from "@oh-my-pi/pi-ai";
import { matchReviewerHandle, type ReviewerMember } from "./models";
import {
	type ConvergenceReport,
	type PositionDelta,
	positionDeltaSegments,
	type ReviewerPosition,
	type RevisionItem,
} from "./position";

export const SET_AGENDA_TOOL_NAME = "set_agenda";
export const MODERATE_TURN_TOOL_NAME = "moderate_turn";

/** a topic groups held revision items that address one problem; it stores only IDs */
export interface AgendaTopic {
	/** `T1`, `T2`, …; never reused within a session */
	id: string;
	title: string;
	itemIds: string[];
	/** the moderator's advisory judgment that the items are equivalent versions of one change; never set mechanically */
	duplicates: boolean;
}

export interface AgendaTopicStatus extends AgendaTopic {
	status: "settled" | "contested" | "open";
}

/** the moderator's question for the next debate speaker */
export interface TurnFraming {
	speakerKey: string;
	topicId?: string;
	question: string;
}

export interface AgendaUpdate {
	topics: AgendaTopic[];
	nextTopicNumber: number;
}

const MAX_TOPIC_TITLE_LENGTH = 80;
const MAX_QUESTION_LENGTH = 500;
const MAX_TURN_TEXT_LENGTH = 4000;

const framingFields = {
	nextSpeaker: type("string").describe(
		"@model handle of the reviewer who should speak next, chosen only from ### Queued speakers.",
	),
	"topicId?": type("string").describe("ID of the agenda topic the question is about, e.g. T1."),
	question: type("string").describe(
		"One neutral question for that reviewer about that topic, at most two sentences, quoting the contested claim verbatim.",
	),
};

export const setAgendaSchema = type({
	topics: type({
		"id?": type("string").describe("The existing topic ID when this topic continues one from ### Agenda; omit for a new topic."),
		title: type("string > 0").describe("A few words naming the problem, not a fix."),
		itemIds: type("string")
			.array()
			.describe("Revision IDs exactly as listed under ### Held revisions; each revision belongs to exactly one topic."),
		"duplicates?": type("boolean").describe(
			"True only when the topic's revisions are genuinely equivalent versions of one change.",
		),
	})
		.array()
		.describe("Every held revision grouped into topics."),
	...framingFields,
});

export const moderateTurnSchema = type({
	...framingFields,
	"assignments?": type({
		itemId: type("string > 0").describe("A revision ID listed under ### Placed provisionally."),
		"topicId?": type("string").describe("The existing topic it belongs to."),
		"newTopicTitle?": type("string").describe("Title for a new topic, when no existing topic fits."),
	})
		.array()
		.describe("Moves for provisionally placed revisions that belong in a different or new topic; omit the rest."),
	"sameChangeTopicIds?": type("string")
		.array()
		.describe("Topics whose revisions are now genuinely equivalent versions of one change."),
});

export const SET_AGENDA_TOOL: Tool = {
	name: SET_AGENDA_TOOL_NAME,
	description: "Record the debate agenda (every held revision grouped into topics) and frame the first speaker's question.",
	parameters: setAgendaSchema,
};

export const MODERATE_TURN_TOOL: Tool = {
	name: MODERATE_TURN_TOOL_NAME,
	description: "Frame the next debate speaker's question and place revisions added since your last call.",
	parameters: moderateTurnSchema,
};

function normalizeLabel(label: string | undefined): string | undefined {
	return label?.trim().replace(/\s+/g, " ").toLowerCase() || undefined;
}

/** single-line text cut to `max` characters, with an ellipsis when cut */
function clip(text: string, max: number): string {
	const line = text.trim().replace(/\s+/g, " ");
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function ownerOf(itemId: string): string {
	return itemId.slice(0, itemId.lastIndexOf("#"));
}

/** "same change" only means something across reviewers */
function hasSeveralOwners(itemIds: readonly string[]): boolean {
	return new Set(itemIds.map(ownerOf)).size > 1;
}

/**
 * the model-free upkeep step: drops items no longer held and emptied topics, then places every held item not on
 * the agenda into the first topic holding an item with the same concern label, else into a new topic shared with
 * other unplaced items of that label, else alone. A topic whose membership changes loses `duplicates`.
 */
export function reconcileAgenda(
	agenda: readonly AgendaTopic[],
	held: readonly RevisionItem[],
	nextTopicNumber: number,
): AgendaUpdate & { placedIds: string[] } {
	const heldById = new Map(held.map(item => [item.id, item]));
	const topics: AgendaTopic[] = [];
	for (const topic of agenda) {
		const itemIds = topic.itemIds.filter(id => heldById.has(id));
		if (itemIds.length === 0) continue;
		topics.push({ ...topic, itemIds, duplicates: itemIds.length === topic.itemIds.length && topic.duplicates });
	}

	const onAgenda = new Set(topics.flatMap(topic => topic.itemIds));
	const placedIds: string[] = [];
	let seq = nextTopicNumber;
	for (const item of held) {
		if (onAgenda.has(item.id)) continue;
		const label = normalizeLabel(item.concern);
		const target = label
			? topics.find(topic => topic.itemIds.some(id => normalizeLabel(heldById.get(id)?.concern) === label))
			: undefined;
		if (target) {
			target.itemIds.push(item.id);
			target.duplicates = false;
		} else {
			const title = clip(item.concern ?? item.summary, MAX_TOPIC_TITLE_LENGTH);
			topics.push({ id: `T${seq++}`, title, itemIds: [item.id], duplicates: false });
		}
		onAgenda.add(item.id);
		placedIds.push(item.id);
	}
	return { topics, nextTopicNumber: seq, placedIds };
}

/** the moderator's full regrouping; anything it left out or got wrong is placed by {@link reconcileAgenda} */
export function applyAgenda(
	args: typeof setAgendaSchema.infer,
	agenda: readonly AgendaTopic[],
	held: readonly RevisionItem[],
	nextTopicNumber: number,
): AgendaUpdate {
	const heldById = new Map(held.map(item => [item.id, item]));
	const existingIds = new Set(agenda.map(topic => topic.id));
	const usedIds = new Set<string>();
	const assigned = new Set<string>();
	const topics: AgendaTopic[] = [];
	let seq = nextTopicNumber;
	for (const proposed of args.topics) {
		const itemIds: string[] = [];
		for (const raw of proposed.itemIds) {
			const id = raw.trim();
			if (!heldById.has(id) || assigned.has(id)) continue;
			assigned.add(id);
			itemIds.push(id);
		}
		if (itemIds.length === 0) continue;
		const proposedId = proposed.id?.trim();
		const id = proposedId && existingIds.has(proposedId) && !usedIds.has(proposedId) ? proposedId : `T${seq++}`;
		usedIds.add(id);
		const first = heldById.get(itemIds[0]);
		const title = clip(proposed.title, MAX_TOPIC_TITLE_LENGTH) || clip(first?.concern ?? first?.summary ?? id, MAX_TOPIC_TITLE_LENGTH);
		topics.push({ id, title, itemIds, duplicates: proposed.duplicates === true && hasSeveralOwners(itemIds) });
	}
	const { placedIds: _placed, ...update } = reconcileAgenda(topics, held, seq);
	return update;
}

/**
 * the moderator's between-turn corrections: it may move only provisional items (placed mechanically since it last
 * saw the agenda) and re-assert `duplicates` on multi-owner topics
 */
export function applyAssignments(
	args: typeof moderateTurnSchema.infer,
	agenda: readonly AgendaTopic[],
	held: readonly RevisionItem[],
	provisionalIds: ReadonlySet<string>,
	nextTopicNumber: number,
): AgendaUpdate {
	const heldIds = new Set(held.map(item => item.id));
	const topics = agenda.map(topic => ({ ...topic, itemIds: [...topic.itemIds] }));
	const moved = new Set<string>();
	let seq = nextTopicNumber;
	for (const assignment of args.assignments ?? []) {
		const itemId = assignment.itemId.trim();
		if (!provisionalIds.has(itemId) || !heldIds.has(itemId) || moved.has(itemId)) continue;
		const topicId = assignment.topicId?.trim();
		let target = topicId ? topics.find(topic => topic.id === topicId) : undefined;
		if (!target) {
			const title = clip(assignment.newTopicTitle ?? "", MAX_TOPIC_TITLE_LENGTH);
			if (!title) continue;
			target = { id: `T${seq++}`, title, itemIds: [], duplicates: false };
			topics.push(target);
		}
		for (const topic of topics) {
			const at = topic.itemIds.indexOf(itemId);
			if (at === -1 || topic === target) continue;
			topic.itemIds.splice(at, 1);
			topic.duplicates = false;
		}
		if (!target.itemIds.includes(itemId)) {
			target.itemIds.push(itemId);
			target.duplicates = false;
		}
		moved.add(itemId);
	}
	const sameChange = new Set((args.sameChangeTopicIds ?? []).map(id => id.trim()));
	for (const topic of topics) {
		if (sameChange.has(topic.id) && hasSeveralOwners(topic.itemIds)) topic.duplicates = true;
	}
	const { placedIds: _placed, ...update } = reconcileAgenda(topics, held, seq);
	return update;
}

/** the moderator's question, kept only when it names a queued reviewer; an unknown topic is dropped */
export function pickFraming(
	args: { nextSpeaker: string; topicId?: string; question: string },
	queue: readonly ReviewerMember[],
	agenda: readonly AgendaTopic[],
): TurnFraming | undefined {
	const speaker = matchReviewerHandle(args.nextSpeaker, queue);
	const question = clip(args.question, MAX_QUESTION_LENGTH);
	if (!speaker || !question) return undefined;
	const topicId = args.topicId?.trim();
	return {
		speakerKey: speaker.key,
		...(topicId && agenda.some(topic => topic.id === topicId) ? { topicId } : {}),
		question,
	};
}

/**
 * contested when any item is disputed; open while any item is uncovered or any reviewer has no report (an unreported
 * reviewer has judged nothing, and convergence skips it when computing coverage); otherwise settled
 */
export function agendaStatuses(agenda: readonly AgendaTopic[], convergence: ConvergenceReport): AgendaTopicStatus[] {
	const disputed = new Set(convergence.disputes.map(d => d.id));
	const uncovered = new Set(convergence.uncovered.map(u => u.id));
	const anyUnreported = convergence.unreported.length > 0;
	return agenda.map(topic => {
		let status: AgendaTopicStatus["status"] = "settled";
		if (topic.itemIds.some(id => disputed.has(id))) status = "contested";
		else if (anyUnreported || topic.itemIds.some(id => uncovered.has(id))) status = "open";
		return { ...topic, status };
	});
}

/** one line per topic: `- T1 · title (contested): a#1, b#2 · moderator: possibly the same change` */
export function formatAgenda(agenda: readonly AgendaTopicStatus[]): string {
	return agenda
		.map(topic => {
			const same = topic.duplicates ? " · moderator: possibly the same change" : "";
			return `- ${topic.id} · ${topic.title} (${topic.status}): ${topic.itemIds.join(", ")}${same}`;
		})
		.join("\n");
}

export interface ModeratorSnapshotInput {
	agenda: readonly AgendaTopicStatus[];
	/** active reviewers in roster order with their current positions */
	reviewers: readonly { reviewer: ReviewerMember; position?: ReviewerPosition }[];
	convergence: ConvergenceReport;
	queue: readonly ReviewerMember[];
}

/** the full current state every moderator request carries, from the slowest-changing section to the fastest */
export function formatModeratorSnapshot(input: ModeratorSnapshotInput): string {
	const topicOf = new Map(input.agenda.flatMap(topic => topic.itemIds.map(id => [id, topic.id] as const)));
	const sections: string[] = [];

	sections.push(`### Agenda\n${input.agenda.length > 0 ? formatAgenda(input.agenda) : "(none yet)"}`);

	const held = input.reviewers
		.filter(({ position }) => (position?.revisions.length ?? 0) > 0)
		.map(({ reviewer, position }) =>
			[
				`${reviewer.label}:`,
				...(position?.revisions ?? []).map(item => {
					const label = item.concern ? ` [${item.concern}]` : "";
					return `- \`${item.id}\`${label}: ${item.summary}`;
				}),
			].join("\n"),
		);
	sections.push(`### Held revisions\n${held.length > 0 ? held.join("\n") : "(none)"}`);

	const disputes = input.convergence.disputes.map(
		d => `- \`${d.id}\` disputed by ${d.by}${d.reason.trim() ? `: ${d.reason.trim()}` : ""}`,
	);
	sections.push(`### Disputes\n${disputes.length > 0 ? disputes.join("\n") : "(none)"}`);

	const unjudged = [
		...input.convergence.uncovered.map(u => `- \`${u.id}\` not yet judged by ${u.by}`),
		...input.convergence.unreported.map(label => `- No position reported: ${label}`),
	];
	if (unjudged.length > 0) sections.push(`### Not yet judged\n${unjudged.join("\n")}`);

	const queue = input.queue.map(reviewer => {
		const ownTopics = new Set(
			input.agenda.filter(topic => topic.itemIds.some(id => ownerOf(id) === reviewer.key)).map(topic => topic.id),
		);
		const disputedTopics = new Set(
			input.convergence.disputes
				.filter(d => d.by === reviewer.label)
				.map(d => topicOf.get(d.id))
				.filter((id): id is string => id !== undefined),
		);
		const stakes = [
			ownTopics.size > 0 ? `holds ${[...ownTopics].join(", ")}` : "",
			disputedTopics.size > 0 ? `disputes ${[...disputedTopics].join(", ")}` : "",
		].filter(Boolean);
		return `- @${reviewer.model.id} (${reviewer.label})${stakes.length > 0 ? `: ${stakes.join("; ")}` : ""}`;
	});
	sections.push(`### Queued speakers (in order)\n${queue.length > 0 ? queue.join("\n") : "(none)"}`);

	return sections.join("\n\n");
}

/** the turn the moderator reacts to: its prose (bounded) and how it moved the speaker's position */
export function formatEndedTurn(text: string, delta: PositionDelta | undefined, verdict?: ReviewerPosition["verdict"]): {
	text: string;
	delta?: string;
} {
	const trimmed = text.trim();
	const bounded = trimmed.length > MAX_TURN_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TURN_TEXT_LENGTH)}\n[truncated]` : trimmed;
	if (!delta) return { text: bounded || "(no prose; position report only)" };
	const segments = [
		...(delta.verdictFrom && verdict ? [`verdict ${delta.verdictFrom} → ${verdict}`] : []),
		...positionDeltaSegments(delta),
	];
	return { text: bounded || "(no prose; position report only)", delta: segments.length > 0 ? segments.join(" · ") : "position unchanged" };
}
