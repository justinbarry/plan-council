import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitGhTool, createMcpReadTool, type McpToolHandle, readOnlyCommandRefusal } from "../src/reader-tools";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => block.text ?? "").join("");
}

describe("readOnlyCommandRefusal", () => {
	it.each([
		["git", ["log", "--oneline", "-20", "--", "src/x.ts"]],
		["git", ["show", "HEAD~1:src/x.ts"]],
		["git", ["diff", "--stat", "main...HEAD"]],
		["git", ["blame", "-L", "10,20", "src/x.ts"]],
		["git", ["grep", "-n", "retryBudget"]],
		["git", ["log", "--oneline", "--output-indicator-new=+"]],
		["git", ["diff", "--text"]],
		["git", ["rev-list", "--filter=blob:none", "HEAD"]],
		["gh", ["pr", "view", "6405", "--json", "state,mergedAt"]],
		["gh", ["pr", "checks", "6405"]],
		["gh", ["run", "view", "123", "--log"]],
		["gh", ["search", "prs", "notification worker", "--state", "merged"]],
	])("allows %s %j", (program, args) => {
		expect(readOnlyCommandRefusal(program, args)).toBeUndefined();
	});

	it.each([
		// writes refs, the index, or the worktree
		["git", ["commit", "-m", "x"]],
		["git", ["push"]],
		["git", ["checkout", "main"]],
		["git", ["branch", "-D", "main"]],
		["git", ["-c", "core.pager=sh", "log"]],
		["git", []],
		// writes a file or runs a program, including git's unique-prefix abbreviations
		["git", ["diff", "--output=/tmp/x"]],
		["git", ["log", "--outp=/tmp/x"]],
		["git", ["grep", "-Ovim", "x"]],
		["git", ["grep", "--open-files-in-pager", "x"]],
		["git", ["diff", "--ext-diff"]],
		["git", ["log", "-p", "--textc"]],
		["git", ["cat-file", "--filters", "HEAD:a.txt"]],
		["git", ["show", "--show-sig"]],
		["git", ["log", "--format=%h %G?"]],
		["git", ["for-each-ref", "--format=%(signature)"]],
		// gh writes, raw API access, browsers, and waits
		["gh", ["pr", "merge", "6405"]],
		["gh", ["pr", "checkout", "6405"]],
		["gh", ["api", "repos/o/r/issues", "-f", "title=x"]],
		["gh", ["pr", "view", "6405", "--web"]],
		["gh", ["pr", "view", "6405", "-cw"]],
		["gh", ["run", "view", "123", "--watch"]],
		["gh", ["constructor", "view"]],
		["bash", ["-c", "ls"]],
	])("refuses %s %j", (program, args) => {
		expect(readOnlyCommandRefusal(program, args)).toEqual(expect.any(String));
	});
});

