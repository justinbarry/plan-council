import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { logger } from "@oh-my-pi/pi-utils";

export const PLUGIN_NAME = "plan-council";

export interface PlanCouncilSettings {
	autoStart: boolean;
	autoProceed: boolean;
	autoDebate: boolean;
	reviewerModels: string[];
	maxReviewers: number;
	maxDebateRounds: number;
	/** consecutive automatic refines of one plan before auto mode waits for the operator */
	maxAutoRefines: number;
	synthesizerModel: string | undefined;
	shortcut: string;
	includeSessionContext: boolean;
	enableCodeReader: boolean;
	readerModel: string | undefined;
	maxReaderQueriesPerTurn: number;
}

export const DEFAULT_PLAN_COUNCIL_SETTINGS: PlanCouncilSettings = {
	autoStart: false,
	autoProceed: false,
	autoDebate: true,
	reviewerModels: [],
	maxReviewers: 3,
	maxDebateRounds: 3,
	maxAutoRefines: 2,
	synthesizerModel: undefined,
	shortcut: "ctrl+n",
	includeSessionContext: true,
	enableCodeReader: true,
	readerModel: undefined,
	maxReaderQueriesPerTurn: 3,
};

export function parsePlanCouncilSettings(raw: Record<string, unknown>): PlanCouncilSettings {
	const autoStart = typeof raw.autoStart === "boolean" ? raw.autoStart : DEFAULT_PLAN_COUNCIL_SETTINGS.autoStart;
	const autoProceed = typeof raw.autoProceed === "boolean" ? raw.autoProceed : DEFAULT_PLAN_COUNCIL_SETTINGS.autoProceed;
	const autoDebate = typeof raw.autoDebate === "boolean" ? raw.autoDebate : DEFAULT_PLAN_COUNCIL_SETTINGS.autoDebate;

	let reviewerModels: string[] = [];
	if (typeof raw.reviewerModels === "string") {
		reviewerModels = raw.reviewerModels
			.split(",")
			.map(s => s.trim())
			.filter(Boolean);
	} else if (Array.isArray(raw.reviewerModels)) {
		reviewerModels = raw.reviewerModels
			.map(item => (typeof item === "string" ? item.trim() : ""))
			.filter(Boolean);
	}

	let maxReviewers = DEFAULT_PLAN_COUNCIL_SETTINGS.maxReviewers;
	if (typeof raw.maxReviewers === "number" && !Number.isNaN(raw.maxReviewers)) {
		maxReviewers = Math.min(6, Math.max(1, Math.round(raw.maxReviewers)));
	} else if (typeof raw.maxReviewers === "string") {
		const parsed = Number.parseInt(raw.maxReviewers, 10);
		if (!Number.isNaN(parsed)) {
			maxReviewers = Math.min(6, Math.max(1, parsed));
		}
	}

	let maxDebateRounds = DEFAULT_PLAN_COUNCIL_SETTINGS.maxDebateRounds;
	if (typeof raw.maxDebateRounds === "number" && !Number.isNaN(raw.maxDebateRounds)) {
		maxDebateRounds = Math.min(5, Math.max(1, Math.round(raw.maxDebateRounds)));
	} else if (typeof raw.maxDebateRounds === "string") {
		const parsed = Number.parseInt(raw.maxDebateRounds, 10);
		if (!Number.isNaN(parsed)) {
			maxDebateRounds = Math.min(5, Math.max(1, parsed));
		}
	}

	let maxAutoRefines = DEFAULT_PLAN_COUNCIL_SETTINGS.maxAutoRefines;
	const rawAutoRefines =
		typeof raw.maxAutoRefines === "string" ? Number.parseInt(raw.maxAutoRefines, 10) : raw.maxAutoRefines;
	if (typeof rawAutoRefines === "number" && Number.isFinite(rawAutoRefines)) {
		maxAutoRefines = Math.min(10, Math.max(0, Math.round(rawAutoRefines)));
	}

	const synthesizerModel =
		typeof raw.synthesizerModel === "string" && raw.synthesizerModel.trim()
			? raw.synthesizerModel.trim()
			: DEFAULT_PLAN_COUNCIL_SETTINGS.synthesizerModel;

	const shortcut =
		typeof raw.shortcut === "string" && raw.shortcut.trim()
			? raw.shortcut.trim()
			: DEFAULT_PLAN_COUNCIL_SETTINGS.shortcut;

	const includeSessionContext =
		typeof raw.includeSessionContext === "boolean"
			? raw.includeSessionContext
			: DEFAULT_PLAN_COUNCIL_SETTINGS.includeSessionContext;

	const enableCodeReader =
		typeof raw.enableCodeReader === "boolean" ? raw.enableCodeReader : DEFAULT_PLAN_COUNCIL_SETTINGS.enableCodeReader;

	const readerModel =
		typeof raw.readerModel === "string" && raw.readerModel.trim()
			? raw.readerModel.trim()
			: DEFAULT_PLAN_COUNCIL_SETTINGS.readerModel;

	let maxReaderQueriesPerTurn = DEFAULT_PLAN_COUNCIL_SETTINGS.maxReaderQueriesPerTurn;
	if (typeof raw.maxReaderQueriesPerTurn === "number" && Number.isFinite(raw.maxReaderQueriesPerTurn)) {
		maxReaderQueriesPerTurn = Math.min(6, Math.max(1, Math.round(raw.maxReaderQueriesPerTurn)));
	} else if (typeof raw.maxReaderQueriesPerTurn === "string") {
		const parsed = Number.parseInt(raw.maxReaderQueriesPerTurn, 10);
		if (!Number.isNaN(parsed)) {
			maxReaderQueriesPerTurn = Math.min(6, Math.max(1, parsed));
		}
	}

	return {
		autoStart,
		autoProceed,
		autoDebate,
		reviewerModels,
		maxReviewers,
		maxDebateRounds,
		maxAutoRefines,
		synthesizerModel,
		shortcut,
		includeSessionContext,
		enableCodeReader,
		readerModel,
		maxReaderQueriesPerTurn,
	};
}

export async function loadPlanCouncilSettings(cwd: string): Promise<PlanCouncilSettings> {
	try {
		const raw = await getPluginSettings(PLUGIN_NAME, cwd);
		return parsePlanCouncilSettings(raw);
	} catch (error) {
		logger.warn("Failed to load plan-council plugin settings, falling back to defaults", { error, cwd });
		return { ...DEFAULT_PLAN_COUNCIL_SETTINGS };
	}
}
