import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BINARY_SNIFF_BYTES, isFullyQualifiedPath, isProbablyBinaryHeader } from "@oh-my-pi/pi-utils";

export interface LineRange {
	start: number;
	end: number;
}

export interface ExtractedPlanFileSpec {
	/** normalized repo-relative POSIX path (`src/foo.ts`, never leading `./`) */
	path: string;
	/** 1-based inclusive line ranges cited for this path across the plan; empty when cited without lines */
	ranges: LineRange[];
}

export interface PlanFileExcerpt {
	/** repo-relative POSIX path */
	path: string;
	/** human-readable summary, e.g. `"lines 1–84"` or `"lines 30–62, 110–145 of 320"` */
	rangeLabel: string;
	/** fenced markdown code block with `LINE: TEXT` rows and any truncation notice */
	excerptBlock: string;
}

export interface CollectPlanFilesOptions {
	/** paths (repo-relative, absolute, or `local://`/`file://` URIs) to skip, such as the plan file itself */
	excludePaths?: readonly string[];
	/** max files attached; default 8 */
	maxFiles?: number;
	/** max body characters per file (excluding outer code-fence lines); default 8_000 */
	maxCharsPerFile?: number;
	/** max total body characters across all attached files; default 24_000 */
	maxTotalChars?: number;
	/** skip files larger than this byte size on disk; default 524_288 (512 KiB) */
	maxFileBytes?: number;
}

// ── Path denylist ────────────────────────────────────────────────────────────

const DENIED_SEGMENTS: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	build: true,
	".next": true,
	target: true,
	coverage: true,
	".turbo": true,
	".cache": true,
	".kube": true,
};

const LOCKFILE_BASENAMES: Record<string, true> = {
	"bun.lock": true,
	"bun.lockb": true,
	"package-lock.json": true,
	"yarn.lock": true,
	"pnpm-lock.yaml": true,
	"Cargo.lock": true,
	"poetry.lock": true,
	"Gemfile.lock": true,
	"composer.lock": true,
};

const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der", ".jks", ".keystore"];
const SECRET_BASENAMES: Record<string, true> = { "credentials.json": true, ".npmrc": true, ".netrc": true, ".pypirc": true };
const ENV_FILE = /^\.env(\..+)?$/i;
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/i;
const SSH_KEY = /^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/i;
const SERVICE_ACCOUNT = /^service-account.*\.json$/i;

/** build output, dependencies, VCS internals, lockfiles, and secret/credential/key files never reach a prompt */
export function isDeniedRepoPath(relPosixPath: string): boolean {
	const segments = relPosixPath.split("/").filter(segment => segment.length > 0);
	if (segments.some(segment => Object.hasOwn(DENIED_SEGMENTS, segment))) return true;
	const base = segments.at(-1) ?? "";
	if (Object.hasOwn(LOCKFILE_BASENAMES, base)) return true;
	if (ENV_FILE.test(base) && !ENV_TEMPLATE.test(base)) return true;
	const lower = base.toLowerCase();
	if (SECRET_EXTENSIONS.some(ext => lower.endsWith(ext))) return true;
	if (SSH_KEY.test(base) || SERVICE_ACCOUNT.test(base)) return true;
	return Object.hasOwn(SECRET_BASENAMES, lower);
}

// ── Plan extraction ──────────────────────────────────────────────────────────

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/**
 * consumes the whole candidate (leading `/`, `~`, `..`, globs, emphasis, backticks, and any range suffix) so a
 * rejected path never re-matches at an inner segment; bracketed route segments are allowed only after `/`
 */
