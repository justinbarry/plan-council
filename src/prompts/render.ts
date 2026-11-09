import { prompt } from "@oh-my-pi/pi-utils";
import type { PlanFileExcerpt } from "../plan-files";
import type { RevisionItem } from "../position";
import critiqueRoundTemplate from "./critique-round.md" with { type: "text" };
import critiqueSystemTemplate from "./critique-system.md" with { type: "text" };
import debateRebuttalTemplate from "./debate-rebuttal.md" with { type: "text" };
import positionFollowupTemplate from "./position-followup.md" with { type: "text" };
import readerQueryTemplate from "./reader-query.md" with { type: "text" };
import readerSystemTemplate from "./reader-system.md" with { type: "text" };
import synthesizeSystemTemplate from "./synthesize-system.md" with { type: "text" };
import synthesizeUserTemplate from "./synthesize-user.md" with { type: "text" };
import userFollowupTemplate from "./user-followup.md" with { type: "text" };

function exactPlaceholder(label: string, index: number, values: readonly string[]): string {
	let suffix = 0;
	let placeholder = `__OMP_COUNCIL_${label}_${index}_${suffix}__`;
	while (values.some(value => value.includes(placeholder))) {
		placeholder = `__OMP_COUNCIL_${label}_${index}_${++suffix}__`;
	}
	return placeholder;
}

function restoreExactValues(rendered: string, replacements: readonly (readonly [string, string])[]): string {
	let result = rendered;
	for (const [placeholder, value] of replacements) {
		if (result.includes(placeholder)) {
			result = result.replace(placeholder, () => value);
		}
	}
	return result;
}

export interface RenderCritiqueSystemOptions {
	hasCodeReader?: boolean;
	maxReaderQueriesPerTurn?: number;
}

export function renderCritiqueSystem(options: RenderCritiqueSystemOptions = {}): string {
	return prompt.render(critiqueSystemTemplate, {
		hasCodeReader: options.hasCodeReader === true,
		maxReaderQueriesPerTurn: options.maxReaderQueriesPerTurn ?? 3,
	});
}

export function renderPositionFollowup(): string {
	return prompt.render(positionFollowupTemplate, {});
}

export interface RenderCritiqueRoundOptions {
	planTitle: string;
	planFilePath: string;
	planContent: string;
	round?: number;
	sessionContext?: string;
	/** working-tree excerpts of files the plan names, rendered verbatim */
	referencedFiles?: readonly PlanFileExcerpt[];
}

export function renderCritiqueRound(options: RenderCritiqueRoundOptions): string {
	const referencedFiles = options.referencedFiles ?? [];
	const exactValues: string[] = [options.planContent];
	if (options.sessionContext) {
		exactValues.push(options.sessionContext);
	}
	// every value is registered before any placeholder is minted, so no placeholder can occur inside a restored value
	for (const file of referencedFiles) {
		exactValues.push(file.path, file.rangeLabel, file.excerptBlock);
	}

	const planBodyPlaceholder = exactPlaceholder("PLAN", 0, exactValues);
	const replacements: Array<readonly [string, string]> = [[planBodyPlaceholder, options.planContent]];

	let sessionContextPlaceholder: string | undefined;
	if (options.sessionContext) {
		sessionContextPlaceholder = exactPlaceholder("CTX", 1, exactValues);
		replacements.push([sessionContextPlaceholder, options.sessionContext]);
	}

	const referencedFilePlaceholders = referencedFiles.map((file, idx) => {
		const entry = {
			path: exactPlaceholder("REFPATH", idx, exactValues),
			rangeLabel: exactPlaceholder("REFRANGE", idx, exactValues),
			excerptBlock: exactPlaceholder("REFBLOCK", idx, exactValues),
		};
		replacements.push([entry.path, file.path], [entry.rangeLabel, file.rangeLabel], [entry.excerptBlock, file.excerptBlock]);
		return entry;
	});

	const rendered = prompt.render(critiqueRoundTemplate, {
		planTitle: options.planTitle,
		planFilePath: options.planFilePath,
		planBody: planBodyPlaceholder,
		round: options.round ?? 1,
		sessionContext: sessionContextPlaceholder,
		referencedFiles: referencedFilePlaceholders.length > 0 ? referencedFilePlaceholders : undefined,
	});

	return restoreExactValues(rendered, replacements);
}

export const renderCritiqueRound1 = renderCritiqueRound;
export type RenderCritiqueRound1Options = RenderCritiqueRoundOptions;

export interface PeerCritiqueItem {
	reviewerLabel: string;
	critiqueText: string;
	round?: number;
	kind?: "critique" | "rebuttal" | "reply";
}

