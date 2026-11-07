import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ExtractedPlanFileSpec,
	collectPlanReferencedFiles,
	extractPlanFileSpecs,
	isDeniedRepoPath,
	type PlanFileExcerpt,
} from "../src/plan-files";

const TRUNCATION_SUFFIX = "… [line truncated]";

function specMap(planContent: string): Record<string, ExtractedPlanFileSpec["ranges"]> {
	return Object.fromEntries(extractPlanFileSpecs(planContent).map(spec => [spec.path, spec.ranges]));
}

function bodyOf(excerpt: PlanFileExcerpt): string {
	const block = excerpt.excerptBlock;
	return block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n"));
}

function numberedLines(body: string): Map<number, string> {
	const rows = new Map<number, string>();
	for (const row of body.split("\n")) {
		const m = /^(\d+): /.exec(row);
		if (m) rows.set(Number(m[1]), row);
	}
	return rows;
}

function linesOf(count: number, make: (lineNo: number) => string = n => `line ${n} content`): string {
	return `${Array.from({ length: count }, (_, i) => make(i + 1)).join("\n")}\n`;
}

describe("isDeniedRepoPath", () => {
	const cases: Array<[string, boolean]> = [
		[".git/config", true],
		["packages/a/node_modules/pkg/index.js", true],
		[".kube/config", true],
		["dist/index.js", true],
		["bun.lock", true],
		["sub/pnpm-lock.yaml", true],
		["Cargo.lock", true],
		[".env", true],
		["apps/web/.env.local", true],
		[".ENV.production", true],
		[".env.example", false],
		[".env.template", false],
		["certs/server.pem", true],
		["keys/signing.KEY", true],
		["tls/ca.crt", true],
		["android/release.jks", true],
		["home/id_ed25519", true],
		["home/id_rsa.pub", true],
		["config/credentials.json", true],
		["service-account-prod.json", true],
		[".npmrc", true],
		[".netrc", true],
		["src/index.ts", false],
		["src/keyboard.ts", false],
		["docs/build-notes.md", false],
		["package.json", false],
	];

	for (const [relPath, denied] of cases) {
		it(`${denied ? "denies" : "allows"} ${relPath}`, () => {
			expect(isDeniedRepoPath(relPath)).toBe(denied);
		});
	}
});

