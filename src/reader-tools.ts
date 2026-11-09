import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/pi-ai";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";

export const GIT_GH_TOOL_NAME = "git_gh";
export const MCP_READ_TOOL_NAME = "mcp";

/** subcommands that never write refs, the index, the worktree, or config */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"log",
	"show",
	"diff",
	"blame",
	"status",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"merge-base",
	"describe",
	"shortlog",
	"cat-file",
	"for-each-ref",
	"grep",
	"name-rev",
]);

/**
 * long options that write a file or run another program (external diff drivers, textconv and filter drivers,
 * gpg for signatures); git also accepts any unique prefix of a long option, so prefixes are refused too
 */
const GIT_BLOCKED_LONG_OPTIONS = [
	"output",
	"open-files-in-pager",
	"upload-pack",
	"exec",
	"ext-diff",
	"textconv",
	"filters",
	"show-signature",
];

/** exact option names that git resolves as themselves, not as abbreviations of a blocked option */
const GIT_EXACT_SAFE_OPTIONS: Readonly<Record<string, true>> = { text: true, filter: true };

/** placed before the subcommand: no pager, no fsmonitor hook, no automatic signature checks (gpg) */
const GIT_GLOBAL_ARGS = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

/**
 * placed right after the subcommand: configured external diff drivers and textconv helpers never run, and
 * submodules (whose own config could name other helpers) are not compared
 */
const GIT_SUBCOMMAND_ARGS: Readonly<Record<string, readonly string[]>> = {
	diff: ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"],
	log: ["--no-ext-diff", "--no-textconv"],
	show: ["--no-ext-diff", "--no-textconv"],
	blame: ["--no-textconv"],
	status: ["--ignore-submodules=all"],
};

/** `gh <group> <command>` pairs that only read */
const GH_READ_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
	pr: new Set(["view", "list", "diff", "checks", "status"]),
	issue: new Set(["view", "list", "status"]),
	run: new Set(["view", "list"]),
	workflow: new Set(["view", "list"]),
	release: new Set(["view", "list"]),
	repo: new Set(["view"]),
	search: new Set(["prs", "issues", "commits", "code", "repos"]),
	label: new Set(["list"]),
};

/** opens a browser or blocks until a run finishes */
const GH_BLOCKED_LONG_OPTIONS: Readonly<Record<string, true>> = { "--web": true, "--watch": true };

const CLI_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 40_000;
/** no pagers, prompts, colors, lazy fetches, or optional index writes (`git status` refreshes the index otherwise) */
const CLI_ENV = {
	GIT_PAGER: "cat",
	PAGER: "cat",
	GH_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_NO_LAZY_FETCH: "1",
	GH_PROMPT_DISABLED: "1",
	NO_COLOR: "1",
};

/** the CLI environment without inherited variables that make git run another program */
function cliEnv(): Record<string, string | undefined> {
	const { GIT_EXTERNAL_DIFF: _externalDiff, ...inherited } = process.env;
	return { ...inherited, ...CLI_ENV };
}

/**
 * `-c` overrides that switch off every configured filter driver: a clean, smudge, or process filter runs whenever
 * git compares working-tree files, whichever attributes file names it, and only config can give it a command
 */
async function gitFilterOverrides(cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
	// -z: subsection names may hold spaces; each entry is `key\nvalue\0`
	const proc = Bun.spawn(["git", "config", "-z", "--get-regexp", "^filter\\."], {
		cwd,
		env: cliEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		timeout: CLI_TIMEOUT_MS,
		signal,
	});
	const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const drivers = new Set<string>();
	for (const entry of output.split("\0")) {
		const name = entry.split("\n")[0].match(/^filter\.(.+)\.[^.]+$/)?.[1];
		if (name) drivers.add(name);
	}
	return [...drivers].flatMap(name => [
		...["clean", "smudge", "process"].flatMap(key => ["-c", `filter.${name}.${key}=`]),
		"-c",
		`filter.${name}.required=false`,
	]);
}

/** git argv for an allowlisted command, with configured helpers switched off */
function gitArgv(args: readonly string[], filterOverrides: readonly string[]): string[] {
	const [subcommand, ...rest] = args;
	return [
		"git",
		...GIT_GLOBAL_ARGS,
		...filterOverrides,
		subcommand,
		...(GIT_SUBCOMMAND_ARGS[subcommand] ?? []),
		...rest,
	];
}

