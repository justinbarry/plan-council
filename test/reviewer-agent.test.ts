import { describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { parseEffort, parseThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAgentDbPath, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { ReviewerMember } from "../src/models";
import { createNativeReviewerAgentFactory } from "../src/reviewer-agent";

const model: Model = {
	id: "council-test", name: "Council test", provider: "council-test", api: "openai-responses",
	baseUrl: "https://example.invalid", compat: undefined, identity: { class: "openai", family: "gpt" },
	reasoning: true, thinking: { mode: "effort", efforts: ["high", "xhigh"].map(parseEffort).filter(level => level !== undefined) },
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
};
const reviewer: ReviewerMember = { key: "council-test/council-test", label: "Council test", family: "gpt", model };

/** complete a mocked provider response while retaining the real sdk tool loop */
function response(requestModel: Model, content: AssistantMessage["content"], reason: "stop" | "toolUse" = "stop"): ReturnType<typeof ai.createAssistantMessageEventStream> {
	const message = assistant(requestModel, content, reason);
	const stream = ai.createAssistantMessageEventStream();
	stream.push({ type: "done", reason, message });
	return stream;
}

/** construct provider messages for successful tool requests and native abort responses */
function assistant(requestModel: Model, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant", content, api: requestModel.api, provider: requestModel.provider, model: requestModel.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, timestamp: Date.now(),
	};
}

/** expose actual native sessions inside a temporary local sdk fixture with in memory credentials */
async function nativeFixture(
	stream: typeof ai.streamSimple,
	run: (fixture: { factory: ReturnType<typeof createNativeReviewerAgentFactory>; sessions: AgentSession[]; directory: string }) => Promise<void>,
): Promise<void> {
	using directory = TempDir.createSync(join(tmpdir(), "council-native-"));
	const originalAgentDir = getAgentDir();
	const xdgNames = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const originalXdg = new Map(xdgNames.map(name => [name, process.env[name]]));
	const sessions: AgentSession[] = [];
	let auth: sdk.AuthStorage | undefined;
	let registry: sdk.ModelRegistry | undefined;
	try {
		// scope native cache and bookkeeping paths to test owned temporary directories
		for (const name of xdgNames) {
			const root = join(directory.path(), name);
			mkdirSync(join(root, "omp"), { recursive: true });
			process.env[name] = root;
		}
		setAgentDir(join(directory.path(), "agent"));
		expect(getAgentDbPath().startsWith(directory.path() + sep)).toBe(true);
		auth = await sdk.AuthStorage.create(":memory:");
		registry = new sdk.ModelRegistry(auth, join(directory.path(), "models.yml"), { ignoreLocalModelConfig: true });
		auth.keys.setRuntime(model.provider, "council-test-fixture");
		registry.registerProvider(model.provider, { api: model.api, apiKey: "council-test-fixture", baseUrl: model.baseUrl, models: [{ ...model, contextWindow: 128000, maxTokens: 4096 }] });
		const originalCreate = sdk.createAgentSession;
		// replace only inference and observe the real native session construction unchanged
		using streamSpy = spyOn(ai, "streamSimple").mockImplementation(stream);
		using sessionSpy = spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await originalCreate(options);
			sessions.push(created.session);
			return created;
		});
		const factory = createNativeReviewerAgentFactory({ cwd: directory.path(), modelRegistry: registry });
		await run({ factory, sessions, directory: directory.path() });
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		registry?.unregisterProvider(model.provider);
		auth?.close();
		for (const name of xdgNames) {
			const original = originalXdg.get(name);
			if (original === undefined) delete process.env[name];
			else process.env[name] = original;
		}
		setAgentDir(originalAgentDir);
	}
}

/** extract observed tool output without substituting the file reader itself */
function toolText(context: Context): string {
	return context.messages.filter(message => message.role === "toolResult")
		.flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text)).join("\n");
}