describe("extractPlanFileSpecs", () => {
	it("parses inline line suffixes and merges repeated mentions in first-appearance order", () => {
		const specs = extractPlanFileSpecs(
			"Edit src/foo.ts:10-20,40 then src/bar.ts#L5-L12 and src/baz.ts:30:8.\nRevisit src/foo.ts:10 and src/foo.ts:55.",
		);
		expect(specs).toEqual([
			{
				path: "src/foo.ts",
				ranges: [
					{ start: 10, end: 20 },
					{ start: 40, end: 40 },
					{ start: 10, end: 10 },
					{ start: 55, end: 55 },
				],
			},
			{ path: "src/bar.ts", ranges: [{ start: 5, end: 12 }] },
			{ path: "src/baz.ts", ranges: [{ start: 30, end: 30 }] },
		]);
	});

	it("unwraps punctuation, markdown emphasis, code spans, links, and table cells", () => {
		const cases: Array<[string, Record<string, ExtractedPlanFileSpec["ranges"]>]> = [
			["Change src/foo.ts:10.", { "src/foo.ts": [{ start: 10, end: 10 }] }],
			["Callers (see src/foo.ts:10)", { "src/foo.ts": [{ start: 10, end: 10 }] }],
			["See (https://example.com/foo.ts) and src/bar.ts", { "src/bar.ts": [] }],
			["**src/foo.ts**", { "src/foo.ts": [] }],
			["**src/foo.ts:10-20**", { "src/foo.ts": [{ start: 10, end: 20 }] }],
			["**src/foo.ts**:10", { "src/foo.ts": [{ start: 10, end: 10 }] }],
			["`src/foo.ts`:10", { "src/foo.ts": [{ start: 10, end: 10 }] }],
			["`src/foo.ts:10`", { "src/foo.ts": [{ start: 10, end: 10 }] }],
			["Bump [package.json](https://example.com)", { "package.json": [] }],
			["|3|src/council-session.ts|+16/-4|", { "src/council-session.ts": [] }],
			["Run `bun test test/foo.ts` after", { "test/foo.ts": [] }],
			["See src/index.ts.", { "src/index.ts": [] }],
			["Rename src/..notes.ts", { "src/..notes.ts": [] }],
		];
		for (const [plan, expected] of cases) {
			expect(specMap(plan)).toEqual(expected);
		}
	});

	it("keeps framework route segments whole", () => {
		expect(extractPlanFileSpecs("Touch src/app/[id]/page.tsx, src/routes/[...slug]/+page.svelte, and src/lib/$types.ts").map(s => s.path)).toEqual([
			"src/app/[id]/page.tsx",
			"src/routes/[...slug]/+page.svelte",
			"src/lib/$types.ts",
		]);
	});

	it("attaches prose line anchors after a path to that path", () => {
		expect(specMap("`src/big.ts` — `run` lines 250–265 and ~310")).toEqual({
			"src/big.ts": [
				{ start: 250, end: 265 },
				{ start: 310, end: 310 },
			],
		});
		expect(specMap("`src/big.ts` — `runAutoPipeline` 783–815")).toEqual({ "src/big.ts": [{ start: 783, end: 815 }] });
		expect(specMap("Compare `src/a.ts` (lines 10–20) with `src/b.ts` (lines 30–40)")).toEqual({
			"src/a.ts": [{ start: 10, end: 20 }],
			"src/b.ts": [{ start: 30, end: 40 }],
		});
	});

	it("attaches `lines X of <path>` to the following path, not the preceding one", () => {
		expect(specMap("In src/a.ts, call foo() (see lines 10–20 of src/b.ts)")).toEqual({
			"src/a.ts": [],
			"src/b.ts": [{ start: 10, end: 20 }],
		});
		expect(specMap("Update `src/a.ts` and see lines 10–20 of `src/b.ts`")).toEqual({
			"src/a.ts": [],
			"src/b.ts": [{ start: 10, end: 20 }],
		});
	});

	it("ignores fenced code, URLs, property chains, model selectors, prose number ranges, and globs", () => {
		const plan = [
			"```ts",
			'import { x } from "src/fenced.ts";',
			"```",
			"~~~",
			"src/tilde-fenced.ts",
			"~~~",
			"Write local://x.md and fetch https://example.com/a.ts",
			"Read entry.position with openai-codex/gpt-6.1-sol or claude-3-7-sonnet on 18.16.0",
			"Match src/*.ts, **/foo.ts, and src/foo.*",
		].join("\n");
		expect(extractPlanFileSpecs(plan)).toEqual([]);
		expect(specMap("src/a.ts was updated in 2024–2025 by 5–8 reviewers")).toEqual({ "src/a.ts": [] });
	});

	it("rejects absolute, home, and parent-relative paths without matching an inner segment", () => {
		expect(extractPlanFileSpecs("Avoid /etc/foo.conf, /../foo.ts, ../../pkg/src/index.ts, and ~/a/b.ts")).toEqual([]);
	});

	it("drops denied paths at extraction", () => {
		expect(extractPlanFileSpecs("Never .env, bun.lock, node_modules/x/y.ts, or certs/server.pem; keep .env.example").map(s => s.path)).toEqual([
			".env.example",
		]);
	});
});