/** a peer's dispute of one of the prompted reviewer's own revisions */
export interface OwnDisputeItem {
	id: string;
	summary: string;
	by: string;
	reason: string;
}

export interface PeerRevisionPromptItem extends RevisionItem {
	/** disputes of this item by reviewers other than its owner and the prompted reviewer */
	disputes?: readonly { by: string; reason: string }[];
}

/** the prompted reviewer's place in a sequential roundtable */
export interface RoundtableFloor {
	speaker: number;
	peerHandles: readonly string[];
}

export interface RenderDebateRebuttalOptions {
	round: number;
	peerCritiques: readonly PeerCritiqueItem[];
	peerItems?: readonly PeerRevisionPromptItem[];
	ownDisputes?: readonly OwnDisputeItem[];
	roundtable?: RoundtableFloor;
	operatorNotes?: string;
	hasCodeReader?: boolean;
}

/** summaries are model text: render placeholders, then restore the exact values */
function mapPeerItems(
	peerItems: readonly RevisionItem[] | undefined,
	exactValues: readonly string[],
	replacements: Array<readonly [string, string]>,
): Array<{ id: string; summary: string }> | undefined {
	if (!peerItems || peerItems.length === 0) return undefined;
	return peerItems.map((item, idx) => {
		const placeholder = exactPlaceholder(`ITEM_${idx}`, idx, exactValues);
		replacements.push([placeholder, item.summary]);
		return { id: item.id, summary: placeholder };
	});
}

export function renderDebateRebuttal(options: RenderDebateRebuttalOptions): string {
	const peerItems = options.peerItems ?? [];
	const ownDisputes = options.ownDisputes ?? [];
	const peerHandles = options.roundtable?.peerHandles ?? [];
	const peerHandlesText = peerHandles.length > 0 ? peerHandles.join(", ") : undefined;

	// every value is registered before any placeholder is minted, so no placeholder can occur inside a restored value
	const exactValues: string[] = [];
	for (const p of options.peerCritiques) {
		exactValues.push(p.critiqueText, p.reviewerLabel);
	}
	if (options.operatorNotes) exactValues.push(options.operatorNotes);
	if (peerHandlesText) exactValues.push(peerHandlesText);
	for (const d of ownDisputes) {
		exactValues.push(d.summary, d.by);
		if (d.reason.trim()) exactValues.push(d.reason);
	}
	for (const item of peerItems) {
		exactValues.push(item.summary);
		for (const d of item.disputes ?? []) {
			exactValues.push(d.by);
			if (d.reason.trim()) exactValues.push(d.reason);
		}
	}

	// one call-scoped counter keeps nested dispute placeholders distinct; restoration replaces each one once
	const replacements: Array<readonly [string, string]> = [];
	let nextToken = 0;
	const exact = (label: string, value: string): string => {
		const placeholder = exactPlaceholder(label, nextToken++, exactValues);
		replacements.push([placeholder, value]);
		return placeholder;
	};
	const exactReason = (reason: string): string | undefined => (reason.trim() ? exact("REASON", reason) : undefined);

	const mappedPeers = options.peerCritiques.map(p => ({
		reviewerLabel: exact("LABEL", p.reviewerLabel),
		critiqueText: exact("PEER", p.critiqueText),
		isFollowupTurn: p.kind === "rebuttal" || p.kind === "reply",
		turnRound: p.round ?? options.round,
		turnKind: p.kind ?? "critique",
	}));
	const operatorNotes = options.operatorNotes ? exact("OP", options.operatorNotes) : undefined;
	const roundtable = options.roundtable && {
		speaker: options.roundtable.speaker,
		peerHandlesText: peerHandlesText === undefined ? undefined : exact("HANDLES", peerHandlesText),
	};
	const mappedOwnDisputes = ownDisputes.map(d => ({
		id: d.id,
		summary: exact("OWNITEM", d.summary),
		by: exact("BY", d.by),
		reason: exactReason(d.reason),
	}));
	const mappedItems = peerItems.map(item => {
		const disputes = (item.disputes ?? []).map(d => ({ by: exact("BY", d.by), reason: exactReason(d.reason) }));
		return {
			id: item.id,
			summary: exact("ITEM", item.summary),
			disputes: disputes.length > 0 ? disputes : undefined,
		};
	});

	const rendered = prompt.render(debateRebuttalTemplate, {
		round: options.round,
		roundtable,
		peerCritiques: mappedPeers.length > 0 ? mappedPeers : undefined,
		ownDisputes: mappedOwnDisputes.length > 0 ? mappedOwnDisputes : undefined,
		peerItems: mappedItems.length > 0 ? mappedItems : undefined,
		operatorNotes,
		hasCodeReader: options.hasCodeReader === true,
	});

	return restoreExactValues(rendered, replacements);
}

