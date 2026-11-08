import {
	type,
	type AssistantMessage,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	validateToolArguments,
} from "@oh-my-pi/pi-ai";

export const REPORT_POSITION_TOOL_NAME = "report_position";

export const positionSchema = type({
	verdict: type("'APPROVE' | 'NEEDS REVISION' | 'BLOCK'").describe("Your current bottom-line verdict on the plan."),
	revisions: type({ summary: type("string > 0").describe("One required plan change, one sentence.") })
		.array()
		.describe(
			"Every change you require in the plan, in the order they appear in your review. Empty when you require none.",
		),
	positions: type({
		id: type("string > 0").describe("A peer revision ID exactly as listed in the prompt."),
		stance: type("'agree' | 'dispute'"),
		"reason?": type("string").describe("Required for dispute: why the peer item is wrong, unnecessary, or must change."),
	})
		.array()
		.describe("One entry for every peer revision ID listed in the prompt. Empty when none are listed."),
});

export const REPORT_POSITION_TOOL: Tool = {
	name: REPORT_POSITION_TOOL_NAME,
	description:
		"Record your verdict, your required plan revisions, and your stance on each peer revision ID listed in the prompt. Call it once, after your written review.",
	parameters: positionSchema,
};

export interface RevisionItem {
	id: string;
	summary: string;
}

export interface ItemPosition {
	id: string;
	stance: "agree" | "dispute";
	reason: string;
}

export interface ReviewerPosition {
	verdict: "APPROVE" | "NEEDS REVISION" | "BLOCK";
	revisions: RevisionItem[];
	positions: ItemPosition[];
	/** peer item IDs the reviewer was shown in the prompt that produced this report */
	promptedItemIds: string[];
}

export interface ParsedPosition {
	position?: ReviewerPosition;
	positionError?: string;
	toolResults: ToolResultMessage[];
}

export interface ConvergenceReport {
	converged: boolean;
	items: RevisionItem[];
	disputes: { id: string; by: string; reason: string }[];
	/** peer items a reviewer has no stance on: listed without one, or not yet shown (Round 1, or added since its last prompt) */
	uncovered: { id: string; by: string }[];
	/** labels of active reviewers whose latest completed turn has no valid report */
	unreported: string[];
}

/** validate one report_position call into a position; throws the validator's message when the arguments are invalid */
export function validateReportedPosition(
	block: ToolCall,
	reviewerKey: string,
	promptedItemIds: readonly string[],
): ReviewerPosition {
	// the shared validator repairs common model quirks (e.g. arrays sent as JSON strings) before rejecting
	const args = validateToolArguments(REPORT_POSITION_TOOL, block) as typeof positionSchema.infer;
	return {
		verdict: args.verdict,
		revisions: args.revisions.map((r, index) => ({ id: `${reviewerKey}#${index + 1}`, summary: r.summary })),
		positions: args.positions.map(p => ({ id: p.id, stance: p.stance, reason: p.reason ?? "" })),
		promptedItemIds: [...promptedItemIds],
	};
}

/** answer every tool call in the message (providers reject unanswered calls) and extract the last valid report */
export function parseReviewerPosition(
	msg: AssistantMessage,
	reviewerKey: string,
	promptedItemIds: string[],
	allowedToolNames: readonly string[] = [REPORT_POSITION_TOOL_NAME],
): ParsedPosition {
	const parsed: ParsedPosition = { toolResults: [] };
	let reported = false;

	for (const block of msg.content) {
		if (block.type !== "toolCall") continue;

		let text: string;
		let isError: boolean;
		if (block.name !== REPORT_POSITION_TOOL_NAME) {
			text =
				allowedToolNames.length > 1
					? `Unknown tool "${block.name}"; available tools: ${allowedToolNames.join(", ")}.`
					: `Unknown tool "${block.name}"; only ${REPORT_POSITION_TOOL_NAME} is available.`;
			isError = true;
		} else {
			reported = true;
			try {
				parsed.position = validateReportedPosition(block, reviewerKey, promptedItemIds);
				text = "Position recorded.";
				isError = false;
			} catch (err) {
				text = err instanceof Error ? err.message : String(err);
				isError = true;
				parsed.positionError = text;
			}
		}

		parsed.toolResults.push({
			role: "toolResult",
			toolCallId: block.id,
			toolName: block.name,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		});
	}

	if (!reported) {
		parsed.positionError = `No ${REPORT_POSITION_TOOL_NAME} call`;
	}
	return parsed;
}

