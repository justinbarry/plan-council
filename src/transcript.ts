import type { CouncilRun, CouncilTurnEntry } from "./council-session";

/** one run's part of the Council transcript */
export interface TranscriptSection {
	run: CouncilRun;
	/** entries tagged with this run, in insertion order (operator messages queued during it included) */
	entries: CouncilTurnEntry[];
	/** a Q&A run's question when it is shown in an earlier run's section */
	answering?: CouncilTurnEntry & { kind: "user" };
	/**
	 * entries that belong to no run, e.g. an operator message queued while only a reader query was running and then
	 * stopped before any run answered it; `run` is a stand-in with a negative ID
	 */
	unassigned?: boolean;
}

/**
 * one section per run in start order, so a stopped run with no turns still has a place for its recap; entries keep
 * insertion order (parallel critiques are appended before they finish). Consecutive entries that belong to no run
 * form their own section, placed before the first run whose first entry comes after them, so nothing is dropped.
 */
export function buildTranscript(runs: readonly CouncilRun[], entries: readonly CouncilTurnEntry[]): TranscriptSection[] {
	const runIds = new Set(runs.map(run => run.id));
	const byRun = new Map<number, CouncilTurnEntry[]>();
	const firstIndex = new Map<number, number>();
	const unassigned: Array<{ start: number; end: number; entries: CouncilTurnEntry[] }> = [];
	entries.forEach((entry, index) => {
		if (entry.runId !== undefined && runIds.has(entry.runId)) {
			const list = byRun.get(entry.runId);
			if (list) list.push(entry);
			else byRun.set(entry.runId, [entry]);
			if (!firstIndex.has(entry.runId)) firstIndex.set(entry.runId, index);
			return;
		}
		const group = unassigned.at(-1);
		if (group && group.end === index - 1) {
			group.entries.push(entry);
			group.end = index;
		} else {
			unassigned.push({ start: index, end: index, entries: [entry] });
		}
	});

	const sections: TranscriptSection[] = [];
	let nextGroup = 0;
	const flushUnassignedBefore = (limit: number) => {
		for (; nextGroup < unassigned.length && unassigned[nextGroup].start < limit; nextGroup++) {
			const group = unassigned[nextGroup];
			sections.push({
				run: { id: -(group.start + 1), kind: "qa", round: group.entries[0].round, status: "done" },
				entries: group.entries,
				unassigned: true,
			});
		}
	};
	for (const run of runs) {
		const start = firstIndex.get(run.id);
		if (start !== undefined) flushUnassignedBefore(start);
		const section: TranscriptSection = { run, entries: byRun.get(run.id) ?? [] };
		const question = run.userEntryId ? entries.find(e => e.id === run.userEntryId) : undefined;
		if (question?.kind === "user" && question.runId !== run.id) section.answering = question;
		sections.push(section);
	}
	flushUnassignedBefore(Number.POSITIVE_INFINITY);
	return sections;
}

/**
 * the first line of a turn worth showing folded: skips blank lines and markdown headings, drops list, quote, and
 * heading markers, `**bold**` markers, and inline backticks (single `_`/`*` stay: identifiers use them)
 */
export function firstProseLine(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || /^#{1,6}\s/.test(line)) continue;
		return line
			.replace(/^(?:>\s*)+/, "")
			.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
			.replace(/`/g, "")
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.trim();
	}
	return "";
}
