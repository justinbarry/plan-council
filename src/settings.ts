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
	synthesizerModel: string | undefined;
	shortcut: string;
	includeSessionContext: boolean;
}

export const DEFAULT_PLAN_COUNCIL_SETTINGS: PlanCouncilSettings = {
	autoStart: false,
	autoProceed: false,
	autoDebate: true,
	reviewerModels: [],
	maxReviewers: 3,
	maxDebateRounds: 3,
	synthesizerModel: undefined,
	shortcut: "ctrl+n",
	includeSessionContext: true,
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

	return {
		autoStart,
		autoProceed,
		autoDebate,
		reviewerModels,
		maxReviewers,
		maxDebateRounds,
		synthesizerModel,
		shortcut,
		includeSessionContext,
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