export function computeConvergence(reviewers: { label: string; position?: ReviewerPosition }[]): ConvergenceReport {
	const report: ConvergenceReport = { converged: false, items: [], disputes: [], uncovered: [], unreported: [] };

	for (const reviewer of reviewers) {
		if (reviewer.position) {
			report.items.push(...reviewer.position.revisions);
		} else {
			report.unreported.push(reviewer.label);
		}
	}

	const heldIds = new Set(report.items.map(i => i.id));
	for (const reviewer of reviewers) {
		const position = reviewer.position;
		if (!position) continue;
		// stances on IDs outside the prompt, or on items their owner has since dropped, are moot
		for (const id of position.promptedItemIds) {
			if (!heldIds.has(id)) continue;
			const stance = position.positions.find(p => p.id === id);
			if (!stance) {
				report.uncovered.push({ id, by: reviewer.label });
			} else if (stance.stance === "dispute") {
				report.disputes.push({ id, by: reviewer.label, reason: stance.reason });
			}
		}
		// a peer item this reviewer was never shown has not been agreed to
		const prompted = new Set(position.promptedItemIds);
		for (const other of reviewers) {
			if (other === reviewer || !other.position) continue;
			for (const item of other.position.revisions) {
				if (!prompted.has(item.id)) {
					report.uncovered.push({ id: item.id, by: reviewer.label });
				}
			}
		}
	}

	report.converged =
		report.unreported.length === 0 && report.uncovered.length === 0 && report.disputes.length === 0;
	return report;
}

/** at least one reviewer, every reviewer reported APPROVE, and none requires a change */
export function isUnanimousApproval(
	report: ConvergenceReport,
	verdicts: (ReviewerPosition["verdict"] | undefined)[],
): boolean {
	return report.converged && report.items.length === 0 && verdicts.length > 0 && verdicts.every(v => v === "APPROVE");
}

export function openDisagreementCount(report: ConvergenceReport): number {
	return report.disputes.length + report.uncovered.length + report.unreported.length;
}

/** every active reviewer's current verdict and required revisions, so tool-only turns still reach synthesis */
export function formatReportedPositions(reviewers: { label: string; position?: ReviewerPosition }[]): string {
	return reviewers
		.map(({ label, position }) => {
			if (!position) return `- ${label}: no position reported`;
			if (position.revisions.length === 0) return `- ${label}: ${position.verdict}, no required revisions`;
			return [`- ${label}: ${position.verdict}`, ...position.revisions.map(r => `  - \`${r.id}\`: ${r.summary}`)].join(
				"\n",
			);
		})
		.join("\n");
}

export function formatConvergence(report: ConvergenceReport, items: RevisionItem[]): string {
	if (report.converged) {
		return "All reviewers reported agreement on every listed revision.";
	}
	const summaries = new Map(items.map(i => [i.id, i.summary]));
	const lines: string[] = [];
	for (const d of report.disputes) {
		const summary = summaries.get(d.id);
		lines.push(`- ${d.id}${summary === undefined ? "" : ` ("${summary}")`} disputed by ${d.by}: ${d.reason}`);
	}
	for (const u of report.uncovered) {
		lines.push(`- ${u.id} not addressed by ${u.by}`);
	}
	if (report.unreported.length > 0) {
		lines.push(`- No position reported: ${report.unreported.join(", ")}`);
	}
	return lines.join("\n");
}
