# Plan Council (`plan-council`)

A multi-model plan review, critique, cross-model debate, and consensus synthesis plugin for [Oh My Pi (OMP)](https://omp.sh).

When OMP creates a plan (`write xd://propose`), Plan Council convenes a panel of peer LLM models to critically audit the plan in parallel, cross-examine disagreements in debate rounds until the reviewers stop disputing each other's required revisions, synthesize actionable revisions, and apply consensus feedback directly back into the planning agent.

```
                  ┌──────────────────────┐
                  │ Planning Agent Plan  │
                  └──────────┬───────────┘
                             │
                      [Ctrl+N / Auto]
                             ▼
             ┌──────────────────────────────┐
             │   Round 1: Peer Critiques    │
             │ (Claude + GPT + Gemini + ...) │
             └──────────────┬───────────────┘
                             │
                  [Revisions requested]
                             ▼
             ┌──────────────────────────────┐
             │  Round 2+: Roundtable Debate │
             │   (one speaker at a time)    │
             └──────────────┬───────────────┘
                             │
                [No disputes or round cap]
                             ▼
             ┌──────────────────────────────┐
             │     Synthesis & Refine       │
             │   (Injects to Refine Plan)   │
             └──────────────────────────────┘
```

---

## Features

- **Multi-Model Parallel Critiques**: Runs Round 1 critiques simultaneously across distinct model families (e.g. OpenAI, Google, Anthropic).
- **Roundtable Debate Rounds**: Round 1 stays blind and parallel. In Round 2+, reviewers take the floor one at a time: each speaker sees what earlier speakers said and reported in the same round, replies to peers like a code-review thread by `@model` handle and revision ID (`provider/model#N`), and answers challenges to its own revisions by defending, narrowing, or retracting them. Authors whose revisions are disputed speak first; with nothing disputed, reviewers holding fewer revisions speak first so they can examine the others' proposals. The floor then follows the conversation: a reviewer named in a speaker's `nextSpeaker` handoff, and the authors of revisions it disputes, speak next; when a speaker rewords or adds a revision, peers who already spoke get a turn to confirm it. Each reviewer starts at most two turns per round. A round ends once no one is waiting for the floor or every held revision is agreed, unless a remaining speaker has unread operator input. Each turn shows only what the speaker has not yet seen.
- **Convergence Tracking**: Every reviewer turn records its verdict, required revisions, and stances through a `report_position` tool call. A revision keeps its ID while its wording is unchanged; a reworded or re-added revision gets a new ID, so peers judge the new wording. Each turn ends with a one-line stance change (`↳ dropped gpt-4o#1 · added gpt-4o#2 "…"`, `↳ verdict △ → ✓`, `↳ position unchanged`). The overlay title shows who holds the floor and what it is doing (`[Round 2 · turn 3 @gpt-4o · thinking 2m14s ⏳]`, or `@gpt-4o replying` while a reviewer answers you; `[Round 1 · 1/3 done 4m10s ⏳]` while critiques run) and `· converged` or `· N open` once the round ends, and the synthesizer is told which revisions are still contested. A streaming turn's header says the same, updated every second: `⏳ waiting for model · 5s` until the model sends anything, `⏳ thinking · 2m14s` while it reasons, `⏳ writing · 2m20s` once it writes.
- **Readable Rounds**: The `Council` tab is split into sections, one per run: `── Round 1 · Critiques ── 3 reviewers · 2 revisions · 2 open`, `── Q&A ──`, `── Round 2 · Debate ── 4 turns · open 2 → 1`, `── Synthesis ──`. Each finished round ends with its result as it stood when the round ended (`Result: converged · 2 revisions agreed`, `Result: 1 open · ⚡ gpt-4o#2 disputed by gemini…: clamping masks bugs · 1 not yet judged`, or `Result: stopped after 2 turns`). Earlier rounds fold to one line per turn so the current round stays in view; press `z` to show them in full. Folding never moves what you are reading: while you have scrolled up during a run, earlier rounds keep their layout until you return to the bottom. While a debate round runs, the last line shows who is queued to speak and why (`Queued: @claude… (disputed author) · @gpt-4o (confirms new wording)`); a round can still end early once everything is agreed.
- **Autonomous & Coax-Free Mode**: Set `autoProceed: true` and, once you open the council (`Ctrl+N` or `/plan-council`), it critiques, debates until no reviewer disputes a peer revision (or `maxDebateRounds` is reached), synthesizes, and submits revisions to `Refine plan` without another keypress. `autoProceed` never opens the council by itself, so each revised plan waits for your shortcut; add `autoStart: true` for fully unattended runs. Auto mode stops and waits for you when every reviewer approves with no required revisions, or after `maxAutoRefines` refines of the same plan in a row (default 2). Refining or approving yourself, in the council or the native review, resets that count.
- **Reviewer Questions**: When a disagreement hinges on your intent or scope rather than on checkable facts, a reviewer asks you instead of arguing (`❓ asks you: …` under its turn, and in the scorecard until you answer). An auto run pauses once on each new question: press `i` to answer (a message to the council or to that reviewer counts as an answer), or `Space` to continue without one. A resumed run counts the debate rounds already held against `maxDebateRounds`.
- **Moderator**: A fast model keeps the debate organized; it never takes positions. Reviewers tag each required revision with a short `concern` label naming the problem it fixes (reusing a peer's label for the same problem). When a debate round opens, the moderator groups every revision into an agenda of topics (`T1`, `T2`, …) by those labels, so two reviewers' versions of one fix are debated together; topics it judges to be possibly the same change are flagged for the authors to settle on one wording, and synthesis merges them only when they truly are. Before each turn it may pick which already-queued reviewer speaks and asks that reviewer one neutral question about one topic, shown in the transcript as `Moderator → @claude · T1: …`. It cannot add turns, end a round, outrank your `@model` messages or a reviewer's `nextSpeaker` handoff, or declare agreement: convergence still comes only from the reviewers' own reports. The scorecard lists the agenda with each topic `⚡ contested`, `○ open`, or `✓ settled`. If a moderator call fails or takes longer than 20 seconds, the rest of that round runs in the usual order and the scorecard says so. The moderator uses `@council_moderator`, then `@smol`, then `@fast`, never a slower model; with none configured it stays off.
- **Operator Steering**: Jump in at any time to steer the council via broadcast questions (`Ask council > ...`) or targeted mentions (`Ask council > @gpt ...`); `Tab` completes and cycles `@model` names. Messages send immediately: while the council is busy they queue (`· N queued` in the title), later debate speakers read them as operator guidance, and an `@model` message gives that reviewer the next debate turn. Whoever has not read a queued message when the council goes idle answers it then. A broadcast question is answered one reviewer at a time, each building on the answers before it.
- **Shared Codebase Reader**: Reviewers verify file paths, signatures, line anchors, and callers against the repository through an `ask_codebase` tool backed by one persistent read-only subagent (`read`, `grep`, `glob`, `find`, `ast_grep`, `lsp`). Queries run one at a time so files the reader already inspected stay warm across reviewers and rounds, and identical questions are answered once. Ask it yourself with `@reader <question>` (or `@scout`), or by typing on the `Reader` tab; your reader findings travel with the next debate round.
- **Stall-Based Time Limits**: Reviewers, the synthesizer, and the reader can take as long as they need while they keep making progress. A model request is dropped only after 3 minutes with no output, and a reader question after 2 minutes with no activity (or 10 minutes in total). Time a reviewer spends waiting for the reader doesn't count. A dropped reviewer shows `Stalled: no response from <model>`, and if no reviewer finishes Round 1, auto mode stops and says so.
- **Pre-Attached Plan Files**: Repository files the plan names (`src/foo.ts`, `src/foo.ts:10-20`, `lines 30–40 of src/bar.ts`) are attached to every reviewer's Round 1 prompt as numbered excerpts, so reviewers read them without spending `ask_codebase` calls. A file of up to 200 lines that fits in 8,000 characters is attached whole. A larger file shows windows around its cited lines, or its first lines when none are cited. At most 8 files and 24,000 characters are attached in total. Paths outside the repository, symlinks that resolve outside it, the plan file, binaries, lockfiles, build output, `node_modules`, and secret files such as `.env` or `*.pem` are never attached. The `Reader` tab lists what was attached. This works whether or not `enableCodeReader` is on.
- **One-Key Auto-Run**: Press `Space` or `Enter` in the overlay to execute the full review pipeline in a single step.
- **Smart Model Resolution**: Automatically prioritizes your configured `modelRoles` (e.g. `council1`, `council2`, `default`, `plan`, `smol`) and filters out retired date-stamped snapshots.
- **herdr Status**: Inside [herdr](https://herdr.dev), the pane shows as working while the council runs, instead of idle between agent turns. Requires herdr's OMP integration version 11 or newer (`herdr integration status`).

---

## Installation

### Directly via OMP (Recommended)

Once this repository is on GitHub:

```bash
omp plugin install github:<your-username>/plan-council
```

*(Or via HTTPS URL: `omp plugin install https://github.com/<your-username>/plan-council`)*

### Local Development / Symlink

```bash
git clone https://github.com/<your-username>/plan-council.git
omp plugin link ./plan-council
```

### Zero-Install (Single Session)

```bash
omp --plugin-dir /path/to/plan-council
```

---

## Usage

1. **Ask OMP to plan a task**:
   - In any OMP session, prompt the agent to create a plan (or switch to `/mode plan`).
   - When the plan is drafted, the native Plan Review overlay opens with a status badge: `Council (ctrl+n)`.

2. **Open the Council**:
   - Press **`Ctrl+N`** (or run `/plan-council`).

3. **Overlay Controls**:

| Key | Action |
|---|---|
| **`Space` / `Enter`** | **Auto-Run Council**: Automatically runs Critiques $\to$ Debate $\to$ Synthesis. |
| **`r`** | Run Round 1 critiques across active models. |
| **`d`** | Run a debate round: reviewers speak one at a time (`Round N turn i` headers), challenged authors answer right after their challengers, and the round stops early once every revision is agreed. The banner then reports convergence or the number of open disagreements. |
| **`Tab` / `]`** | Cycle tabs: `Council`, individual model tabs, `Reader`, `Synthesis`, `Plan`, `Models`. Each tab keeps its own scroll position; narrow terminals shorten tab labels and wrap the bar. |
| **`j`/`k`, `g`/`G`, arrows, PgUp/PgDn, mouse wheel** | Scroll. While a round streams, scrolling up pauses tail-follow until you return to the bottom (`G`) or start a new run. |
| **`i`** | Enter composer mode to ask questions or give operator instructions. `Tab` completes an `@model` mention; `Enter` sends at once, queuing the message while the council is busy. |
| **`m`** | Open Models tab (`Space` toggles models on/off). |
| **`o`** | Collapse or expand the Consensus Scorecard on the `Council` tab: each reviewer's verdict (`✓ APPROVE`, `△ NEEDS REVISION`, `✗ BLOCK`), required revisions, disputes, open reviewer questions for you, and revisions still awaiting debate. With a moderator agenda it lists each topic's revisions with every other reviewer's stance: `✓` agreed, `⚡` disputed (reason below), `○` not judged yet, `?` no report. |
| **`z`** | Fold or unfold earlier rounds on the `Council` tab (folded by default: one line per turn). |
| **`p`** | Show the plan beside the current tab (needs 120+ columns; narrower terminals show the current tab alone). `←`/`→`, `h`/`l`, `w`, or a click switch the focused pane; keys scroll the focused pane, and the mouse wheel scrolls the pane under the pointer. |
| **`s`** | Synthesize council discussion into actionable revisions. |
| **`f`** | **Refine Plan**: Synthesizes and applies feedback straight to the plan. |
| **`a`** | **Approve Plan**: Opens an approval bar. `←`/`→` picks Execute, Compact, or Keep (whichever the review allows); when the review offers execution tiers, `Tab`/`t` cycles them. `Enter` approves, `Esc` cancels. Opening the bar stops a pending synthesis from closing the overlay with a refine. |
| **`x`** | Stop active model streams. |
| **`Esc`** | Close Council overlay (discussion history is preserved on reopen). |

The overlay receives mouse input, so to select text inside it hold `Shift` while dragging (most terminals, including Ghostty, bypass mouse reporting with `Shift`).

---

## Configuration

Configure options via `omp plugin config set`:

```bash
# Hands-free once opened: Ctrl+N runs critiques -> debate -> synthesis -> refine
omp plugin config set plan-council autoProceed true

# Automatically open council when a plan is drafted (no Ctrl+N needed; with autoProceed, fully unattended)
omp plugin config set plan-council autoStart true

# Specify exact models (or role aliases) for reviewers
omp plugin config set plan-council reviewerModels "default, smol"

# Limit maximum number of auto-selected reviewers (1-6)
omp plugin config set plan-council maxReviewers 2

# Cap automatic debate rounds after Round 1 (1-5, default 3)
omp plugin config set plan-council maxDebateRounds 2

# Auto-refine a plan at most this many times in a row before waiting for you (0-10, default 2; 0 never auto-refines)
omp plugin config set plan-council maxAutoRefines 3

# Change the activation shortcut
omp plugin config set plan-council shortcut "ctrl+p"

# Turn off the shared codebase reader (on by default)
omp plugin config set plan-council enableCodeReader false

# Pick the reader's model (optional :effort suffix); empty uses @council_reader, @smol, @fast, then @default
omp plugin config set plan-council readerModel "@smol:low"

# Turn off the moderator (on by default)
omp plugin config set plan-council enableModerator false

# Pick the moderator's model (optional :effort suffix); empty uses @council_moderator, @smol, then @fast (and stays off without them)
omp plugin config set plan-council moderatorModel "@smol:low"

# Cap ask_codebase calls per reviewer turn (1-6, default 3)
omp plugin config set plan-council maxReaderQueriesPerTurn 2
```

### Per-Reviewer Reasoning

Append a thinking suffix to each `reviewerModels` selector to choose reasoning
independently for each reviewer. For example, set `reviewerModels` to:

```text
openai-codex/gpt-6.1-sol:xhigh, anthropic/claude-opus-5-5:high
```

An explicit suffix also works with a role selector, such as `council1:xhigh` or
`@advisor:high`, and overrides any level configured on the role.

Without a suffix, a reviewer picked through a role (in `reviewerModels`, the
`council1`–`council6` roles, or automatic selection) uses the thinking level
configured on that role, such as `plan: provider/model:high` in `modelRoles`.
This needs an OMP version whose extension API includes
`ctx.models.resolveSelection`; on older versions, put the suffix in
`reviewerModels` instead, because their model-query API does not expose role
levels.

The chosen setting applies to initial critiques, debate rounds, and operator
questions, including targeted replies and reviewers toggled in the Models tab.
The selected effort follows OMP's normal adjustment to the model's supported
reasoning levels. Use `:off` to request that reasoning be disabled. Selectors
with neither a suffix nor a role level keep the existing request defaults.

### Synthesizer Model and Reasoning

Set `synthesizerModel` to choose a different model for synthesis and append a
thinking suffix to set its reasoning level independently of the reviewers:

```bash
omp plugin config set plan-council synthesizerModel "openai-codex/gpt-6.1-sol:xhigh"
```

Role selectors also accept a suffix, such as `@council_synthesizer:high`.
The chosen effort applies to manual synthesis, Refine Plan, and the automatic
pipeline. It follows OMP's adjustment to the model's supported levels; `:off`
disables reasoning. Without a suffix, a role selector uses the level configured
on that role, as reviewers do; this needs an OMP version whose extension API
includes `ctx.models.resolveSelection`, so on older versions put the suffix in
this setting instead. A plain model id without a suffix keeps the request
defaults.

An empty or unresolved selector keeps the existing fallback order:
`@council_synthesizer`, `@council-synth`, `@plan`, `@slow`, `@default`, then the
session model or first active reviewer. A fallback role uses its own configured
level; the session model and reviewers keep request defaults, and an unresolved
selector's suffix is never carried over to a fallback.

### Custom Model Roles

You can define custom council roles in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: anthropic/claude-3-7-sonnet
  plan: anthropic/claude-3-7-sonnet
  smol: anthropic/claude-3-5-haiku

  # Dedicated council roles:
  council1: openai/gpt-4o
  council2: google/gemini-2.5-pro
  council3: anthropic/claude-3-7-sonnet
  council_synthesizer: anthropic/claude-3-7-sonnet
  council_reader: anthropic/claude-3-5-haiku
  council_moderator: anthropic/claude-3-5-haiku
```

When left undefined, the plugin automatically falls back to your active `@default`, `@plan`, and `@smol` models.

---

## Testing

Run tests with Bun:

```bash
bun test
```

## License

MIT
