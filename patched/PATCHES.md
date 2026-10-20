# The series

Seventeen patches on upstream's stable `v2.11.1`, one commit each on `main`, in four groups:
upstream's own fixes we carry (A), our fixes that stand on the base alone (B), our fixes
that need something before them (C), and our improvements (D). No fix depends on an
improvement. "Upstream candidate" means a single-cause fix with its own test that can go
upstream as its own pull request, after an issue.

When the series moved from `v2.11.1-preview.20261013.1` to `v2.11.1`, every fix was checked
against the release: its tests alone fail there, and pass with the fix. Upstream's team
Unit tool (`core/tools/aidlc-unit.ts`) is unchanged between the two.

## A · Upstream's own fixes, from open PR [#2506](https://github.com/awslabs/aidlc-workflows/pull/2506)

| # | Patch | Notes |
|---|---|---|
| 01 | fix(unit): a claimed checkout's own session noise no longer blocks publish and pin | Our copy carries the rework the reviewer asked for. Drops out once #2506 merges. |
| 02 | test(unit): pin a noise event minted before any Unit receipt exists | Same PR. |
| 03 | fix(unit): publish defers to pin's own rule instead of a second list | Same PR. |

## B · Our fixes that stand alone (upstream-ready)

| # | Patch | Notes |
|---|---|---|
| 04 | fix(unit): a scoped checkout reads other Units' receipts as an unscoped one does | Partial: team-mode receipt scoping. Upstream candidate after one re-read of what it leaves open. |
| 05 | fix(hooks): a hook in a host's worktree acts on that worktree, not the main checkout | Claude Code's desktop app runs a worktree session's hooks from the main checkout. Hooks act on the worktree the payload names, and the dispatcher runs them on that worktree's pin. Upstream candidate. |
| 06 | fix(pin): a git worktree of a registered project inherits its pin and its space on first use | A worktree of a registered checkout runs the release its own `.aidlc-version` names and never asks for `aidlc config --pin`, also when its branch pins another release than the checkout; it finds the project's space instead of an empty `default`. Main checkouts and clones keep upstream's rule. Upstream candidate. |
| 07 | fix(guards): a Unit's revision stays finishable from its own checkout | Seven ways a team Unit's revision stopped with nothing on offer (completion while revising, the revision's review, the Code Generation gate beat, the recovery-review reset, a scoped reopen, per-stage reopen gating, old reopen rows). Split before going upstream. The gate-beat part may now be covered by upstream's [#2642](https://github.com/awslabs/aidlc-workflows/pull/2642): to verify. |
| 08 | fix(summary): a later round of questions is told the one shape it takes | The protocol lines live in upstream's `stage-protocol-summary.md` since v2.11.1. Upstream candidate. |
| 09 | fix(unit): a committed file larger than 1 MiB is read whole | `aidlc unit`'s git helper read through a pipe capped at 1 MiB and ignored the error, so a large audit shard was cut short. Upstream candidate, ready. |
| 10 | fix(plan): an approval carried past the person's Request Changes is read as this attempt's | Still needed after upstream's reopen fix [#2657](https://github.com/awslabs/aidlc-workflows/pull/2657). Upstream candidate. |
| 11 | fix(route): a plugin's per-Unit stage runs with its Unit, before Build and Test | A plugin's new stage is numbered past its phase's highest (3.8 after Build and Test 3.6), and the runtime walked number order: the team fold skipped Build and Test, solo approved the plugin stage after Build and Test, hints named the number neighbour. `loadStageGraph` now returns run order (`stageRouteOrder`: each phase's per-Unit stages as one block), compile refuses a per-Unit stage that requires a stage run after the block, a stage with no Stage Progress row (work started before the plugin) gets its row in run order on its first transition, and the next stage is never one whose `requires_stage` the plan runs and has not started (the walk goes to that requirement; done, skipped or SKIP counts as settled). Test: `tests/unit/t-plugin-per-unit-stage-route.test.ts` (9 cases, all failing without the fix). Upstream candidate; issue draft in [`upstream-issue-per-unit-stage-route.md`](upstream-issue-per-unit-stage-route.md). |

## C · Our fixes that need something before them

| # | Patch | Needs | Notes |
|---|---|---|---|
| 12 | fix(unit): pin verifies the candidate a real clone produces | 01–02 | Upstream candidate after #2506. |
| 13 | fix(unit): a Unit claimed in a clone whose shard is on main lands with its own team shard | 01–03 | Proven by fixture `t4c.sh`; needs a unit test for upstream. |
| 14 | fix(unit): publish carries a team Unit's review records, so pin can count its reviews | 13 | A merge landing leaves the records out of the merge commit. Proven by `t4d.sh` and `t4e.sh`. |
| 15 | fix(team): an unscoped checkout says nothing runs there and where each claimed Unit is worked | 06 | Proven by `t4f.sh` and t327. |

## D · Our improvements

| # | Patch | Notes |
|---|---|---|
| 16 | feat(unit): team-owned Units land through pull requests, across repos (strategy pr) | `unit pr`, `unit finish`, the merge gate about the workspace pull request, the dispatch bracket pin prints, the fold on main's copy of the state. Upstream's own build-out of RFC #2410 is the draft [#2783](https://github.com/awslabs/aidlc-workflows/pull/2783); this gives way to it once it lands. |
| 17 | feat(guards): a team-owned Unit's first record requires the Unit's start, and the directive says the order | Team ownership only; solo unit-major keeps upstream's behaviour. |

## Known upstream bugs not yet in the series

- A peer session's message counts as the person's turn: the human-turn hook matches the
  transcript row by exact text, misses, and records the turn as typed by the person.
- The traceability sensor requires `rules.md` and BRx.y targets for every Unit's
  Functional Design, a UI Unit's included.
- A team Unit's stage diary path is the stage-level `memory.md`, which its scoped checkout
  rightly cannot write.