export interface PeerUpdateItem {
	reviewerLabel: string;
	updateText: string;
}

export interface RenderUserFollowupOptions {
	userMessage: string;
	peerUpdates?: readonly PeerUpdateItem[];
	peerItems?: readonly RevisionItem[];
	/** the reviewer's place in a sequential broadcast Q&A pass */
	roundtable?: { speaker: number; total: number };
}

export function renderUserFollowup(options: RenderUserFollowupOptions): string {
	const exactValues: string[] = [options.userMessage];
	if (options.peerUpdates) {
		for (const u of options.peerUpdates) {
			exactValues.push(u.updateText);
		}
	}
	for (const item of options.peerItems ?? []) {
		exactValues.push(item.summary);
	}

	const userMsgPlaceholder = exactPlaceholder("USERMSG", 0, exactValues);
	const replacements: Array<readonly [string, string]> = [[userMsgPlaceholder, options.userMessage]];

	let mappedUpdates: Array<{ reviewerLabel: string; updateText: string }> | undefined;
	if (options.peerUpdates && options.peerUpdates.length > 0) {
		mappedUpdates = options.peerUpdates.map((u, idx) => {
			const placeholder = exactPlaceholder(`UPDATE_${idx}`, idx + 1, exactValues);
			replacements.push([placeholder, u.updateText]);
			return {
				reviewerLabel: u.reviewerLabel,
				updateText: placeholder,
			};
		});
	}

	const mappedItems = mapPeerItems(options.peerItems, exactValues, replacements);

	const rendered = prompt.render(userFollowupTemplate, {
		userMessage: userMsgPlaceholder,
		peerUpdates: mappedUpdates,
		peerItems: mappedItems,
		roundtable: options.roundtable,
	});

	return restoreExactValues(rendered, replacements);
}

export function renderSynthesizeSystem(): string {
	return prompt.render(synthesizeSystemTemplate, {});
}

export interface RenderSynthesizeUserOptions {
	planTitle: string;
	planFilePath: string;
	planContent: string;
	discussionHistory: string;
}

export function renderSynthesizeUser(options: RenderSynthesizeUserOptions): string {
	const exactValues: string[] = [options.planContent, options.discussionHistory];

	const planBodyPlaceholder = exactPlaceholder("PLAN", 0, exactValues);
	const historyPlaceholder = exactPlaceholder("HIST", 1, exactValues);

	const replacements: Array<readonly [string, string]> = [
		[planBodyPlaceholder, options.planContent],
		[historyPlaceholder, options.discussionHistory],
	];

	const rendered = prompt.render(synthesizeUserTemplate, {
		planTitle: options.planTitle,
		planFilePath: options.planFilePath,
		planBody: planBodyPlaceholder,
		discussionHistory: historyPlaceholder,
	});

	return restoreExactValues(rendered, replacements);
}

export interface RenderReaderSystemOptions {
	planTitle: string;
	planFilePath: string;
}

export function renderReaderSystem(options: RenderReaderSystemOptions): string {
	return prompt.render(readerSystemTemplate, {
		planTitle: options.planTitle,
		planFilePath: options.planFilePath,
	});
}

export interface RenderReaderQueryOptions {
	requesterLabel: string;
	question: string;
	paths?: readonly string[];
}

/** questions routinely quote code (including `{{...}}`), so every caller value is restored verbatim after rendering */
export function renderReaderQuery(options: RenderReaderQueryOptions): string {
	const joinedPaths = options.paths && options.paths.length > 0 ? options.paths.join(", ") : undefined;
	const exactValues: string[] = [options.question, options.requesterLabel];
	if (joinedPaths) {
		exactValues.push(joinedPaths);
	}

	const questionPlaceholder = exactPlaceholder("QUESTION", 0, exactValues);
	const labelPlaceholder = exactPlaceholder("REQUESTER", 1, exactValues);
	const replacements: Array<readonly [string, string]> = [
		[questionPlaceholder, options.question],
		[labelPlaceholder, options.requesterLabel],
	];

	let pathsPlaceholder: string | undefined;
	if (joinedPaths) {
		pathsPlaceholder = exactPlaceholder("PATHS", 2, exactValues);
		replacements.push([pathsPlaceholder, joinedPaths]);
	}

	const rendered = prompt.render(readerQueryTemplate, {
		requesterLabel: labelPlaceholder,
		priorityPaths: pathsPlaceholder,
		question: questionPlaceholder,
	});

	return restoreExactValues(rendered, replacements);
}
