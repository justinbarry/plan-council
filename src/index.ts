import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	PlanReviewRequestedEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { CouncilCodeReader } from "./code-reader";
import { CouncilSession, extractSessionGoalContext } from "./council-session";
import { resolveCouncilRoster, resolveReaderModel, resolveSynthesizer } from "./models";
import { type CouncilOverlayOutcome, PlanCouncilOverlay } from "./overlay";
import { collectPlanReferencedFiles } from "./plan-files";
import { DEFAULT_PLAN_COUNCIL_SETTINGS, loadPlanCouncilSettings, type PlanCouncilSettings } from "./settings";

export * from "./settings";
export * from "./models";
export * from "./council-session";
export * from "./code-reader";
export * from "./overlay";
export * from "./plan-files";

/** injectable collaborators; OMP calls the extension with `pi` only */
export interface PlanCouncilExtensionDeps {
	collectPlanReferencedFiles?: typeof collectPlanReferencedFiles;
}

export default function planCouncilExtension(pi: ExtensionAPI, deps: PlanCouncilExtensionDeps = {}): void {
	let currentSettings: PlanCouncilSettings = { ...DEFAULT_PLAN_COUNCIL_SETTINGS };
	let activeReview: PlanReviewRequestedEvent | undefined;
	let latestCtx: ExtensionContext | undefined;
	let overlayOpen = false;
	let overlayAbort: AbortController | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let cachedCouncil: { key: string; session: CouncilSession } | undefined;
	/** automatic refines applied in a row, per agent session and plan file; an operator decision resets it */
	const autoRefineCounts = new Map<string, number>();
	const autoRefineKey = (review: PlanReviewRequestedEvent) => `${review.sessionId}:${review.planFilePath}`;

	function ensureInputListener(ctx: ExtensionContext, shortcut: string): void {
		if (unsubscribeInput || !ctx.hasUI || ctx.agent.kind === "sub") {
			return;
		}

		unsubscribeInput = ctx.ui.onTerminalInput(data => {
			if (activeReview !== undefined && !overlayOpen && matchesKey(data, shortcut as KeyId)) {
				const effectiveCtx = latestCtx ?? ctx;
				void launchCouncilOverlay(effectiveCtx, activeReview, { startCritiquesImmediately: true });
				return { consume: true };
			}
			return undefined;
		});
	}

	/**
	 * the council calls models between agent turns, so herdr's OMP integration would show the pane idle;
	 * hold it in Working through the integration's `herdr:working` event (OMP integration v11+, ignored otherwise)
	 */
	function reportCouncilWork(session: CouncilSession): void {
		let working = false;
		session.subscribe(() => {
			const active = session.isActive();
			if (active === working) return;
			working = active;
			pi.events.emit("herdr:working", { active });
		});
	}

	/** open the council with the latest reviewer and synthesizer selections */
	async function launchCouncilOverlay(
		ctx: ExtensionContext | ExtensionCommandContext,
		review: PlanReviewRequestedEvent,
		options: { startCritiquesImmediately?: boolean; autoProceed?: boolean } = {},
	): Promise<void> {
		if (overlayOpen || !ctx.hasUI || ctx.agent.kind === "sub") {
			return;
		}

		// claim the slot and the review synchronously: a resolution arriving mid-await must match this launch
		activeReview = review;
		const launchAbort = new AbortController();
		overlayOpen = true;
		overlayAbort = launchAbort;
		/** a resolved review or a newer launch supersedes this one; it must then leave shared state alone */
		const isCurrentLaunch = () => !launchAbort.signal.aborted && overlayAbort === launchAbort;

		try {
			currentSettings = await loadPlanCouncilSettings(ctx.cwd);
			if (!isCurrentLaunch()) return;
			const roster = resolveCouncilRoster(ctx.models, currentSettings);
			const synthesizer = resolveSynthesizer(ctx.models, currentSettings, roster.reviewers);
			const readerSpec = currentSettings.enableCodeReader
				? resolveReaderModel(ctx.models, currentSettings, roster.reviewers)
				: undefined;
			const warnings = [...roster.warnings];
			if (currentSettings.enableCodeReader && !readerSpec) {
				warnings.push("Codebase reader enabled, but no authenticated model is available for it.");
			}

			// toggling the reader, changing its model, or changing its per-turn cap rebuilds the cached council
			const readerCacheKey = readerSpec
				? `${readerSpec.model.provider}/${readerSpec.model.id}:${readerSpec.thinkingLevel ?? ""}:${currentSettings.maxReaderQueriesPerTurn}`
				: "off";
			const sessionCacheKey = `${review.sessionId}:${review.planFilePath}:${Bun.hash(review.planContent)}:${currentSettings.enableCodeReader}:${readerCacheKey}`;
			let session: CouncilSession;

			if (cachedCouncil && cachedCouncil.key === sessionCacheKey) {
				session = cachedCouncil.session;
			} else {
				// reviewers read the files the plan names in Round 1 instead of each asking the reader for them
				const referencedFiles = await (deps.collectPlanReferencedFiles ?? collectPlanReferencedFiles)(
					ctx.cwd,
					review.planContent,
					{ excludePaths: [review.planFilePath] },
				);
				if (!isCurrentLaunch()) return;

				if (cachedCouncil) {
					cachedCouncil.session.dispose();
					cachedCouncil = undefined;
				}

				let sessionContext: string | undefined;
				if (currentSettings.includeSessionContext && ctx.sessionManager?.getBranch) {
					sessionContext = extractSessionGoalContext(ctx.sessionManager.getBranch());
				}

				session = new CouncilSession({
					planTitle: review.title,
					planFilePath: review.planFilePath,
					planContent: review.planContent,
					sessionContext,
					availableReviewers: roster.available,
					initialReviewers: roster.reviewers,
					sessionId: review.sessionId,
					getApiKey: model =>
						ctx.modelRegistry?.resolver ? ctx.modelRegistry.resolver(model, review.sessionId) : undefined,
					codeReader: readerSpec
						? new CouncilCodeReader({
								cwd: ctx.cwd,
								model: readerSpec.model,
								thinkingLevel: readerSpec.thinkingLevel,
								planTitle: review.title,
								planFilePath: review.planFilePath,
								sessionId: review.sessionId,
								modelRegistry: ctx.modelRegistry,
								localProtocolOptions: ctx.localProtocolOptions,
							})
						: undefined,
					maxReaderQueriesPerTurn: currentSettings.maxReaderQueriesPerTurn,
					referencedFiles,
				});

				reportCouncilWork(session);
				cachedCouncil = { key: sessionCacheKey, session };
			}

			const autoProceed = options.autoProceed ?? currentSettings.autoProceed;
			// auto mode starts critiques through the overlay pipeline; pre-starting here leaves the session busy and the pipeline a no-op
			if (options.startCritiquesImmediately && !autoProceed && session.entries.length === 0 && roster.reviewers.length > 0) {
				void session.startInitialCritiques();
			}

			const outcome = await ctx.ui.custom<CouncilOverlayOutcome>(
				(tui, _theme, _keybindings, done) =>
					new PlanCouncilOverlay(
						tui,
						session,
						{
							reviewOptions: review.options,
							reviewTiers: review.tiers,
							synthesizerModel: synthesizer?.model,
							synthesizerThinkingLevel: synthesizer?.thinkingLevel,
							warnings,
							autoProceed,
							autoRefinesUsed: autoRefineCounts.get(autoRefineKey(review)) ?? 0,
							maxAutoRefines: currentSettings.maxAutoRefines,
							autoDebate: currentSettings.autoDebate,
							maxDebateRounds: currentSettings.maxDebateRounds,
						},
						done,
					),
				{
					overlay: true,
					signal: launchAbort.signal,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: 0,
						fullscreen: true,
						mouseTracking: false,
					},
				},
			);

			if (!isCurrentLaunch()) return;
			if (outcome.action === "refine") {
				const resolved = ctx.resolvePlanReview(review.reviewId, "refine", { feedback: outcome.feedback });
				if (!resolved) {
					ctx.ui.notify("Failed to apply refined plan feedback.", "warning");
				} else if (outcome.auto) {
					const key = autoRefineKey(review);
					autoRefineCounts.set(key, (autoRefineCounts.get(key) ?? 0) + 1);
				} else {
					autoRefineCounts.delete(autoRefineKey(review));
				}
			} else if (outcome.action === "approve") {
				// the overlay only reports a role when the review offers a tier slider; the host rejects one otherwise
				const resolved = ctx.resolvePlanReview(
					review.reviewId,
					outcome.choice,
					outcome.role ? { role: outcome.role } : undefined,
				);
				if (!resolved) {
					ctx.ui.notify(`Failed to approve plan with choice "${outcome.choice}".`, "warning");
				} else {
					autoRefineCounts.delete(autoRefineKey(review));
				}
			}
		} catch (err) {
			if (isCurrentLaunch() && !(err instanceof Error && err.name === "AbortError")) {
				logger.error("Plan Council overlay error", { error: err });
			}
		} finally {
			if (overlayAbort === launchAbort) {
				overlayOpen = false;
				overlayAbort = undefined;
			}
		}
	}

	pi.registerCommand("plan-council", {
		description: "Open multi-model Plan Council review and discussion overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.agent.kind === "sub") {
				return;
			}

			let review = ctx.getPendingPlanReview ? ctx.getPendingPlanReview() : undefined;
			if (!review) {
				if (ctx.openPlanReview) {
					const opened = await ctx.openPlanReview();
					if (opened && ctx.getPendingPlanReview) {
						review = ctx.getPendingPlanReview();
					}
				}
				if (!review) {
					ctx.ui.notify("Plan Council requires active plan mode with a saved plan file.", "warning");
					return;
				}
			}
			const wantsAuto = Boolean(_args && _args.includes("--auto"));
			await launchCouncilOverlay(ctx, review, {
				startCritiquesImmediately: true,
				autoProceed: wantsAuto || currentSettings.autoProceed,
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (!ctx.hasUI || ctx.agent.kind === "sub") {
			return;
		}
		currentSettings = await loadPlanCouncilSettings(ctx.cwd);
		ensureInputListener(ctx, currentSettings.shortcut);

		const pending = ctx.getPendingPlanReview ? ctx.getPendingPlanReview() : undefined;
		if (pending) {
			activeReview = pending;
			ctx.ui.setStatus("plan-council", ctx.ui.theme.fg("accent", `Council (${currentSettings.shortcut})`));
			if (currentSettings.autoStart || currentSettings.autoProceed) {
				void launchCouncilOverlay(ctx, pending, {
					startCritiquesImmediately: true,
					autoProceed: currentSettings.autoProceed,
				});
			}
		}
	});

	pi.on("plan_review_requested", (event, ctx) => {
		activeReview = event;
		latestCtx = ctx;
		if (!ctx.hasUI || ctx.agent.kind === "sub") {
			return;
		}

		void (async () => {
			currentSettings = await loadPlanCouncilSettings(ctx.cwd);
			ensureInputListener(ctx, currentSettings.shortcut);
			ctx.ui.setStatus("plan-council", ctx.ui.theme.fg("accent", `Council (${currentSettings.shortcut})`));

			if (currentSettings.autoStart || currentSettings.autoProceed) {
				void launchCouncilOverlay(ctx, event, {
					startCritiquesImmediately: true,
					autoProceed: currentSettings.autoProceed,
				});
			} else {
				ctx.ui.notify(`Plan Council ready — press ${currentSettings.shortcut} to discuss with other models`, "info");
			}
		})();
	});

	pi.on("plan_review_resolved", (event, ctx) => {
		if (activeReview?.reviewId === event.reviewId) {
			// the operator answered in the native review: auto mode may refine on its own again
			if (event.by === "local" && event.choice !== undefined) autoRefineCounts.delete(autoRefineKey(activeReview));
			activeReview = undefined;
			if (overlayAbort) {
				overlayAbort.abort();
				overlayAbort = undefined;
			}
			// free the launch slot now, even if a launch is still suspended before its overlay opens
			overlayOpen = false;
			if (cachedCouncil) {
				cachedCouncil.session.abortActiveRound();
			}
			ctx.ui.setStatus("plan-council", undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (unsubscribeInput) {
			unsubscribeInput();
			unsubscribeInput = undefined;
		}
		if (overlayAbort) {
			overlayAbort.abort();
			overlayAbort = undefined;
		}
		if (cachedCouncil) {
			cachedCouncil.session.dispose();
			cachedCouncil = undefined;
		}
		autoRefineCounts.clear();
		activeReview = undefined;
		overlayOpen = false;
		ctx.ui.setStatus("plan-council", undefined);
	});
}
