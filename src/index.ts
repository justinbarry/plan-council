import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	PlanReviewRequestedEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { CouncilSession, extractSessionGoalContext } from "./council-session";
import { resolveCouncilRoster, resolveSynthesizerModel } from "./models";
import { type CouncilOverlayOutcome, PlanCouncilOverlay } from "./overlay";
import { DEFAULT_PLAN_COUNCIL_SETTINGS, loadPlanCouncilSettings, type PlanCouncilSettings } from "./settings";

export * from "./settings";
export * from "./models";
export * from "./council-session";
export * from "./overlay";

export default function planCouncilExtension(pi: ExtensionAPI): void {
	let currentSettings: PlanCouncilSettings = { ...DEFAULT_PLAN_COUNCIL_SETTINGS };
	let activeReview: PlanReviewRequestedEvent | undefined;
	let latestCtx: ExtensionContext | undefined;
	let overlayOpen = false;
	let overlayAbort: AbortController | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let cachedCouncil: { key: string; session: CouncilSession } | undefined;

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

	async function launchCouncilOverlay(
		ctx: ExtensionContext | ExtensionCommandContext,
		review: PlanReviewRequestedEvent,
		options: { startCritiquesImmediately?: boolean; autoProceed?: boolean } = {},
	): Promise<void> {
		if (overlayOpen || !ctx.hasUI || ctx.agent.kind === "sub") {
			return;
		}

		overlayOpen = true;
		overlayAbort = new AbortController();

		try {
			currentSettings = await loadPlanCouncilSettings(ctx.cwd);
			const roster = resolveCouncilRoster(ctx.models, currentSettings);
			const synthModel = resolveSynthesizerModel(ctx.models, currentSettings, roster.reviewers);

			const sessionCacheKey = `${review.sessionId}:${review.planFilePath}:${Bun.hash(review.planContent)}`;
			let session: CouncilSession;

			if (cachedCouncil && cachedCouncil.key === sessionCacheKey) {
				session = cachedCouncil.session;
			} else {
				if (cachedCouncil) {
					cachedCouncil.session.dispose();
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
				});

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
							synthesizerModel: synthModel,
							warnings: roster.warnings,
							autoProceed,
							autoDebate: currentSettings.autoDebate,
							maxDebateRounds: currentSettings.maxDebateRounds,
						},
						done,
					),
				{
					overlay: true,
					signal: overlayAbort.signal,
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

			if (outcome.action === "refine") {
				const resolved = ctx.resolvePlanReview(review.reviewId, "refine", { feedback: outcome.feedback });
				if (!resolved) {
					ctx.ui.notify("Failed to apply refined plan feedback.", "warning");
				}
			} else if (outcome.action === "approve") {
				const resolved = ctx.resolvePlanReview(review.reviewId, outcome.choice);
				if (!resolved) {
					ctx.ui.notify(`Failed to approve plan with choice "${outcome.choice}".`, "warning");
				}
			}
		} catch (err) {
			if (!(err instanceof Error && err.name === "AbortError")) {
				logger.error("Plan Council overlay error", { error: err });
			}
		} finally {
			overlayOpen = false;
			overlayAbort = undefined;
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
			activeReview = undefined;
			if (overlayAbort) {
				overlayAbort.abort();
				overlayAbort = undefined;
			}
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
		activeReview = undefined;
		overlayOpen = false;
		ctx.ui.setStatus("plan-council", undefined);
	});
}
