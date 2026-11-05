import type { ApiKey, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import {
	AgentRegistry,
	createAgentSession,
	SessionManager,
	Settings,
	type ModelRegistry,
} from "@oh-my-pi/pi-coding-agent";
import { concreteThinkingLevel, parseThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ReviewerMember } from "./models";
import { renderCritiqueSystem, renderInspectionAddendum } from "./prompts/render";

export interface InspectionActivity {
	attempted: number;
	failed: number;
}

export type ReviewerTurnResult = {
	text: string;
	inspection: InspectionActivity;
} & (
	| { status: "done" }
	| { status: "error"; errorMessage: string }
	| { status: "aborted" }
);

export interface ReviewerAgent {
	runTurn(prompt: string, signal: AbortSignal, onText: (delta: string) => void): Promise<ReviewerTurnResult>;
	dispose(): Promise<void>;
}

export type ReviewerAgentFactory = (reviewer: ReviewerMember) => Promise<ReviewerAgent>;

export interface NativeReviewerOptions {
	cwd: string;
	modelRegistry: ModelRegistry | undefined;
	getApiKey?: (model: Model) => ApiKey | Promise<ApiKey | undefined> | undefined;
}

/** create independent read only reviewers using the native agent loop and existing authentication */
export function createNativeReviewerAgentFactory(options: NativeReviewerOptions): ReviewerAgentFactory {
	// keep each reviewers native transcript and tool results for its later council turns
	return async reviewer => {
		if (!options.modelRegistry) {
			throw new Error("Code inspection unavailable: host did not provide a model registry");
		}

		const { session } = await createAgentSession({
			cwd: options.cwd,
			modelRegistry: options.modelRegistry,
			getApiKey: options.getApiKey,
			model: reviewer.model,
			thinkingLevel: concreteThinkingLevel(reviewer.thinkingLevel) ?? parseThinkingLevel("inherit"),
			sessionManager: SessionManager.inMemory(options.cwd),
			agentRegistry: new AgentRegistry(),
			agentId: `council-${crypto.randomUUID()}`,
			settings: Settings.isolated({
				"advisor.enabled": false,
				"compaction.enabled": false,
				"prewalk.enabled": false,
				"retry.modelFallback": false,
				"providers.anthropic.serverSideFallback": false,
			}),
			systemPrompt: [renderCritiqueSystem(), renderInspectionAddendum()],
			toolNames: ["read", "grep", "glob"],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			bindProcessState: false,
			cacheWarming: false,
			autoTitle: false,
			hasUI: false,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
		});

		return {
			/** retain native tool history while returning only this turns final answer */
			async runTurn(prompt, signal, onText) {
				const inspection: InspectionActivity = { attempted: 0, failed: 0 };
				let lastAssistant: AssistantMessage | undefined;
				let aborting: Promise<void> | undefined;
				if (signal.aborted) return { status: "aborted", text: "", inspection };

				// capture only events from this turn so an earlier answer cannot mask a failed prompt
				const unsubscribe = session.subscribe(event => {
					if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
						onText(event.assistantMessageEvent.delta);
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						lastAssistant = event.message;
					} else if (event.type === "tool_execution_start") {
						inspection.attempted++;
					} else if (event.type === "tool_execution_end" && event.isError) {
						inspection.failed++;
					}
				});
				/** cancel native work and retain its settlement for the awaited cleanup below */
				const abort = (): void => {
					aborting = session.abort();
					// event callbacks cannot await cleanup so handle rejection until finally awaits it
					void aborting.catch(() => undefined);
				};
				signal.addEventListener("abort", abort, { once: true });

				try {
					if (signal.aborted) abort();
					else await session.prompt(prompt, { expandPromptTemplates: false, runCommands: false });
					if (signal.aborted || lastAssistant?.stopReason === "aborted") {
						return { status: "aborted", text: "", inspection };
					}
					const text = lastAssistant?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
					if (lastAssistant?.stopReason === "error") {
						return { status: "error", text, inspection, errorMessage: lastAssistant.errorMessage || "Reviewer request failed" };
					}
					if (lastAssistant?.stopReason !== "stop" || !text.trim()) {
						return { status: "error", text, inspection, errorMessage: "Reviewer ended without a complete final answer" };
					}
					return { status: "done", text, inspection };
				} catch (error) {
					if (signal.aborted) return { status: "aborted", text: "", inspection };
					return { status: "error", text: "", inspection, errorMessage: error instanceof Error ? error.message : String(error) };
				} finally {
					signal.removeEventListener("abort", abort);
					unsubscribe();
					await aborting;
				}
			},
			/** settle native work before releasing this reviewers isolated session */
			async dispose() {
				await session.abort();
				await session.dispose();
			},
		};
	};
}