describe("git_gh tool", () => {
	let repo: string;
	const git = (cwd: string, ...args: string[]) =>
		Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
	const commit = (cwd: string, message: string, ...flags: string[]) =>
		git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...flags, "-m", message);

	beforeAll(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "reader-git-"));
		git(repo, "init", "-q");
		fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
		git(repo, "add", "a.txt");
		commit(repo, "Clamp budgets at the API boundary");
	});
	afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

	const run = (cwd: string, program: "git" | "gh", args: string[]) =>
		createGitGhTool(cwd).execute("call-1", { program, args }, undefined, undefined as never);

	it("runs a read-only git command in the repository", async () => {
		const result = await run(repo, "git", ["log", "--format=%s"]);
		expect(result.isError).toBeUndefined();
		expect(text(result)).toBe("Clamp budgets at the API boundary");
	});

	it("reports a failing command with its exit code and stderr", async () => {
		const result = await run(repo, "git", ["show", "no-such-ref"]);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("no-such-ref: exit 128");
		expect(text(result)).toContain("unknown revision");
	});

	it("refuses a write without running it", async () => {
		const result = await run(repo, "git", ["commit", "--allow-empty", "-m", "sneaky"]);
		expect(result.isError).toBe(true);
		expect(text(result)).toStartWith("Refused: git commit is not allowed");
		expect(git(repo, "rev-list", "--count", "HEAD").stdout.toString().trim()).toBe("1");
	});

	it("never runs configured external diff, textconv, filter, or fsmonitor helpers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reader-helpers-"));
		const helperRepo = path.join(dir, "repo");
		const marker = path.join(dir, "helper-ran");
		const helper = path.join(dir, "helper.sh");
		fs.writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\ncat "$1" 2>/dev/null\n`, { mode: 0o755 });
		fs.mkdirSync(helperRepo);
		git(helperRepo, "init", "-q");
		fs.writeFileSync(path.join(helperRepo, ".gitattributes"), "*.txt diff=conv filter=scrub\n");
		fs.writeFileSync(path.join(helperRepo, "a.txt"), "one\n");
		git(helperRepo, "add", ".");
		commit(helperRepo, "first");
		fs.writeFileSync(path.join(helperRepo, "a.txt"), "two\n");
		commit(helperRepo, "second", "-a");
		fs.writeFileSync(path.join(helperRepo, "a.txt"), "three\n");
		git(helperRepo, "config", "diff.external", helper);
		git(helperRepo, "config", "diff.conv.textconv", helper);
		git(helperRepo, "config", "core.fsmonitor", helper);
		// a clean filter runs whenever git compares working-tree files; `required` makes a skipped one an error
		git(helperRepo, "config", "filter.scrub.clean", helper);
		git(helperRepo, "config", "filter.scrub.required", "true");
		const savedExternalDiff = process.env.GIT_EXTERNAL_DIFF;
		try {
			// the helper is live: plain git runs it
			git(helperRepo, "--no-pager", "diff");
			expect(fs.existsSync(marker)).toBe(true);
			fs.rmSync(marker);

			process.env.GIT_EXTERNAL_DIFF = helper;
			const outputs: string[] = [];
			for (const args of [["diff"], ["show"], ["log", "-p", "-1"], ["blame", "a.txt"], ["status", "--short"]]) {
				const result = await run(helperRepo, "git", args);
				expect(result.isError).toBeUndefined();
				outputs.push(text(result));
			}
			expect(fs.existsSync(marker)).toBe(false);
			// git's internal diff still answers
			expect(outputs[0]).toContain("+three");
		} finally {
			if (savedExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
			else process.env.GIT_EXTERNAL_DIFF = savedExternalDiff;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mcp tool", () => {
	const calls: Array<{ name: string; args: unknown; ctx: unknown; signal: unknown }> = [];
	const fakeTool = (server: string, tool: string, readOnly: boolean | undefined, description: string): McpToolHandle =>
		({
			name: `mcp__${server}_${tool}`,
			description,
			parameters: { type: "object", properties: { id: { type: "string" } } },
			mcpServerName: server,
			mcpToolName: tool,
			mcpReadOnlyHint: readOnly,
			execute: async (_id: string, args: unknown, _onUpdate: unknown, ctx: unknown, signal: unknown) => {
				calls.push({ name: tool, args, ctx, signal });
				return { content: [{ type: "text", text: `${tool} result` }] };
			},
		}) as unknown as McpToolHandle;
	const tools = [
		fakeTool("linear", "get_issue", true, "Retrieve an issue by ID. Includes attachments and more."),
		fakeTool("linear", "save_issue", false, "Create or update an issue."),
		fakeTool("axiom", "queryDataset", true, "Run an APL query."),
		fakeTool("planetscale", "execute_write_query", undefined, "Execute a write query."),
	];
	let policies: Record<string, unknown> = {};
	const mcp = createMcpReadTool(
		() => tools,
		() => policies,
	);
	const exec = (params: Parameters<typeof mcp.execute>[1], ctx: unknown = undefined, signal?: AbortSignal) =>
		mcp.execute("call-1", params, undefined, ctx as never, signal);

	it("lists only read-only tools, grouped by server, with their first sentence", async () => {
		const listed = text(await exec({ op: "list" }));
		expect(listed).toBe(
			[
				"## linear (1 read-only tools)",
				"- linear/get_issue: Retrieve an issue by ID.",
				"",
				"## axiom (1 read-only tools)",
				"- axiom/queryDataset: Run an APL query.",
			].join("\n"),
		);
		expect(text(await exec({ op: "list", server: "axiom" }))).not.toContain("linear");
	});

	it("describes and calls a read-only tool, passing args, context, and signal through", async () => {
		expect(text(await exec({ op: "describe", tool: "linear/get_issue" }))).toContain('"id"');
		const ctx = { marker: "reader-ctx" };
		const signal = new AbortController().signal;
		const result = await exec({ op: "call", tool: "linear/get_issue", args: { id: "EAR-1" } }, ctx, signal);
		expect(text(result)).toBe("get_issue result");
		expect(calls.at(-1)).toEqual({ name: "get_issue", args: { id: "EAR-1" }, ctx, signal });
		// arguments sent as a JSON string are parsed
		await exec({ op: "call", tool: "linear/get_issue", args: '{"id":"EAR-2"}' });
		expect(calls.at(-1)?.args).toEqual({ id: "EAR-2" });
	});

	it("never calls a tool its server does not mark read-only", async () => {
		const before = calls.length;
		for (const tool of ["linear/save_issue", "planetscale/execute_write_query", "mcp__linear_save_issue"]) {
			const result = await exec({ op: "call", tool, args: {} });
			expect(result.isError).toBe(true);
			expect(text(result)).toContain("No read-only MCP tool named");
		}
		for (const args of [["EAR-1"], "not json", '["EAR-1"]']) {
			expect((await exec({ op: "call", tool: "linear/get_issue", args })).isError).toBe(true);
		}
		expect(calls.length).toBe(before);
	});

	it("hides a read-only tool the user's approval policy denies or would prompt for", async () => {
		const before = calls.length;
		const renamed = { ...fakeTool("axiom", "listDatasets", true, "List datasets."), legacyName: "mcp__axiom_listdatasets" };
		tools.push(renamed);
		policies = { mcp__linear_get_issue: "deny", mcp__axiom_listdatasets: " Prompt " };
		try {
			expect(text(await exec({ op: "list" }))).toBe(["## axiom (1 read-only tools)", "- axiom/queryDataset: Run an APL query."].join("\n"));
			for (const tool of ["linear/get_issue", "axiom/listDatasets"]) {
				const result = await exec({ op: "call", tool, args: {} });
				expect(result.isError).toBe(true);
				expect(text(result)).toContain("No read-only MCP tool named");
			}
			expect(calls.length).toBe(before);
		} finally {
			tools.pop();
			policies = {};
		}
	});
});
