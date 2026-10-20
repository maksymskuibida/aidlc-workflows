# Draft upstream issue: a plugin's per-Unit stage runs after Build and Test

For [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows/issues). Present
in `v2.11.1` and in `main` at `0801622b8` (2026-10-22). The fork's patch is "fix(route): a
plugin's per-Unit stage runs with its Unit, before Build and Test" (`PATCHES.md`).

---

**Title:** A plugin's per-Unit Construction stage is routed after Build and Test, and the team fold skips Build and Test

**What happens**

A plugin adds a Construction stage that runs once per Unit right after Code Generation:

```yaml
slug: probe-unit-check
phase: construction
for_each: unit-of-work
requires_stage: [code-generation]
scopes: [feature]
```

and one that runs once after Build and Test (`requires_stage: [build-and-test]`).
`compileStageGraph` numbers new stages past the phase's highest number, by design (pinned
numbers never move), so the compiled graph is `code-generation 3.5 | build-and-test 3.6 |
ci-pipeline 3.7 | probe-unit-check 3.8 | probe-intent-check 3.9`.

The runtime walks graph-number order (`nextInScopeStage`), while the Unit walk treats every
`for_each: unit-of-work` stage as one block. The two disagree:

- **Team ownership (unit-major, `Unit Ownership: team`).** When the last Unit lands, the
  state fold advances from the last block stage in number order: `nextInScopeStage("probe-unit-check")`
  is `probe-intent-check`. Current Stage becomes `probe-intent-check` with `build-and-test`
  still `[ ]`; approving it completes the workflow and Build and Test never runs, although
  `probe-intent-check` requires it. In a single checkout the walk stops earlier: after a
  Unit's Code Generation approval, `aidlc-state.ts unit start --stage probe-unit-check`
  refuses ("the engine currently routes a run-stage directive") for the step `next` just
  gave.
- **Solo (unit-major).** Each Unit runs Code Generation then the plugin stage, on time, but
  the approvals commit in number order: approving the late Code Generation gate (or the
  one question that covers both stages) moves to Build and Test and leaves
  `probe-unit-check` `[ ]`, to be approved after Build and Test has run.
- **Gate hints.** `next_stage` names the number-order neighbour: "Probe Intent Check" on
  the plugin stage's gate, "Build and Test" on Code Generation's.
- **Work started before the plugin was installed.** Its Stage Progress has no row for
  the plugin stage. Routing reaches the stage, but `setCheckbox` writes nothing for a slug
  with no row, and a report on it fails with `Stage "probe-unit-check" is not present in the
  state file — cannot commit its transition.`

**Expected**

A phase's per-Unit stages run as one block wherever the compile numbers them: each Unit
walks them in dependency order, all their approvals come before the first once-per-intent
stage after them, the team fold goes to the first in-scope stage after the block that is
not done (Build and Test here), and `next_stage` follows the same order.

**Suggested fix**

Keep the numbering contract and give the runtime one run order: number order, with each
phase's per-Unit stages pulled together where the phase's first per-Unit stage stands.
`loadStageGraph` returns the graph in that order, so `nextInScopeStage`, `stageIndex`,
`subgraphForScope`, the team fold and the hints all read it from one place; the compile
refuses a per-Unit stage that requires a stage run once after the block, and
`nextInScopeStage` never returns a stage whose requirement the plan runs and has not
started (it returns that requirement instead), and `next` and `report` refuse a current
stage in that state with one line naming the requirement and the redo jump that runs it. A transition of a
stage with no Stage Progress row writes the row in run order, and `report` writes it first
for a cursor an older engine already moved onto such a stage.

For the core graph alone the run order equals number order (the five per-Unit stages are
3.1 to 3.5), so nothing changes without such a plugin.

**Reproduce**

Copy an install into a project, add the two stage files above under
`aidlc-common/stages/construction/`, run `aidlc-graph.ts compile`, seed a feature-scope
unit-major state at Code Generation with Units `alpha` and `beta`, and drive
`aidlc-orchestrate.ts next` / `report`. `aidlc-state.ts lookup next-stage code-generation
feature` prints `build-and-test`; it should print `probe-unit-check`.