// use the real native sdk and filesystem while substituting only provider inference
describe("native read only reviewer sessions", () => {
	// unsupported hosts must report missing inspection rather than silently reviewing text
	it("reports a missing host registry before constructing a native session", async () => {
		const factory = createNativeReviewerAgentFactory({ cwd: process.cwd(), modelRegistry: undefined });
		await expect(factory(reviewer)).rejects.toThrow("host did not provide a model registry");
	});
	it("runs read through the native loop and retains the result for the next turn", async () => {
		let requests = 0;
		await nativeFixture((requestModel, context) => {
			requests++;
			if (requests === 1) {
				return response(requestModel, [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "README.md" } }], "toolUse");
			}
			expect(toolText(context)).toContain("council-source-marker");
			return response(requestModel, [{ type: "text", text: "Inspected README.md:1 with council-source-marker" }]);
		}, async ({ factory, sessions, directory }) => {
			writeFileSync(join(directory, "README.md"), "council-source-marker\n");
			const agent = await factory(reviewer);
			try {
				expect(sessions[0]?.state.tools.map(tool => tool.name).sort()).toEqual(["glob", "grep", "read"]);
				const first = await agent.runTurn("Inspect README.md", new AbortController().signal, () => {});
				expect(first.status).toBe("done");
				expect(first.inspection).toEqual({ attempted: 1, failed: 0 });
				const second = await agent.runTurn("What evidence did you read", new AbortController().signal, () => {});
				expect(second.status).toBe("done");
				expect(second.text).toContain("council-source-marker");
				expect(requests).toBe(3);
			} finally { await agent.dispose(); }
		});
	});

	// a model requesting a write must receive an error and leave the actual source unchanged
	it("refuses a fabricated write tool call without changing the checkout file", async () => {
		let requests = 0;
		await nativeFixture((requestModel, context) => {
			requests++;
			if (requests === 1) {
				return response(requestModel, [{ type: "toolCall", id: "write-source", name: "write", arguments: { path: "README.md", content: "overwritten" } }], "toolUse");
			}
			expect(context.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
			return response(requestModel, [{ type: "text", text: "Write refused and source unmodified" }]);
		}, async ({ factory, directory }) => {
			writeFileSync(join(directory, "README.md"), "original-council-source\n");
			const agent = await factory(reviewer);
			try {
				await agent.runTurn("Inspect code only", new AbortController().signal, () => {});
				expect(requests).toBe(2);
				expect(readFileSync(join(directory, "README.md"), "utf8")).toBe("original-council-source\n");
			} finally { await agent.dispose(); }
		});
	});

	// helpers must retain the selected effort without changing the hosts registry or settings
	it("isolates native identities and preserves inherited off and explicit reasoning", async () => {
		const efforts: Array<{ reasoning: string | undefined; disabled: boolean }> = [];
		const main = sdk.AgentRegistry.global().get(sdk.MAIN_AGENT_ID);
		await nativeFixture((requestModel, _context, options) => {
			efforts.push({ reasoning: options?.reasoning?.toString(), disabled: options?.disableReasoning ?? false });
			return response(requestModel, [{ type: "text", text: "Review completed" }]);
		}, async ({ factory, sessions }) => {
			for (const level of [undefined, "off", "xhigh"]) {
				const agent = await factory({ ...reviewer, thinkingLevel: parseThinkingLevel(level) });
				await agent.runTurn("Review the plan", new AbortController().signal, () => {});
				expect(sdk.AgentRegistry.global().get(sdk.MAIN_AGENT_ID)).toBe(main);
			}
			expect(new Set(sessions.map(session => session.sessionId)).size).toBe(3);
			for (const session of sessions) {
				expect(cfgAdvisorEnabled.get(session.settings)).toBe(false);
				expect(cfgCompactionEnabled.get(session.settings)).toBe(false);
			}
			expect(efforts).toEqual([
				{ reasoning: undefined, disabled: false },
				{ reasoning: undefined, disabled: true },
				{ reasoning: "xhigh", disabled: false },
			]);
		});
	});

	// cancellation must settle the real sdk loop and allow a later turn only after settlement
	it.each(["signal", "dispose"])("settles native inference on %s", async method => {
		const entered = Promise.withResolvers<void>();
		let requests = 0;
		await nativeFixture((requestModel, _context, options) => {
			requests++;
			if (requests > 1) return response(requestModel, [{ type: "text", text: "Retried after abort" }]);
			const stream = ai.createAssistantMessageEventStream();
			const signal = options?.signal;
			if (!signal) throw new Error("Native request is missing cancellation");
			// let the native abort signal complete the controlled provider stream
			const stop = (): void => { stream.push({ type: "error", reason: "aborted", error: assistant(requestModel, [], "aborted") }); };
			signal.addEventListener("abort", stop, { once: true });
			entered.resolve();
			return stream;
		}, async ({ factory, sessions }) => {
			const agent = await factory(reviewer);
			const controller = new AbortController();
			try {
				const running = agent.runTurn("Inspect the plan", controller.signal, () => {});
				await entered.promise;
				if (method === "signal") controller.abort();
				else await agent.dispose();
				expect((await running).status).toBe("aborted");
				expect(sessions[0]?.isStreaming).toBe(false);
				if (method === "signal") {
					const result = await agent.runTurn("Retry the question", new AbortController().signal, () => {});
					expect(result.status).toBe("done");
					expect(requests).toBe(2);
				}
			} finally { controller.abort(); await agent.dispose(); }
		});
	});
});