/** why a git or gh command is refused; undefined when it is on the read-only allowlist */
export function readOnlyCommandRefusal(program: string, args: readonly string[]): string | undefined {
	if (program === "git") {
		const subcommand = args[0];
		if (!subcommand || !GIT_READ_SUBCOMMANDS.has(subcommand)) {
			return `git ${subcommand ?? ""} is not allowed; read-only subcommands: ${[...GIT_READ_SUBCOMMANDS].join(", ")}`.trim();
		}
		for (const arg of args.slice(1)) {
			if (/^-O/.test(arg)) return `${arg} runs a pager program`;
			// pretty-format and ref-format placeholders that verify signatures run gpg
			if (/%G|%\(signature/.test(arg)) return `${arg} verifies signatures with gpg`;
			if (!arg.startsWith("--") || arg === "--") continue;
			const name = arg.slice(2).split("=")[0];
			if (Object.hasOwn(GIT_EXACT_SAFE_OPTIONS, name)) continue;
			const blocked = GIT_BLOCKED_LONG_OPTIONS.find(option => name && option.startsWith(name));
			if (blocked) return `--${blocked} writes a file or runs a program`;
		}
		return undefined;
	}
	if (program === "gh") {
		const [group, command] = args;
		if (!group || !command || !Object.hasOwn(GH_READ_COMMANDS, group) || !GH_READ_COMMANDS[group].has(command)) {
			const allowed = Object.entries(GH_READ_COMMANDS).map(([g, commands]) => `${g} ${[...commands].join("|")}`);
			return `gh ${args.slice(0, 2).join(" ")} is not allowed; read-only commands: ${allowed.join("; ")}`;
		}
		for (const arg of args.slice(2)) {
			if (Object.hasOwn(GH_BLOCKED_LONG_OPTIONS, arg.split("=")[0])) return `${arg} is not allowed`;
			// a short-flag cluster such as `-w` or `-cw` carries --web
			if (/^-[a-zA-Z]*w[a-zA-Z]*$/.test(arg)) return `${arg} opens a browser`;
		}
		return undefined;
	}
	return `unknown program ${program}; use git or gh`;
}

function textResult(text: string, isError = false): AgentToolResult {
	return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function capOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[… ${text.length - MAX_OUTPUT_CHARS} more characters truncated; narrow the command]`;
}

const gitGhSchema = type({
	program: type("'git' | 'gh'").describe("git for local history, gh for GitHub"),
	args: type("string")
		.array()
		.describe(
			'arguments after the program, one per element, e.g. ["log", "--oneline", "-20", "--", "src/x.ts"] or ["pr", "view", "123", "--json", "state,mergedAt,baseRefName"]',
		),
});

/** read-only git and gh, run without a shell so arguments cannot chain or redirect */
export function createGitGhTool(cwd: string): CustomTool<typeof gitGhSchema> {
	return {
		name: GIT_GH_TOOL_NAME,
		label: "git/gh (read-only)",
		description:
			"Run a read-only git command (log, show, diff, blame, status, grep, ls-files, rev-parse, merge-base, …) or gh command (pr view/list/diff/checks, issue view/list, run view/list, search prs/issues/commits/code, release view, repo view) in the repository. Arguments are passed as an array without a shell; commands that write are refused.",
		parameters: gitGhSchema,
		approval: "read",
		loadMode: "essential",
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			const refusal = readOnlyCommandRefusal(params.program, params.args);
			if (refusal) return textResult(`Refused: ${refusal}`, true);
			const argv =
				params.program === "git"
					? gitArgv(params.args, await gitFilterOverrides(cwd, signal))
					: ["gh", ...params.args];
			let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
			try {
				proc = Bun.spawn(argv, {
					cwd,
					env: cliEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					timeout: CLI_TIMEOUT_MS,
					signal,
				});
			} catch (error) {
				return textResult(`${params.program} could not start: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
				const reason = proc.signalCode ? `killed (${proc.signalCode})` : `exit ${exitCode}`;
				return textResult(capOutput(`${argv.join(" ")}: ${reason}${detail ? `\n${detail}` : ""}`), true);
			}
			return textResult(capOutput(stdout.trim() || "(no output)"));
		},
	};
}

/** the slice of a host MCP tool the reader's proxy uses */
export type McpToolHandle = Pick<
	CustomTool,
	"name" | "description" | "parameters" | "execute" | "mcpServerName" | "mcpToolName" | "mcpReadOnlyHint" | "legacyName"
>;

