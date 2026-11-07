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
             │   Round 2+: Model Debate     │
             │ (Cross-examination & rebut) │
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
- **Cross-Model Debate Rounds**: In Round 2+, models receive peer critiques plus each peer's numbered required revisions, debate discrepancies, retract refuted points, and report an agree/dispute stance on every peer revision.
- **Convergence Tracking**: Every reviewer turn records its verdict, required revisions, and stances through a `report_position` tool call. The overlay title shows `· converged` or `· N open`, and the synthesizer is told which revisions are still contested.
- **Autonomous & Coax-Free Mode**: Set `autoProceed: true` to have the council automatically critique, debate until no reviewer disputes a peer revision (or `maxDebateRounds` is reached), synthesize, and submit revisions to `Refine plan` without touching a key.
- **Operator Steering**: Jump in at any time to steer the council via broadcast questions (`Ask council > ...`) or targeted mentions (`Ask council > @gpt ...`).
- **Shared Codebase Reader**: Reviewers verify file paths, signatures, line anchors, and callers against the repository through an `ask_codebase` tool backed by one persistent read-only subagent (`read`, `grep`, `glob`, `find`, `ast_grep`, `lsp`). Queries run one at a time so files the reader already inspected stay warm across reviewers and rounds, and identical questions are answered once. Ask it yourself with `@reader <question>` (or `@scout`), or by typing on the `Reader` tab; your reader findings travel with the next debate round.
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
| **`d`** | Run a debate round (models cross-examine peer critiques); the banner then reports convergence or the number of open disagreements. |
| **`Tab` / `]`** | Cycle tabs: `Council`, individual model tabs, `Reader`, `Synthesis`, `Plan`, `Models`. |
| **`i`** | Enter composer mode to ask questions or give operator instructions. |
| **`m`** | Open Models tab (`Space` toggles models on/off). |
| **`s`** | Synthesize council discussion into actionable revisions. |
| **`f`** | **Refine Plan**: Synthesizes and applies feedback straight to the plan. |
| **`a`** | **Approve Plan**: Immediately approves and executes the plan. |
| **`x`** | Stop active model streams. |
| **`Esc`** | Close Council overlay (discussion history is preserved on reopen). |

---

## Configuration

Configure options via `omp plugin config set`:

```bash
# Hands-free mode: auto-proceed through critiques -> debate -> synthesis -> refine
omp plugin config set plan-council autoProceed true

# Automatically open council when a plan is drafted (no Ctrl+N needed)
omp plugin config set plan-council autoStart true

# Specify exact models (or role aliases) for reviewers
omp plugin config set plan-council reviewerModels "default, smol"

# Limit maximum number of auto-selected reviewers (1-6)
omp plugin config set plan-council maxReviewers 2

# Cap automatic debate rounds after Round 1 (1-5, default 3)
omp plugin config set plan-council maxDebateRounds 2

# Change the activation shortcut
omp plugin config set plan-council shortcut "ctrl+p"

# Turn off the shared codebase reader (on by default)
omp plugin config set plan-council enableCodeReader false

# Pick the reader's model (optional :effort suffix); empty uses @council_reader, @smol, @fast, then @default
omp plugin config set plan-council readerModel "@smol:low"

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
