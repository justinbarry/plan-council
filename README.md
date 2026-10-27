# Plan Council (`plan-council`)

A multi-model plan review, critique, cross-model debate, and consensus synthesis plugin for [Oh My Pi (OMP)](https://omp.sh).

When OMP creates a plan (`write xd://propose`), Plan Council convenes a panel of peer LLM models to critically audit the plan in parallel, cross-examine disagreements in a debate round, synthesize actionable revisions, and apply consensus feedback directly back into the planning agent.

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
                      [Disagreements]
                             ▼
             ┌──────────────────────────────┐
             │    Round 2: Model Debate     │
             │ (Cross-examination & rebut) │
             └──────────────┬───────────────┘
                             │
                      [Consensus]
                             ▼
             ┌──────────────────────────────┐
             │     Synthesis & Refine       │
             │   (Injects to Refine Plan)   │
             └──────────────────────────────┘
```

---

## Features

- **Multi-Model Parallel Critiques**: Runs Round 1 critiques simultaneously across distinct model families (e.g. OpenAI, Google, Anthropic).
- **Cross-Model Debate Rounds**: In Round 2+, models receive peer critiques, debate discrepancies, retract refuted points, and converge on genuine risks.
- **Autonomous & Coax-Free Mode**: Set `autoProceed: true` to have the council automatically critique, debate, synthesize, and submit revisions to `Refine plan` without touching a key.
- **Operator Steering**: Jump in at any time to steer the council via broadcast questions (`Ask council > ...`) or targeted mentions (`Ask council > @gpt ...`).
- **One-Key Auto-Run**: Press `Space` or `Enter` in the overlay to execute the full review pipeline in a single step.
- **Smart Model Resolution**: Automatically prioritizes your configured `modelRoles` (e.g. `council1`, `council2`, `default`, `plan`, `smol`) and filters out retired date-stamped snapshots.

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
| **`d`** | Run Round 2 debate (models cross-examine peer critiques). |
| **`Tab` / `]`** | Cycle tabs: `Council`, individual model tabs, `Synthesis`, `Plan`, `Models`. |
| **`i`** | Enter composer mode to ask questions or give operator instructions. |
| **`m`** | Open Models tab (`Space` toggles models on/off). |
| **`s`** | Synthesize council discussion into actionable revisions. |
| **`f`** | **Refine Plan**: Synthesizes and applies feedback straight to the plan. |
| **`a`** | **Approve Plan**: Immediately approves and executes the plan. |
| **`x`** | Stop active model streams. |
| **`Esc`** | Close Council overlay (discussion history is preserved on reopen). |

---

## Configuration

Configure options via `omp plugin config`:

```bash
# Hands-free mode: auto-proceed through critiques -> debate -> synthesis -> refine
omp plugin config plan-council autoProceed true

# Automatically open council when a plan is drafted (no Ctrl+N needed)
omp plugin config plan-council autoStart true

# Specify exact models (or role aliases) for reviewers
omp plugin config plan-council reviewerModels "default, smol"

# Limit maximum number of auto-selected reviewers (1-6)
omp plugin config plan-council maxReviewers 2

# Change the activation shortcut
omp plugin config plan-council shortcut "ctrl+p"
```

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

When left undefined, the plugin automatically falls back to your active `@default`, `@plan`, and `@smol` models.

---

## Testing

Run tests with Bun:

```bash
bun test
```

## License

MIT
