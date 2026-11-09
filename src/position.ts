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
			"Your complete standing set of still-required plan changes, including settled ones your prose no longer repeats. Reuse an unchanged prior summary verbatim, update a narrowed summary, and omit retracted ones. Empty only when you require no changes.",
		),
	positions: type({
		id: type("string > 0").describe("A revision ID exactly as listed under ### Peer required revisions."),
		stance: type("'agree' | 'dispute'"),
		"reason?": type("string").describe("Required for dispute: why the peer item is wrong, unnecessary, or must change."),
	})
		.array()
		.describe(
			"One entry for each revision ID listed under ### Peer required revisions and no others: never your own IDs from ### Peer challenges to your revisions or IDs quoted in peer replies. Empty when none are listed there.",
		),
	"nextSpeaker?": type("string").describe(
		"Optional @model handle (or provider/model key) of one peer you are asking to respond next. Set only when handing them the floor; omit for passing mentions.",
	),
	"questionForOperator?": type("string").describe(
		"One concise question only the human operator can answer (intent, scope, priorities) that your stance depends on. Omit when none.",
	),
});

export const REPORT_POSITION_TOOL: Tool = {
	name: REPORT_POSITION_TOOL_NAME,
	description:
		"Record your verdict, your complete standing set of required plan revisions, and your stance on each revision ID listed under ### Peer required revisions. Call it once, after your written reply.",
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
	/** model id or key of the peer the reviewer handed the floor to, without a leading `@` */
	nextSpeaker?: string;
	/** a question only the operator can answer that the reviewer's stance depends on */
	operatorQuestion?: string;
}

/** how a reviewer's position moved between two consecutive reports */
export interface PositionDelta {
	/** previous verdict, present only when the verdict changed */
	verdictFrom?: ReviewerPosition["verdict"];
	/** own revisions whose IDs did not exist in the previous position */
	added: RevisionItem[];
	/** previous own revisions whose IDs are gone */
	dropped: RevisionItem[];
	/** peer IDs with an `agree` stance now that were not agreed in the previous position */
	agreed: string[];
	/** peer IDs with a `dispute` stance now that were not disputed in the previous position */
	disputed: string[];
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
	const next = args.nextSpeaker?.trim().replace(/^@+/, "");
	const question = args.questionForOperator?.trim();
	return {
		verdict: args.verdict,
		revisions: args.revisions.map((r, index) => ({ id: `${reviewerKey}#${index + 1}`, summary: r.summary })),
		positions: args.positions.map(p => ({ id: p.id, stance: p.stance, reason: p.reason ?? "" })),
		promptedItemIds: [...promptedItemIds],
		...(next ? { nextSpeaker: next } : {}),
		...(question ? { operatorQuestion: question } : {}),
	};
}

function normalizeSummary(summary: string): string {
	return summary.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * keep a revision's ID while its summary is unchanged (ignoring case and whitespace) so peer stances stay attached
 * to the same item; a new or reworded summary gets a never-used `#N`, so peers must judge the new wording
 */
export function stabilizeRevisionIds(
	reviewerKey: string,
	summaries: readonly { summary: string }[],
	previous: readonly RevisionItem[],
	nextNumber: number,
): { revisions: RevisionItem[]; nextNumber: number } {
	const available = [...previous];
	let seq = Math.max(1, nextNumber);
	for (const item of previous) {
		const n = Number(item.id.slice(item.id.lastIndexOf("#") + 1));
		if (Number.isInteger(n) && n >= seq) seq = n + 1;
	}

	const revisions = summaries.map(({ summary }) => {
		const normalized = normalizeSummary(summary);
		const index = available.findIndex(item => normalizeSummary(item.summary) === normalized);
		if (index === -1) return { id: `${reviewerKey}#${seq++}`, summary };
		const [matched] = available.splice(index, 1);
		return { id: matched.id, summary };
	});
	return { revisions, nextNumber: seq };
}

/** first stance per peer ID, the one computeConvergence counts */
function firstStances(position: ReviewerPosition): Map<string, ItemPosition["stance"]> {
	const stances = new Map<string, ItemPosition["stance"]>();
	for (const p of position.positions) {
		if (!stances.has(p.id)) stances.set(p.id, p.stance);
	}
	return stances;
}

/** what changed between two reports; revisions compare by stable ID, so a reworded item is one drop plus one add */
export function computePositionDelta(previous: ReviewerPosition, next: ReviewerPosition): PositionDelta {
	const previousIds = new Set(previous.revisions.map(r => r.id));
	const nextIds = new Set(next.revisions.map(r => r.id));
	const before = firstStances(previous);
	const agreed: string[] = [];
	const disputed: string[] = [];
	for (const [id, stance] of firstStances(next)) {
		if (stance === before.get(id)) continue;
		if (stance === "agree") agreed.push(id);
		else disputed.push(id);
	}
	return {
		...(previous.verdict !== next.verdict ? { verdictFrom: previous.verdict } : {}),
		added: next.revisions.filter(r => !previousIds.has(r.id)),
		dropped: previous.revisions.filter(r => !nextIds.has(r.id)),
		agreed,
		disputed,
	};
}

export function isEmptyPositionDelta(delta: PositionDelta): boolean {
	return (
		delta.verdictFrom === undefined &&
		delta.added.length === 0 &&
		delta.dropped.length === 0 &&
		delta.agreed.length === 0 &&
		delta.disputed.length === 0
	);
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