describe("collectPlanReferencedFiles", () => {
	let tmp: TempDir;
	let repo: string;

	function write(relPath: string, content: string | Uint8Array, root = repo): string {
		const abs = path.join(root, relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
		return abs;
	}

	beforeEach(() => {
		tmp = TempDir.createSync("@plan-files-");
		repo = path.join(tmp.path(), "repo");
		fs.mkdirSync(repo);
	});

	afterEach(() => {
		tmp.removeSync();
	});

	describe("resolution", () => {
		it("attaches a root file directly even when nested files share its basename", async () => {
			write("package.json", '{ "name": "root" }\n');
			write("packages/x/package.json", '{ "name": "x" }\n');

			const excerpts = await collectPlanReferencedFiles(repo, "Bump package.json");
			expect(excerpts.map(e => e.path)).toEqual(["package.json"]);
			expect(bodyOf(excerpts[0])).toBe('1: { "name": "root" }');
			expect(excerpts[0].rangeLabel).toBe("line 1");
		});

		it("resolves a unique bare filename, ignoring denied and excluded duplicates", async () => {
			write("nested/debate-rebuttal.md", "# Rebuttal\n");
			write("dist/debate-rebuttal.md", "# built copy\n");
			write("docs/debate-rebuttal.md", "# plan draft\n");

			const excerpts = await collectPlanReferencedFiles(repo, "Edit debate-rebuttal.md", {
				excludePaths: ["docs/debate-rebuttal.md"],
			});
			expect(excerpts.map(e => e.path)).toEqual(["nested/debate-rebuttal.md"]);
		});

		it("skips a bare filename that matches more than one source file", async () => {
			write("a/util.ts", "export const a = 1;\n");
			write("b/util.ts", "export const b = 2;\n");
			expect(await collectPlanReferencedFiles(repo, "Edit util.ts")).toEqual([]);
		});

		it("skips the basename fallback when the walk hits its entry cap", async () => {
			write("deep/only.ts", "export {};\n");
			const filler = path.join(repo, "filler");
			fs.mkdirSync(filler);
			for (let i = 0; i < 5_001; i++) fs.writeFileSync(path.join(filler, `f${i}.txt`), "");

			expect(await collectPlanReferencedFiles(repo, "Edit only.ts")).toEqual([]);
			expect((await collectPlanReferencedFiles(repo, "Edit deep/only.ts")).map(e => e.path)).toEqual(["deep/only.ts"]);
		});

		it.skipIf(process.getuid?.() === 0)("skips the basename fallback when a directory cannot be read", async () => {
			write("deep/only.ts", "export {};\n");
			const locked = path.join(repo, "locked");
			fs.mkdirSync(locked);
			fs.chmodSync(locked, 0o000);
			try {
				expect(await collectPlanReferencedFiles(repo, "Edit only.ts")).toEqual([]);
			} finally {
				fs.chmodSync(locked, 0o755);
			}
		});

		it("resolves through a symlinked cwd and confines targets to its real path", async () => {
			write("src/a.ts", "export const a = 1;\n");
			write("outside.ts", "export const secret = 1;\n", tmp.path());
			fs.symlinkSync(path.join(tmp.path(), "outside.ts"), path.join(repo, "src", "escape.ts"));
			const link = path.join(tmp.path(), "link-repo");
			fs.symlinkSync(repo, link);

			const excerpts = await collectPlanReferencedFiles(link, "Edit src/a.ts and src/escape.ts");
			expect(excerpts.map(e => e.path)).toEqual(["src/a.ts"]);
		});
	});

	describe("security and exclusions", () => {
		it("never reads parent-relative or absolute paths", async () => {
			const outside = write("outside.ts", "export const secret = 1;\n", tmp.path());
			expect(await collectPlanReferencedFiles(repo, `Read ../outside.ts and ${outside}`)).toEqual([]);
		});

		it("blocks in-repo symlinks that resolve to denied files", async () => {
			write(".env", "TOKEN=secret\n");
			write("node_modules/pkg/index.js", "module.exports = 1;\n");
			write("src/ok.ts", "export {};\n");
			fs.symlinkSync("../.env", path.join(repo, "src", "safe.ts"));
			fs.symlinkSync("../node_modules/pkg/index.js", path.join(repo, "src", "vendor.js"));

			const excerpts = await collectPlanReferencedFiles(repo, "Read src/safe.ts, src/vendor.js, and src/ok.ts");
			expect(excerpts.map(e => e.path)).toEqual(["src/ok.ts"]);
			expect(excerpts.some(e => e.excerptBlock.includes("TOKEN"))).toBe(false);
		});

		it("skips binary files and files over maxFileBytes", async () => {
			write("src/bin.ts", new Uint8Array([0x61, 0x00, 0x62, 0x0a]));
			write("src/exact.ts", `${"a".repeat(99)}\n`);
			write("src/over.ts", `${"a".repeat(100)}\n`);

			const excerpts = await collectPlanReferencedFiles(repo, "Read src/bin.ts, src/exact.ts, src/over.ts", {
				maxFileBytes: 100,
			});
			expect(excerpts.map(e => e.path)).toEqual(["src/exact.ts"]);
		});

		it("honors local://, percent-encoded file://, relative, and missing exclude paths", async () => {
			const spaced = path.join(tmp.path(), "repo with space");
			fs.mkdirSync(spaced);
			write("plan.md", "# plan\n", spaced);
			write("notes.md", "# notes\n", spaced);
			write("docs/draft.md", "# draft\n", spaced);
			write("src/keep.ts", "export {};\n", spaced);
			const notesUrl = pathToFileURL(path.join(spaced, "notes.md")).href;
			expect(notesUrl).toContain("%20");

			const excerpts = await collectPlanReferencedFiles(spaced, "See plan.md, notes.md, docs/draft.md, docs/missing.md, src/keep.ts", {
				excludePaths: ["local://plan.md", notesUrl, "./docs/draft.md", "docs/missing.md", "file://%zz"],
			});
			expect(excerpts.map(e => e.path)).toEqual(["src/keep.ts"]);
		});

		it("attaches a symlink and its target once with merged citations", async () => {
			write("src/real.ts", linesOf(300));
			fs.symlinkSync("real.ts", path.join(repo, "src", "alias.ts"));

			const excerpts = await collectPlanReferencedFiles(repo, "Edit src/alias.ts:5 and src/real.ts:40");
			expect(excerpts).toHaveLength(1);
			expect(excerpts[0].path).toBe("src/real.ts");
			expect(excerpts[0].rangeLabel).toBe("lines 1–65 of 300");
		});
	});

	describe("budgets and slicing", () => {
		it("marks an over-long line instead of emitting it whole", async () => {
			write("src/long.ts", `${"x".repeat(50_000)}\n`);
			const [excerpt] = await collectPlanReferencedFiles(repo, "Read src/long.ts");
			const body = bodyOf(excerpt);
			expect(body.endsWith(TRUNCATION_SUFFIX)).toBe(true);
			expect(body.length).toBeLessThanOrEqual(8_000);
		});

		it("never emits a cut line without the truncation marker at any budget", async () => {
			const longLine = "y".repeat(400);
			write("src/long.ts", `${longLine}\n`);
			let sawSkip = false;
			let sawShortened = false;
			for (let budget = 1; budget <= 140; budget++) {
				const excerpts = await collectPlanReferencedFiles(repo, "Read src/long.ts", { maxCharsPerFile: budget });
				if (excerpts.length === 0) {
					sawSkip = true;
					continue;
				}
				const body = bodyOf(excerpts[0]);
				expect(body.length).toBeLessThanOrEqual(budget);
				const row = numberedLines(body).get(1)!;
				expect(row === `1: ${longLine}` || row.endsWith(TRUNCATION_SUFFIX)).toBe(true);
				sawShortened ||= row.endsWith(TRUNCATION_SUFFIX);
			}
			expect(sawSkip).toBe(true);
			expect(sawShortened).toBe(true);
		});

		it("separates windows with an ellipsis on its own line", async () => {
			write("src/big.ts", linesOf(1000));
			const [excerpt] = await collectPlanReferencedFiles(repo, "Edit src/big.ts:10,500");
			expect(excerpt.rangeLabel).toBe("lines 1–35, 475–525 of 1000");
			const rows = bodyOf(excerpt).split("\n");
			expect(rows[rows.indexOf("35: line 35 content") + 1]).toBe("…");
			expect(rows[rows.indexOf("…") + 1]).toBe("475: line 475 content");
		});

		it("keeps every body within the per-file and total budgets, footers and separators included", async () => {
			for (const name of ["a", "b", "c"]) write(`src/${name}.ts`, linesOf(1000));
			write("src/d.ts", linesOf(1000));
			const excerpts = await collectPlanReferencedFiles(repo, "Edit src/a.ts, src/b.ts:10,300,700, src/c.ts, src/d.ts:500", {
				maxCharsPerFile: 2_000,
				maxTotalChars: 4_500,
			});
			const lengths = excerpts.map(e => bodyOf(e).length);
			expect(excerpts.length).toBeGreaterThanOrEqual(3);
			for (const length of lengths) expect(length).toBeLessThanOrEqual(2_000);
			expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4_500);
			expect(bodyOf(excerpts[1])).toContain("\n…\n");
		});

		it("keeps cited lines ahead of padding when the budget is tight", async () => {
			write("src/big.ts", linesOf(1000));
			const [excerpt] = await collectPlanReferencedFiles(repo, "Edit src/big.ts:100-115", { maxCharsPerFile: 500 });
			const rows = numberedLines(bodyOf(excerpt));
			for (let n = 100; n <= 115; n++) expect(rows.get(n)).toBe(`${n}: line ${n} content`);
			expect(rows.has(90)).toBe(false);
			expect(bodyOf(excerpt).length).toBeLessThanOrEqual(500);
			expect(bodyOf(excerpt)).toContain("[truncated at excerpt budget; 1000 lines total]");
		});

		it("keeps separated citations and leaves the uncited gap out under a tight budget", async () => {
			write("src/big.ts", linesOf(1000));
			const [excerpt] = await collectPlanReferencedFiles(repo, "Edit src/big.ts:10,50", { maxCharsPerFile: 160 });
			const body = bodyOf(excerpt);
			const rows = numberedLines(body);
			expect(rows.get(10)).toBe("10: line 10 content");
			expect(rows.get(50)).toBe("50: line 50 content");
			expect(rows.has(30)).toBe(false);
			expect(body.indexOf("10: line 10 content")).toBeLessThan(body.indexOf("\n…\n"));
			expect(body.indexOf("\n…\n")).toBeLessThan(body.indexOf("50: line 50 content"));
		});

		it("shortens a long cited line to fit instead of dropping it, and keeps the earlier citation intact", async () => {
			write(
				"src/big.ts",
				linesOf(300, n => (n === 20 ? "z".repeat(400) : `l${n}`)),
			);
			const footer = "\n… [truncated at excerpt budget; 300 lines total]";
			// line 10 plus a window separator leaves 90 characters for line 20
			const [excerpt] = await collectPlanReferencedFiles(repo, "Edit src/big.ts:10,20", {
				maxCharsPerFile: footer.length + "10: l10".length + 3 + 90,
			});
			const rows = numberedLines(bodyOf(excerpt));
			expect(rows.get(10)).toBe("10: l10");
			expect(rows.get(20)?.endsWith(TRUNCATION_SUFFIX)).toBe(true);
			expect(rows.get(20)?.length).toBe(90);
		});

		it("widens the fence past backtick runs in the source", async () => {
			write("docs/guide.md", "Example:\n```ts\ncode\n```\n");
			const [excerpt] = await collectPlanReferencedFiles(repo, "Update docs/guide.md");
			expect(excerpt.excerptBlock.startsWith("````md\n")).toBe(true);
			expect(excerpt.excerptBlock.endsWith("\n````")).toBe(true);
		});

		it("stops at maxFiles and returns nothing for zero budgets", async () => {
			for (const name of ["a", "b", "c"]) write(`src/${name}.ts`, "export {};\n");
			const plan = "Edit src/a.ts, src/b.ts, src/c.ts";
			expect((await collectPlanReferencedFiles(repo, plan, { maxFiles: 2 })).map(e => e.path)).toEqual(["src/a.ts", "src/b.ts"]);
			expect(await collectPlanReferencedFiles(repo, plan, { maxTotalChars: 0 })).toEqual([]);
		});
	});
});
