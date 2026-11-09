import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { concreteThinkingLevel, resolveThinkingLevelForModel, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { PlanCouncilSettings } from "./settings";

export interface ReviewerMember {
	key: string; // `${model.provider}/${model.id}`
	label: string; // `${model.id} (${model.provider})`
	family: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface ResolvedCouncilRoster {
	reviewers: ReviewerMember[];
	available: ReviewerMember[];
	warnings: string[];
}

export function modelKey(model: Pick<Model, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export interface ModelSelection {
	model: Model;
	/** level from an explicit suffix or the matched role pattern; only OMP hosts with `ctx.models.resolveSelection` report it */
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** `ctx.models.resolveSelection` exists on newer OMP hosts; older ones resolve only the model */
type SelectionModelQuery = ExtensionModelQuery & {
	resolveSelection?: (spec: string) => ModelSelection | undefined;
};

function querySelection(models: ExtensionModelQuery, spec: string): ModelSelection | undefined {
	const query = models as SelectionModelQuery;
	if (query.resolveSelection) return query.resolveSelection(spec);
	const model = models.resolve(spec);
	return model ? { model } : undefined;
}

/** a requested level limited to what the model supports; `auto` and unset keep request defaults */
function supportedThinkingLevel(model: Model, level: ConfiguredThinkingLevel | undefined) {
	return resolveThinkingLevelForModel(model, concreteThinkingLevel(level));
}

export function resolveModelSpec(models: ExtensionModelQuery, spec: string): ModelSelection | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	return querySelection(models, trimmed) ?? (trimmed.startsWith("@") ? undefined : querySelection(models, `@${trimmed}`));
}

function isOutdatedSnapshot(id: string): boolean {
	return /-(202[0-4]\d{4}|202[0-4]\d{2})$/.test(id);
}

export const COUNCIL_ROLE_CHAINS = {
	council1: ["@council1", "@plan", "@default"],
	council2: ["@council2", "@smol", "@fast"],
	council3: ["@council3", "@slow", "@advisor", "@reasoning"],
	synthesizer: ["@council_synthesizer", "@council-synth", "@plan", "@slow", "@default"],
	reader: ["@council_reader", "@council-reader", "@smol", "@fast", "@default"],
	moderator: ["@council_moderator", "@council-moderator", "@smol", "@fast"],
};

/** resolve a council role through its existing model fallback chain */
export function resolveRoleWithBackup(models: ExtensionModelQuery, roleName: string): ModelSelection | undefined {
	const normalized = roleName.startsWith("@") ? roleName.slice(1) : roleName;
	const roleChains: Readonly<Record<string, readonly string[] | undefined>> = COUNCIL_ROLE_CHAINS;
	const chain = roleChains[normalized];
	if (chain) {
		for (const candidate of chain) {
			const resolved = resolveModelSpec(models, candidate);
			if (resolved) return resolved;
		}
	}
	return resolveModelSpec(models, roleName);
}

const CANDIDATE_ROLES = [
	...COUNCIL_ROLE_CHAINS.council1,
	...COUNCIL_ROLE_CHAINS.council2,
	...COUNCIL_ROLE_CHAINS.council3,
];
/** select reviewers while retaining explicit per reviewer thinking settings */
export function resolveCouncilRoster(models: ExtensionModelQuery, settings: PlanCouncilSettings): ResolvedCouncilRoster {
	const warnings: string[] = [];
	const availableList = models.list();
	const availableMap = new Map<string, ReviewerMember>();

	for (const model of availableList) {
		const key = modelKey(model);
		if (!availableMap.has(key)) {
			availableMap.set(key, {
				key,
				label: `${model.id} (${model.provider})`,
				family: models.family(model),
				model,
			});
		}
	}

	const available = Array.from(availableMap.values());
	if (available.length === 0) {
		return {
			reviewers: [],
			available: [],
			warnings: ["No authenticated chat models available."],
		};
	}

	if (settings.reviewerModels.length > 0) {
		const resolvedMap = new Map<string, ReviewerMember>();
		for (const spec of settings.reviewerModels) {
			const trimmed = spec.trim();
			const { base, level } = splitThinkingSuffix(trimmed, -1, MAX_THINKING_SUFFIX_OPTIONS);
			// try the full selector first so literal model ids keep their existing meaning
			const selection = resolveRoleWithBackup(models, trimmed) ?? (level ? resolveRoleWithBackup(models, base) : undefined);
			if (!selection) {
				warnings.push(`Unknown or unauthenticated reviewer model: "${spec}"`);
				continue;
			}
			const resolved = selection.model;
			const key = modelKey(resolved);
			if (!resolvedMap.has(key)) {
				const existing = availableMap.get(key);
				const reviewer: ReviewerMember = existing ?? {
					key,
					label: `${resolved.id} (${resolved.provider})`,
					family: models.family(resolved),
					model: resolved,
				};
				if (trimmed !== resolved.id && trimmed !== key) {
					// an explicit suffix wins; without one, use the level the role configures
					reviewer.thinkingLevel = supportedThinkingLevel(resolved, level ?? selection.thinkingLevel);
				}
				// keep the same reviewer object for model toggles and targeted replies
				resolvedMap.set(key, reviewer);
			}
		}

		return {
			reviewers: Array.from(resolvedMap.values()),
			available,
			warnings,
		};
	}
	// If explicit council roles are configured (e.g. @council1, @council2, @council3), use them directly
	const explicitCouncilMembers: ReviewerMember[] = [];
	for (const role of ["@council1", "@council2", "@council3", "@council4", "@council5", "@council6"]) {
		const selection = querySelection(models, role);
		if (selection) {
			const resolved = selection.model;
			const key = modelKey(resolved);
			if (!explicitCouncilMembers.some(m => m.key === key)) {
				const member: ReviewerMember = availableMap.get(key) ?? {
					key,
					label: `${resolved.id} (${resolved.provider})`,
					family: models.family(resolved),
					model: resolved,
				};
				const roleLevel = supportedThinkingLevel(resolved, selection.thinkingLevel);
				if (roleLevel) member.thinkingLevel = roleLevel;
				explicitCouncilMembers.push(member);
			}
		}
	}
	if (explicitCouncilMembers.length > 0) {
		return {
			reviewers: explicitCouncilMembers.slice(0, settings.maxReviewers),
			available,
			warnings,
		};
	}


	const planningModel = models.current();
	const planningKey = planningModel ? modelKey(planningModel) : undefined;
	const candidateModels: Model[] = [];
	// auto-selected reviewers found through a role keep that role's level (first role wins)
	const roleLevels = new Map<string, ConfiguredThinkingLevel>();

	for (const role of CANDIDATE_ROLES) {
		const selection = resolveModelSpec(models, role);
		if (selection) {
			candidateModels.push(selection.model);
			const key = modelKey(selection.model);
			if (selection.thinkingLevel !== undefined && !roleLevels.has(key)) roleLevels.set(key, selection.thinkingLevel);
		}
	}

	for (const m of available) {
		if (!isOutdatedSnapshot(m.model.id)) {
			candidateModels.push(m.model);
		}
	}

	const dedupedCandidates = new Map<string, ReviewerMember>();
	for (const m of candidateModels) {
		const key = modelKey(m);
		if (available.length > 1 && planningKey && key === planningKey) {
			continue;
		}
		if (!dedupedCandidates.has(key)) {
			const member: ReviewerMember = availableMap.get(key) ?? {
				key,
				label: `${m.id} (${m.provider})`,
				family: models.family(m),
				model: m,
			};
			const roleLevel = supportedThinkingLevel(m, roleLevels.get(key));
			if (roleLevel) member.thinkingLevel = roleLevel;
			dedupedCandidates.set(key, member);
		}
	}

	const candidateList = Array.from(dedupedCandidates.values());
	const planningFamily = planningModel ? models.family(planningModel) : "";

	const prioritized = [
		...candidateList.filter(m => !planningFamily || m.family !== planningFamily),
		...candidateList.filter(m => Boolean(planningFamily) && m.family === planningFamily),
	];

	// Pass 1: select up to maxReviewers with distinct families
	const selected: ReviewerMember[] = [];
	const seenFamilies = new Set<string>();

	for (const candidate of prioritized) {
		if (selected.length >= settings.maxReviewers) {
			break;
		}
		if (!seenFamilies.has(candidate.family)) {
			seenFamilies.add(candidate.family);
			selected.push(candidate);
		}
	}

	// Pass 2: if < min(2, maxReviewers), fill with remaining candidates regardless of family
	const minTarget = Math.min(2, settings.maxReviewers);
	if (selected.length < minTarget) {
		const selectedKeys = new Set(selected.map(m => m.key));
		for (const candidate of prioritized) {
			if (selected.length >= minTarget) {
				break;
			}
			if (!selectedKeys.has(candidate.key)) {
				selectedKeys.add(candidate.key);
				selected.push(candidate);
			}
		}
	}

	return {
		reviewers: selected,
		available,
		warnings,
	};
}

export interface ResolvedRoleModel {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** resolve a role model: an explicit selector with optional thinking suffix, else the role chain, else a last-resort model */
export function resolveRoleModel(
	models: ExtensionModelQuery,
	spec: string | undefined,
	chain: readonly string[],
	lastResort: Model | undefined,
): ResolvedRoleModel | undefined {
	const trimmed = spec?.trim();
	if (trimmed) {
		const { base, level } = splitThinkingSuffix(trimmed, -1, MAX_THINKING_SUFFIX_OPTIONS);
		// resolve the full selector first to preserve model ids with a literal thinking suffix
		const selection = resolveRoleWithBackup(models, trimmed) ?? (level ? resolveRoleWithBackup(models, base) : undefined);
		if (selection) {
			const resolved = selection.model;
			const literalId =
				trimmed.toLowerCase() === resolved.id.toLowerCase() ||
				trimmed.toLowerCase() === modelKey(resolved).toLowerCase();
			return {
				model: resolved,
				thinkingLevel: supportedThinkingLevel(resolved, (literalId ? undefined : level) ?? selection.thinkingLevel),
			};
		}
	}

	// a fallback role uses its own level; an unresolved selector's suffix is not carried over
	for (const candidate of chain) {
		const selection = resolveModelSpec(models, candidate);
		if (selection) {
			return { model: selection.model, thinkingLevel: supportedThinkingLevel(selection.model, selection.thinkingLevel) };
		}
	}

	// the session model and reviewers carry no level
	return lastResort ? { model: lastResort } : undefined;
}

/** the synthesizer model and its level: an explicit suffix, else the level its role configures */
export function resolveSynthesizer(
	models: ExtensionModelQuery,
	settings: PlanCouncilSettings,
	activeReviewers: readonly ReviewerMember[],
): ResolvedRoleModel | undefined {
	return resolveRoleModel(
		models,
		settings.synthesizerModel,
		COUNCIL_ROLE_CHAINS.synthesizer,
		models.current() ?? activeReviewers[0]?.model,
	);
}

/** the shared codebase reader and its level: an explicit suffix, else the level its role configures */
export function resolveReaderModel(
	models: ExtensionModelQuery,
	settings: PlanCouncilSettings,
	activeReviewers: readonly ReviewerMember[],
): ResolvedRoleModel | undefined {
	return resolveRoleModel(
		models,
		settings.readerModel,
		COUNCIL_ROLE_CHAINS.reader,
		models.current() ?? activeReviewers[0]?.model,
	);
}

export function resolveModeratorModel(
	models: ExtensionModelQuery,
	settings: PlanCouncilSettings,
): ResolvedRoleModel | undefined {
	return resolveRoleModel(
		models,
		settings.moderatorModel,
		COUNCIL_ROLE_CHAINS.moderator,
		undefined,
	);
}

/** the reviewer a `@model` handle names: exact model id or key first, else a unique substring match */
export function matchReviewerHandle(handle: string, reviewers: readonly ReviewerMember[]): ReviewerMember | undefined {
	const token = handle.trim().replace(/^@+/, "").toLowerCase();
	if (!token) return undefined;
	const exact = reviewers.find(r => r.model.id.toLowerCase() === token || r.key.toLowerCase() === token);
	if (exact) return exact;
	const candidates = reviewers.filter(r => r.model.id.toLowerCase().includes(token) || r.key.toLowerCase().includes(token));
	return candidates.length === 1 ? candidates[0] : undefined;
}

