import { prompt } from "@oh-my-pi/pi-utils";
import critiqueRoundTemplate from "./critique-round.md" with { type: "text" };
import critiqueSystemTemplate from "./critique-system.md" with { type: "text" };
import inspectionAddendumTemplate from "./inspection-addendum.md" with { type: "text" };
import debateRebuttalTemplate from "./debate-rebuttal.md" with { type: "text" };
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

export function renderCritiqueSystem(): string {
	return prompt.render(critiqueSystemTemplate, {});
}

/** describe source inspection and its evidence limits for native reviewer sessions */
export function renderInspectionAddendum(): string {
	return prompt.render(inspectionAddendumTemplate, {});
}

export interface RenderCritiqueRoundOptions {
	planTitle: string;
	planFilePath: string;
	planContent: string;
	round?: number;
	sessionContext?: string;
}

export function renderCritiqueRound(options: RenderCritiqueRoundOptions): string {
	const exactValues: string[] = [options.planContent];
	if (options.sessionContext) {
		exactValues.push(options.sessionContext);
	}

	const planBodyPlaceholder = exactPlaceholder("PLAN", 0, exactValues);
	const replacements: Array<readonly [string, string]> = [[planBodyPlaceholder, options.planContent]];

	let sessionContextPlaceholder: string | undefined;
	if (options.sessionContext) {
		sessionContextPlaceholder = exactPlaceholder("CTX", 1, exactValues);
		replacements.push([sessionContextPlaceholder, options.sessionContext]);
	}

	const rendered = prompt.render(critiqueRoundTemplate, {
		planTitle: options.planTitle,
		planFilePath: options.planFilePath,
		planBody: planBodyPlaceholder,
		round: options.round ?? 1,
		sessionContext: sessionContextPlaceholder,
	});

	return restoreExactValues(rendered, replacements);
}

export const renderCritiqueRound1 = renderCritiqueRound;
export type RenderCritiqueRound1Options = RenderCritiqueRoundOptions;

export interface PeerCritiqueItem {
	reviewerLabel: string;
	critiqueText: string;
}

export interface RenderDebateRebuttalOptions {
	round: number;
	peerCritiques: readonly PeerCritiqueItem[];
	operatorNotes?: string;
}

export function renderDebateRebuttal(options: RenderDebateRebuttalOptions): string {
	const exactValues: string[] = options.peerCritiques.map(p => p.critiqueText);
	if (options.operatorNotes) {
		exactValues.push(options.operatorNotes);
	}

	const replacements: Array<readonly [string, string]> = [];
	const mappedPeers = options.peerCritiques.map((p, idx) => {
		const placeholder = exactPlaceholder(`PEER_${idx}`, idx, exactValues);
		replacements.push([placeholder, p.critiqueText]);
		return {
			reviewerLabel: p.reviewerLabel,
			critiqueText: placeholder,
		};
	});

	let operatorNotesPlaceholder: string | undefined;
	if (options.operatorNotes) {
		operatorNotesPlaceholder = exactPlaceholder("OP", options.peerCritiques.length, exactValues);
		replacements.push([operatorNotesPlaceholder, options.operatorNotes]);
	}

	const rendered = prompt.render(debateRebuttalTemplate, {
		round: options.round,
		peerCritiques: mappedPeers,
		operatorNotes: operatorNotesPlaceholder,
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
}

export function renderUserFollowup(options: RenderUserFollowupOptions): string {
	const exactValues: string[] = [options.userMessage];
	if (options.peerUpdates) {
		for (const u of options.peerUpdates) {
			exactValues.push(u.updateText);
		}
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

	const rendered = prompt.render(userFollowupTemplate, {
		userMessage: userMsgPlaceholder,
		peerUpdates: mappedUpdates,
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