const PATH_TOKEN =
	/(?<![A-Za-z0-9_@~./\\$+\]-])[*`]*[~/\\.]*[A-Za-z0-9_.$+*?{}-]+(?:\/(?:[A-Za-z0-9_.$+*?{}-]|\[[^\]/\s`"'()|<>]+\])+)*[*`]*(?::\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*(?::\d+)?|#L\d+(?:[-–]L?\d+)?)?[*`]*/g;

const RANGE_LIST_SRC = "\\d+(?:\\s*[-–]\\s*\\d+)?(?:\\s*(?:,|\\band\\b)\\s*~?\\d+(?:\\s*[-–]\\s*\\d+)?)*";
const BACKWARD_LINES = new RegExp(`\\blines?\\s*~?\\s*(${RANGE_LIST_SRC})\\s+(?:of|in)\\s+[\`"'( *_]*$`, "i");
const FORWARD_LINES = new RegExp(`\\blines?\\s*~?\\s*(${RANGE_LIST_SRC})`, "gi");
const APPROX_LINE = /~(\d+)\b/g;
const SYMBOL_RANGE = /`[A-Za-z0-9_#.$]+`\s+(\d+)\s*[-–]\s*(\d+)\b/g;
const BACKWARD_WINDOW = 60;
const FORWARD_WINDOW = 80;

const KNOWN_BASENAMES: Record<string, true> = {
	Makefile: true,
	Dockerfile: true,
	Containerfile: true,
	Justfile: true,
	Procfile: true,
	Brewfile: true,
	Gemfile: true,
	Rakefile: true,
	LICENSE: true,
};

const BARE_EXTENSIONS: Record<string, true> = {
	ts: true,
	tsx: true,
	js: true,
	jsx: true,
	mjs: true,
	cjs: true,
	json: true,
	jsonc: true,
	md: true,
	mdx: true,
	svelte: true,
	vue: true,
	astro: true,
	yml: true,
	yaml: true,
	toml: true,
	rs: true,
	py: true,
	go: true,
	sh: true,
	bash: true,
	zsh: true,
	css: true,
	scss: true,
	html: true,
	sql: true,
	graphql: true,
	proto: true,
	zig: true,
	c: true,
	h: true,
	cc: true,
	cpp: true,
	hpp: true,
	java: true,
	kt: true,
	swift: true,
	rb: true,
	php: true,
	lua: true,
	nix: true,
	cmake: true,
	txt: true,
	cfg: true,
	ini: true,
	conf: true,
	xml: true,
	svg: true,
};

interface PathMatch {
	start: number;
	end: number;
	path: string;
	ranges: LineRange[];
}

function pushRange(out: LineRange[], start: number, end: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end) return;
	if (!out.some(r => r.start === start && r.end === end)) out.push({ start, end });
}

/** parses `10`, `10-20`, `10–20`, `~30`, joined by `,` or `and` */
function parseRangeList(list: string, out: LineRange[]): void {
	for (const part of list.split(/\s*(?:,|\band\b)\s*/)) {
		const m = /^~?(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part.trim());
		if (m) pushRange(out, Number(m[1]), Number(m[2] ?? m[1]));
	}
}