/**
 * the user's `tools.approval` policy for a host tool, as the approval gate reads it: its name, else (for a renamed
 * MCP mint) its legacy name
 */
function userPolicyOf(tool: McpToolHandle, policies: Readonly<Record<string, unknown>>): string | undefined {
	const policy = (key: string | undefined) =>
		key !== undefined && Object.hasOwn(policies, key) && typeof policies[key] === "string"
			? (policies[key] as string).trim().toLowerCase()
			: undefined;
	return policy(tool.name) ?? policy(tool.legacyName);
}

/** `server/tool` as the proxy lists it; the minted `mcp__…` name when the tool lacks MCP metadata */
function mcpToolRef(tool: McpToolHandle): string {
	return tool.mcpServerName && tool.mcpToolName ? `${tool.mcpServerName}/${tool.mcpToolName}` : tool.name;
}

function firstSentence(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	const sentence = line.match(/^.*?[.!?](\s|$)/)?.[0] ?? line;
	return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence.trim();
}

const mcpReadSchema = type({
	op: type("'list' | 'describe' | 'call'").describe("list read-only tools, describe one tool's arguments, or call one"),
	"server?": type("string").describe("list only this server's tools"),
	"tool?": type("string").describe("tool to describe or call, as server/tool from list"),
	"args?": type("unknown").describe("arguments object for call, matching the schema describe returns"),
});

/**
 * one tool fronting the host's connected MCP servers: it lists, describes, and calls only tools their server
 * marks read-only (`readOnlyHint`), so their schemas cost nothing until the reader asks for one. The proxy calls
 * the host tool directly, past its approval gate, so it enforces the user's policy itself: a tool the user set to
 * `deny` or `prompt` (which this headless reader cannot ask) is not offered.
 */
export function createMcpReadTool(
	listTools: () => readonly McpToolHandle[],
	userPolicies: () => Readonly<Record<string, unknown>>,
): CustomTool<typeof mcpReadSchema> {
	const readOnlyTools = () => {
		const policies = userPolicies();
		return listTools().filter(tool => {
			if (tool.mcpReadOnlyHint !== true) return false;
			const policy = userPolicyOf(tool, policies);
			return policy !== "deny" && policy !== "prompt";
		});
	};
	const findTool = (ref: string | undefined) => {
		const wanted = ref?.trim();
		if (!wanted) return undefined;
		return readOnlyTools().find(tool => mcpToolRef(tool) === wanted || tool.name === wanted);
	};
	return {
		name: MCP_READ_TOOL_NAME,
		label: "MCP (read-only)",
		description:
			"Query connected services (issue trackers, observability, databases, …) through their read-only MCP tools. op=list shows tools by server, op=describe returns one tool's argument schema, op=call runs it with args. Only tools their server marks read-only are available.",
		parameters: mcpReadSchema,
		approval: "read",
		loadMode: "essential",
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			if (params.op === "list") {
				const byServer = new Map<string, McpToolHandle[]>();
				for (const tool of readOnlyTools()) {
					const server = tool.mcpServerName ?? "other";
					if (params.server && server !== params.server) continue;
					byServer.set(server, [...(byServer.get(server) ?? []), tool]);
				}
				if (byServer.size === 0) {
					return textResult(
						params.server ? `No read-only tools on server ${params.server}.` : "No read-only MCP tools are connected.",
					);
				}
				const sections = [...byServer].map(
					([server, tools]) =>
						`## ${server} (${tools.length} read-only tools)\n${tools.map(t => `- ${mcpToolRef(t)}: ${firstSentence(t.description)}`).join("\n")}`,
				);
				return textResult(sections.join("\n\n"));
			}

			const tool = findTool(params.tool);
			if (!tool) {
				return textResult(
					`No read-only MCP tool named ${params.tool ?? "(missing)"}; run op=list for available tools.`,
					true,
				);
			}
			if (params.op === "describe") {
				return textResult(capOutput(`${tool.description}\n\nArguments schema:\n${JSON.stringify(tool.parameters, null, 1)}`));
			}
			// models often send free-form arguments as a JSON string
			let args = params.args ?? {};
			if (typeof args === "string") {
				try {
					args = JSON.parse(args);
				} catch {
					return textResult("args must be a JSON object matching the tool's schema.", true);
				}
			}
			if (typeof args !== "object" || args === null || Array.isArray(args)) {
				return textResult("args must be an object matching the tool's schema.", true);
			}
			return tool.execute(toolCallId, args, onUpdate, ctx, signal);
		},
	};
}
