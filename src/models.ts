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

export function resolveModelSpec(models: ExtensionModelQuery, spec: string): Model | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	return models.resolve(trimmed) ?? (trimmed.startsWith("@") ? undefined : models.resolve(`@${trimmed}`));
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
};

/** resolve a council role through its existing model fallback chain */
export function resolveRoleWithBackup(models: ExtensionModelQuery, roleName: string): Model | undefined {
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
			const resolved = resolveRoleWithBackup(models, trimmed) ?? (level ? resolveRoleWithBackup(models, base) : undefined);
			if (!resolved) {
				warnings.push(`Unknown or unauthenticated reviewer model: "${spec}"`);
				continue;
			}
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
					reviewer.thinkingLevel = resolveThinkingLevelForModel(resolved, concreteThinkingLevel(level));
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
		const resolved = models.resolve(role);
		if (resolved) {
			const key = modelKey(resolved);
			const existing = availableMap.get(key);
			if (!explicitCouncilMembers.some(m => m.key === key)) {
				explicitCouncilMembers.push(
					existing ?? {
						key,
						label: `${resolved.id} (${resolved.provider})`,
						family: models.family(resolved),
						model: resolved,
					},
				);
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

	for (const role of CANDIDATE_ROLES) {
		const m = resolveModelSpec(models, role);
		if (m) {
			candidateModels.push(m);
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
			const existing = availableMap.get(key);
			dedupedCandidates.set(
				key,
				existing ?? {
					key,
					label: `${m.id} (${m.provider})`,
					family: models.family(m),
					model: m,
				},
			);
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

export function resolveSynthesizerModel(
	models: ExtensionModelQuery,
	settings: PlanCouncilSettings,
	activeReviewers: readonly ReviewerMember[],
): Model | undefined {
	if (settings.synthesizerModel) {
		const resolved = resolveRoleWithBackup(models, settings.synthesizerModel);
		if (resolved) {
			return resolved;
		}
	}

	for (const candidate of COUNCIL_ROLE_CHAINS.synthesizer) {
		const resolved = resolveModelSpec(models, candidate);
		if (resolved) {
			return resolved;
		}
	}

	return models.current() ?? activeReviewers[0]?.model;
}

export interface ResolvedReaderModel {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/** resolve the shared codebase reader: explicit selector (with optional :effort), then the reader role chain, then the session model */
export function resolveReaderModel(
	models: ExtensionModelQuery,
	settings: PlanCouncilSettings,
	activeReviewers: readonly ReviewerMember[],
): ResolvedReaderModel | undefined {
	const trimmed = settings.readerModel?.trim();
	if (trimmed) {
		const { base, level } = splitThinkingSuffix(trimmed, -1, MAX_THINKING_SUFFIX_OPTIONS);
		// try the full selector first so literal model ids keep their existing meaning
		const resolved = resolveRoleWithBackup(models, trimmed) ?? (level ? resolveRoleWithBackup(models, base) : undefined);
		if (resolved) {
			const thinkingLevel =
				level !== undefined && trimmed !== resolved.id && trimmed !== modelKey(resolved)
					? resolveThinkingLevelForModel(resolved, concreteThinkingLevel(level))
					: undefined;
			return { model: resolved, thinkingLevel };
		}
	}

	for (const candidate of COUNCIL_ROLE_CHAINS.reader) {
		const resolved = resolveModelSpec(models, candidate);
		if (resolved) {
			return { model: resolved };
		}
	}

	const fallback = models.current() ?? activeReviewers[0]?.model;
	return fallback ? { model: fallback } : undefined;
}