/** strips sentence punctuation, backticks, and symmetric markdown emphasis while keeping glob `*` intact */
function unwrapDelimiters(input: string): string {
	let s = input.replace(/[.,;:!?)]+$/, "");
	while (s.endsWith("]") && s.split("]").length > s.split("[").length) {
		s = s.slice(0, -1).replace(/[.,;:!?)]+$/, "");
	}
	s = s.replace(/^`+/, "").replace(/`+$/, "");
	const lead = /^\*{1,3}(?![/*\\])/.exec(s);
	const trail = /(?<![/*\\])\*{1,3}$/.exec(s);
	if (lead && trail && lead[0].length + trail[0].length <= s.length) {
		s = s.slice(lead[0].length, s.length - trail[0].length);
	}
	return s.replace(/[.,;:!?)]+$/, "");
}

function hasFileLikeName(normalized: string): boolean {
	const base = normalized.slice(normalized.lastIndexOf("/") + 1);
	if (Object.hasOwn(KNOWN_BASENAMES, base) || ENV_TEMPLATE.test(base)) return true;
	if (normalized.includes("/")) return /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(base);
	const dot = base.lastIndexOf(".");
	return dot > 0 && Object.hasOwn(BARE_EXTENSIONS, base.slice(dot + 1).toLowerCase());
}

function normalizeCandidate(rawPath: string): string | undefined {
	if (!rawPath || /^[/\\~]/.test(rawPath) || rawPath.includes("\\")) return undefined;
	if (rawPath === ".." || rawPath.startsWith("../") || rawPath.includes("/../")) return undefined;
	if (/[*?{}]/.test(rawPath) || isFullyQualifiedPath(rawPath)) return undefined;

	const normalized = path.posix.normalize(rawPath).replace(/^\.\//, "");
	if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("/")) return undefined;
	if (normalized.startsWith("../") || normalized.includes("/../") || isDeniedRepoPath(normalized)) return undefined;
	return hasFileLikeName(normalized) ? normalized : undefined;
}

function parsePathToken(token: string): { path: string; ranges: LineRange[] } | undefined {
	const unwrapped = unwrapDelimiters(token);
	const ranges: LineRange[] = [];
	let rawPath = unwrapped;

	const anchor = /#L(\d+)(?:[-–]L?(\d+))?$/.exec(unwrapped);
	const lineCol = anchor ? null : /:(\d+):(\d+)$/.exec(unwrapped);
	const lineList = anchor || lineCol ? null : /:(\d+(?:[-–]\d+)?(?:,\d+(?:[-–]\d+)?)*)$/.exec(unwrapped);
	if (anchor) {
		pushRange(ranges, Number(anchor[1]), Number(anchor[2] ?? anchor[1]));
		rawPath = unwrapped.slice(0, anchor.index);
	} else if (lineCol) {
		pushRange(ranges, Number(lineCol[1]), Number(lineCol[1]));
		rawPath = unwrapped.slice(0, lineCol.index);
	} else if (lineList) {
		parseRangeList(lineList[1], ranges);
		rawPath = unwrapped.slice(0, lineList.index);
	}

	const normalized = normalizeCandidate(unwrapDelimiters(rawPath));
	return normalized ? { path: normalized, ranges } : undefined;
}

/** truncates prose after a path at the first clause break, and before the next path's unclosed `(` */
function forwardTail(line: string, current: PathMatch, next: PathMatch | undefined): string {
	let tail = line.slice(current.end, next?.start ?? line.length).slice(0, FORWARD_WINDOW);
	const stop = tail.search(/;|\.\s/);
	if (stop >= 0) tail = tail.slice(0, stop);
	if (next) {
		const open: number[] = [];
		for (let i = 0; i < tail.length; i++) {
			if (tail[i] === "(") open.push(i);
			else if (tail[i] === ")") open.pop();
		}
		if (open.length > 0) tail = tail.slice(0, open[0]);
	}
	return tail;
}

function attachProseRanges(line: string, matches: PathMatch[]): void {
	for (let i = 0; i < matches.length; i++) {
		const current = matches[i];
		const prefixStart = Math.max(matches[i - 1]?.end ?? 0, current.start - BACKWARD_WINDOW);
		const backward = BACKWARD_LINES.exec(line.slice(prefixStart, current.start));
		if (backward) parseRangeList(backward[1], current.ranges);

		const tail = forwardTail(line, current, matches[i + 1]);
		for (const m of tail.matchAll(FORWARD_LINES)) {
			// `lines X of <next path>` belongs to the next path, never this one
			if (/^\s+(?:of|in)\b/i.test(tail.slice(m.index + m[0].length))) continue;
			parseRangeList(m[1], current.ranges);
		}
		for (const m of tail.matchAll(APPROX_LINE)) {
			pushRange(current.ranges, Number(m[1]), Number(m[1]));
		}
		for (const m of tail.matchAll(SYMBOL_RANGE)) {
			pushRange(current.ranges, Number(m[1]), Number(m[2]));
		}
	}
}

/** repository paths the plan names outside fenced code and URLs, in first-appearance order with merged line citations */
export function extractPlanFileSpecs(planContent: string): ExtractedPlanFileSpec[] {
	const byPath = new Map<string, LineRange[]>();
	let fence: { char: string; length: number } | undefined;

	for (const rawLine of planContent.split(/\r?\n/)) {
		if (fence) {
			const close = FENCE_CLOSE.exec(rawLine);
			if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = undefined;
			continue;
		}
		const open = FENCE_OPEN.exec(rawLine);
		if (open) {
			fence = { char: open[1][0], length: open[1].length };
			continue;
		}

		// equal-length masking keeps offsets intact for the prose-range windows
		const line = rawLine.replace(URL_PATTERN, url => " ".repeat(url.length));
		const matches: PathMatch[] = [];
		for (const m of line.matchAll(PATH_TOKEN)) {
			const parsed = parsePathToken(m[0]);
			if (parsed) matches.push({ start: m.index, end: m.index + m[0].length, ...parsed });
		}
		attachProseRanges(line, matches);

		for (const match of matches) {
			let ranges = byPath.get(match.path);
			if (!ranges) {
				ranges = [];
				byPath.set(match.path, ranges);
			}
			for (const r of match.ranges) pushRange(ranges, r.start, r.end);
		}
	}

	return [...byPath].map(([specPath, ranges]) => ({ path: specPath, ranges }));
}

// ── Excerpt slicing ──────────────────────────────────────────────────────────

const FULL_FILE_MAX_LINES = 200;
const SINGLE_LINE_PAD = 25;
const RANGE_PAD = 10;
const MERGE_GAP = 8;
const MAX_LINE_CHARS = 500;
const LINE_TRUNCATION_SUFFIX = "… [line truncated]";
const WINDOW_SEPARATOR = "\n…\n";

/** a truncated line always carries the marker; a cap too small for one content character plus the marker yields nothing */
function formatLine(lineNo: number, raw: string, cap = MAX_LINE_CHARS): string | undefined {
	const prefix = `${lineNo}: `;
	const full = `${prefix}${raw}`;
	if (full.length <= cap) return full;
	if (cap < prefix.length + 1 + LINE_TRUNCATION_SUFFIX.length) return undefined;
	let cut = cap - LINE_TRUNCATION_SUFFIX.length;
	// never split a surrogate pair
	const code = full.charCodeAt(cut - 1);
	if (code >= 0xd800 && code <= 0xdbff) cut--;
	return `${full.slice(0, cut)}${LINE_TRUNCATION_SUFFIX}`;
}

function windowLabel(windows: readonly LineRange[]): string {
	return windows.map(w => (w.start === w.end ? `${w.start}` : `${w.start}–${w.end}`)).join(", ");
}

/** clamps citations to the file and merges only overlapping/adjacent ones, so uncited gaps never gain priority */
function mergeCitedSpans(ranges: readonly LineRange[], totalLines: number): LineRange[] {
	const clamped = ranges
		.filter(r => r.start <= totalLines)
		.map(r => ({ start: r.start, end: Math.min(r.end, totalLines) }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];
	for (const r of clamped) {
		const prev = merged.at(-1);
		if (prev && r.start <= prev.end + 1) prev.end = Math.max(prev.end, r.end);
		else merged.push(r);
	}
	return merged;
}

function spanPad(span: LineRange): number {
	return span.start === span.end ? SINGLE_LINE_PAD : RANGE_PAD;
}

function padWindows(spans: readonly LineRange[], totalLines: number): LineRange[] {
	const padded = spans
		.map(span => ({ start: Math.max(1, span.start - spanPad(span)), end: Math.min(totalLines, span.end + spanPad(span)) }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: LineRange[] = [];
	for (const w of padded) {
		const prev = merged.at(-1);
		if (prev && w.start <= prev.end + MERGE_GAP) prev.end = Math.max(prev.end, w.end);
		else merged.push(w);
	}
	return merged;
}

function renderSelected(selected: ReadonlyMap<number, string>): { text: string; windows: LineRange[] } {
	const lineNos = [...selected.keys()].sort((a, b) => a - b);
	const windows: LineRange[] = [];
	for (const n of lineNos) {
		const prev = windows.at(-1);
		if (prev && n === prev.end + 1) prev.end = n;
		else windows.push({ start: n, end: n });
	}
	const text = windows
		.map(w => {
			const rows: string[] = [];
			for (let n = w.start; n <= w.end; n++) rows.push(selected.get(n)!);
			return rows.join("\n");
		})
		.join(WINDOW_SEPARATOR);
	return { text, windows };
}

interface ExcerptBody {
	body: string;
	rangeLabel: string;
}

/** Case B: padded windows around citations, or cited lines first and padding with what budget remains */
function sliceCited(lines: readonly string[], citedSpans: readonly LineRange[], fileBudget: number): ExcerptBody | undefined {
	const totalLines = lines.length;
	const windows = padWindows(citedSpans, totalLines);
	const full = windows
		.map(w => {
			const rows: string[] = [];
			for (let n = w.start; n <= w.end; n++) rows.push(formatLine(n, lines[n - 1])!);
			return rows.join("\n");
		})
		.join(WINDOW_SEPARATOR);
	if (full.length <= fileBudget) {
		return { body: full, rangeLabel: `lines ${windowLabel(windows)} of ${totalLines}` };
	}

	const truncFooter = `… [truncated at excerpt budget; ${totalLines} lines total]`;
	const budgetLeft = fileBudget - (1 + truncFooter.length);
	if (budgetLeft <= 0) return undefined;

	const selected = new Map<number, string>();
	let currentLen = 0;
	const joinCostFor = (lineNo: number): number => {
		if (selected.size === 0) return 0;
		const before = selected.has(lineNo - 1);
		const after = selected.has(lineNo + 1);
		// bridging two runs swaps one window separator for two newlines
		if (before && after) return 2 - WINDOW_SEPARATOR.length;
		if (before || after) return 1;
		return WINDOW_SEPARATOR.length;
	};
	const tryInsert = (lineNo: number, formatted: string | undefined): boolean => {
		if (formatted === undefined) return false;
		if (selected.has(lineNo)) return true;
		const delta = joinCostFor(lineNo) + formatted.length;
		if (currentLen + delta > budgetLeft) return false;
		selected.set(lineNo, formatted);
		currentLen += delta;
		return true;
	};

	// Pass 1: cited lines in source order; the first line that does not fit is shortened to the remaining budget
	for (const span of citedSpans) {
		for (let lineNo = span.start; lineNo <= span.end; lineNo++) {
			if (selected.has(lineNo)) continue;
			if (tryInsert(lineNo, formatLine(lineNo, lines[lineNo - 1]))) continue;
			const availCap = Math.min(MAX_LINE_CHARS, budgetLeft - currentLen - joinCostFor(lineNo));
			tryInsert(lineNo, formatLine(lineNo, lines[lineNo - 1], availCap));
			break;
		}
	}

	// Pass 2: padding around each citation with what is left
	for (const span of citedSpans) {
		const pad = spanPad(span);
		for (let d = 1; d <= pad && span.start - d >= 1; d++) {
			const lineNo = span.start - d;
			if (!tryInsert(lineNo, formatLine(lineNo, lines[lineNo - 1]))) break;
		}
		for (let d = 1; d <= pad && span.end + d <= totalLines; d++) {
			const lineNo = span.end + d;
			if (!tryInsert(lineNo, formatLine(lineNo, lines[lineNo - 1]))) break;
		}
	}

	if (selected.size === 0) return undefined;
	const rendered = renderSelected(selected);
	return {
		body: `${rendered.text}\n${truncFooter}`,
		rangeLabel: `lines ${windowLabel(rendered.windows)} of ${totalLines}`,
	};
}

/** Case C: the head of an uncited file, with the worst-case footer reserved up front */
function sliceHead(lines: readonly string[], fileBudget: number): ExcerptBody | undefined {
	const totalLines = lines.length;
	const worstFooter = 1 + `… [truncated: showing lines 1–${totalLines} of ${totalLines}]`.length;
	const budgetLeft = fileBudget - worstFooter;
	if (budgetLeft <= 0) return undefined;

	const rows: string[] = [];
	let len = 0;
	const limit = Math.min(totalLines, FULL_FILE_MAX_LINES);
	for (let lineNo = 1; lineNo <= limit; lineNo++) {
		let formatted = formatLine(lineNo, lines[lineNo - 1]);
		if (lineNo === 1 && formatted !== undefined && formatted.length > budgetLeft) {
			formatted = formatLine(1, lines[0], budgetLeft);
		}
		const joinCost = lineNo === 1 ? 0 : 1;
		if (formatted === undefined || len + joinCost + formatted.length > budgetLeft) break;
		rows.push(formatted);
		len += joinCost + formatted.length;
	}
	if (rows.length === 0) return undefined;

	const endLine = rows.length;
	const shown = endLine === 1 ? "line 1" : `lines 1–${endLine}`;
	return {
		body: `${rows.join("\n")}\n… [truncated: showing ${shown} of ${totalLines}]`,
		rangeLabel: `${shown} of ${totalLines}`,
	};
}

function buildExcerptBody(lines: readonly string[], ranges: readonly LineRange[], fileBudget: number): ExcerptBody | undefined {
	const totalLines = lines.length;

	// Case A: the whole file fits
	if (totalLines <= FULL_FILE_MAX_LINES) {
		const rows: string[] = [];
		let len = -1;
		for (let lineNo = 1; lineNo <= totalLines; lineNo++) {
			const formatted = formatLine(lineNo, lines[lineNo - 1]);
			if (formatted === undefined) break;
			len += 1 + formatted.length;
			if (len > fileBudget) break;
			rows.push(formatted);
		}
		if (rows.length === totalLines) {
			return { body: rows.join("\n"), rangeLabel: totalLines === 1 ? "line 1" : `lines 1–${totalLines}` };
		}
	}

	const citedSpans = mergeCitedSpans(ranges, totalLines);
	return citedSpans.length > 0 ? sliceCited(lines, citedSpans, fileBudget) : sliceHead(lines, fileBudget);
}

const FENCE_LANGUAGES: Record<string, string> = {
	ts: "ts",
	tsx: "ts",
	js: "js",
	jsx: "js",
	mjs: "js",
	cjs: "js",
	json: "json",
	jsonc: "json",
	md: "md",
	mdx: "md",
	svelte: "svelte",
	vue: "vue",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	rs: "rust",
	py: "py",
	go: "go",
	sh: "sh",
	bash: "sh",
	zsh: "sh",
};

/** the fence outgrows every backtick run in the body so excerpted markdown cannot close it early */
function fenceExcerpt(body: string, relPath: string): string {
	let maxTicks = 0;
	for (const run of body.matchAll(/`+/g)) maxTicks = Math.max(maxTicks, run[0].length);
	const fence = "`".repeat(Math.max(3, maxTicks + 1));
	const ext = path.posix.extname(relPath).slice(1).toLowerCase();
	return `${fence}${Object.hasOwn(FENCE_LANGUAGES, ext) ? FENCE_LANGUAGES[ext] : ""}\n${body}\n${fence}`;
}

// ── Filesystem resolution ────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_CHARS_PER_FILE = 8_000;
const DEFAULT_MAX_TOTAL_CHARS = 24_000;
const DEFAULT_MAX_FILE_BYTES = 524_288;
const MAX_WALK_ENTRIES = 5_000;

function clampBudget(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return value <= 0 ? 0 : Math.floor(value);
}

/** repo-relative POSIX path when `targetPath` sits strictly inside `rootPath` */
function toContainedRelPosix(rootPath: string, targetPath: string): string | undefined {
	const rel = path.relative(rootPath, targetPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
	return rel.split(path.sep).join("/");
}

async function resolveExclusions(
	cwd: string,
	realCwd: string,
	excludePaths: readonly string[],
): Promise<{ relPaths: Set<string>; realPaths: Set<string> }> {
	const relPaths = new Set<string>();
	const realPaths = new Set<string>();
	const resolvedCwd = path.resolve(cwd);

	for (const entry of excludePaths) {
		let stripped: string;
		if (/^file:\/\//i.test(entry)) {
			try {
				stripped = fileURLToPath(entry);
			} catch {
				continue;
			}
		} else {
			stripped = entry.replace(/^local:\/\//i, "");
		}
		if (!stripped) continue;

		const absExcluded = path.resolve(cwd, stripped);
		for (const root of [realCwd, resolvedCwd]) {
			const rel = toContainedRelPosix(root, absExcluded);
			if (rel !== undefined) relPaths.add(rel);
		}
		if (!path.isAbsolute(stripped)) {
			const normalized = path.posix.normalize(stripped.split(path.sep).join("/")).replace(/^\.\//, "");
			if (normalized !== "." && normalized !== ".." && !normalized.startsWith("../")) relPaths.add(normalized);
		}
		try {
			realPaths.add(await fs.promises.realpath(absExcluded));
		} catch {
			// a missing plan file still excludes by its relative path
		}
	}

	return { relPaths, realPaths };
}

/** basename → repo-relative files; `undefined` when the walk failed or hit its entry cap, so ambiguity is never guessed */
async function indexRepoBasenames(realCwd: string, excludedRelPaths: ReadonlySet<string>): Promise<Map<string, string[]> | undefined> {
	const byBasename = new Map<string, string[]>();
	const queue: string[] = [""];
	let visited = 0;

	for (let qi = 0; qi < queue.length; qi++) {
		const relDir = queue[qi];
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(relDir ? path.join(realCwd, relDir) : realCwd, { withFileTypes: true });
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			if (++visited > MAX_WALK_ENTRIES) return undefined;
			if (entry.isSymbolicLink()) continue;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (isDeniedRepoPath(rel)) continue;
			if (entry.isDirectory()) {
				queue.push(rel);
			} else if (entry.isFile() && !excludedRelPaths.has(rel)) {
				const list = byBasename.get(entry.name);
				if (list) list.push(rel);
				else byBasename.set(entry.name, [rel]);
			}
		}
	}

	return byBasename;
}

async function pathExists(absPath: string): Promise<boolean> {
	try {
		await fs.promises.stat(absPath);
		return true;
	} catch {
		return false;
	}
}

/** strict UTF-8 text no larger than `maxFileBytes`, read once through a bounded slice */
async function readTextFile(realTarget: string, maxFileBytes: number): Promise<string | undefined> {
	try {
		const stat = await fs.promises.stat(realTarget);
		if (!stat.isFile() || stat.size === 0 || stat.size > maxFileBytes) return undefined;
		// one byte past the cap exposes a file that grew after stat instead of silently cutting a prefix
		const bytes = new Uint8Array(await Bun.file(realTarget).slice(0, maxFileBytes + 1).arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > maxFileBytes) return undefined;
		if (isProbablyBinaryHeader(bytes.subarray(0, BINARY_SNIFF_BYTES))) return undefined;
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

interface ResolvedPlanFile {
	relPath: string;
	realTarget: string;
	ranges: LineRange[];
}

/**
 * numbered, budgeted excerpts of repository files the plan names, confined to `realpath(cwd)` and filtered through
 * the denylist both before and after symlink resolution
 */
export async function collectPlanReferencedFiles(
	cwd: string,
	planContent: string,
	options: CollectPlanFilesOptions = {},
): Promise<PlanFileExcerpt[]> {
	const maxFiles = clampBudget(options.maxFiles, DEFAULT_MAX_FILES);
	const maxCharsPerFile = clampBudget(options.maxCharsPerFile, DEFAULT_MAX_CHARS_PER_FILE);
	const maxTotalChars = clampBudget(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
	const maxFileBytes = clampBudget(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
	if (maxFiles === 0 || maxCharsPerFile === 0 || maxTotalChars === 0) return [];

	const specs = extractPlanFileSpecs(planContent);
	if (specs.length === 0) return [];

	let realCwd: string;
	try {
		realCwd = await fs.promises.realpath(cwd);
	} catch {
		return [];
	}
	const excluded = await resolveExclusions(cwd, realCwd, options.excludePaths ?? []);

	// `null` until a bare filename misses at the root; the walk runs at most once
	let basenameIndex: Map<string, string[]> | undefined | null = null;
	const resolved = new Map<string, ResolvedPlanFile>();

	for (const spec of specs) {
		let relPath = spec.path;
		if (!relPath.includes("/") && !(await pathExists(path.join(realCwd, relPath)))) {
			if (basenameIndex === null) basenameIndex = await indexRepoBasenames(realCwd, excluded.relPaths);
			const matches = basenameIndex?.get(relPath);
			if (!matches || matches.length !== 1) continue;
			relPath = matches[0];
		}

		let realTarget: string;
		try {
			realTarget = await fs.promises.realpath(path.join(realCwd, relPath));
		} catch {
			continue;
		}
		const canonicalRelPath = toContainedRelPosix(realCwd, realTarget);
		if (canonicalRelPath === undefined || isDeniedRepoPath(canonicalRelPath)) continue;
		if (
			excluded.realPaths.has(realTarget) ||
			excluded.relPaths.has(canonicalRelPath) ||
			excluded.relPaths.has(relPath) ||
			excluded.relPaths.has(spec.path)
		) {
			continue;
		}

		const existing = resolved.get(realTarget);
		if (existing) existing.ranges.push(...spec.ranges);
		else resolved.set(realTarget, { relPath: canonicalRelPath, realTarget, ranges: [...spec.ranges] });
	}

	const excerpts: PlanFileExcerpt[] = [];
	let remainingTotalChars = maxTotalChars;
	for (const file of resolved.values()) {
		if (excerpts.length >= maxFiles || remainingTotalChars <= 0) break;

		const text = await readTextFile(file.realTarget, maxFileBytes);
		if (text === undefined) continue;
		const lines = text.split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
		if (lines.length === 0) continue;

		const excerpt = buildExcerptBody(lines, file.ranges, Math.min(maxCharsPerFile, remainingTotalChars));
		if (!excerpt) continue;
		excerpts.push({
			path: file.relPath,
			rangeLabel: excerpt.rangeLabel,
			excerptBlock: fenceExcerpt(excerpt.body, file.relPath),
		});
		remainingTotalChars -= excerpt.body.length;
	}

	return excerpts;
}
