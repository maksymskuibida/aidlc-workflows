# The series

Six patches on upstream main `e67ff4e86` (2026-11-04), one commit each on `main`. All six
are fixes that stand on the base alone (group B below). The numbers are the ones the patches
had on `v2.11.1`, so references stay stable; a patch upstream merged keeps its number in
Merged upstream below. "Upstream candidate" means a single-cause fix with its own test that
can go upstream as its own pull request, after an issue.

The base is a commit of upstream's `main`, not a release tag: upstream merged our fixes there
first. It holds stable `v2.11.3` (recorded on main by #3457), so `AIDLC_VERSION` is 2.11.3.
Upstream check: 2026-11-05, upstream main `e67ff4e86`.

This move (from `1bdd687e9`, 41 patches) carried only the patches that rebase onto upstream
main without a redesign. The rest are parked under Needs rework: they are not on `main`, and
a release of this `main` does not have them.

How each dropped patch was checked: its own tests, as the fork had them, ran on upstream main
without the patch. A patch whose tests pass there was dropped. Where the fork's test failed on
upstream main, the failing cases were read one by one: a case that failed only on wording or a
step upstream's reviewed form changed (its own test of the same behaviour passes there) is not
a missing fix, and the patch was dropped; a case that showed missing behaviour kept that part
as a thinner patch.

## A · Upstream's own fixes we carry

None.

## B · Our fixes that stand alone (upstream-ready)

| # | Patch | Notes |
|---|---|---|
| 15 | fix(traceability): a ui Unit's Functional Design traces to its design files, not to business rules it does not write | The form of open upstream PR [#3510](https://github.com/awslabs/aidlc-workflows/pull/3510) (built on this base). A `ui` Unit's kind writes no `rules.md`, so each OK row names the Functional Design file that covers it. Test: `tests/unit/t-traceability-ui-unit.test.ts` (fails on upstream main). Drops out once #3510 merges. |
| 49 | fix(guards): a team's main checkout is not building a Unit's Code Generation | A pull request built by hand from a Unit's branch leaves main at `Current Stage: code-generation`, and the plan-approval guard refused every edit on main. In a team-owned unit-major intent a checkout with no Unit scope is building Code Generation only where the engine issued that step there. Now on upstream's `codeGenerationStepOnRecord` (`aidlc-testing-posture.ts`, from #3294): `codeGenerationIsTheStepHere` in `aidlc-code-generation-here.ts` narrows it, read by the guard and `next`'s own-jump rule. Test: `tests/integration/t-team-unit-main-not-building.test.ts` (fails on upstream main). No upstream PR. Upstream candidate. |
| 12 | fix(route): a late joint approval names the stage after the last one it covers | Thinned: [#3420](https://github.com/awslabs/aidlc-workflows/pull/3420) writes `stage-graph.json` in run order (each phase's per-Unit stages one block) and compile refuses a per-Unit stage that requires a stage run once after the block; [#3421](https://github.com/awslabs/aidlc-workflows/pull/3421) writes the Stage Progress row of a stage a plugin adds after the work started. What is left: with Unit checkpoints off, the block's one late question names the stage after the last stage it covers, not after the one it is asked on (`applyApproveTogether`). Dropped at this move by the person's decision (2026-11-05): the runtime guard that sent the work to a `requires_stage` that never ran (`unstartedRequirement`); on upstream main only a pre-#3420 engine or a stale graph reaches that state, and `aidlc config` recompiles the graph in run order. Test: `tests/unit/t-plugin-per-unit-stage-route.test.ts` (its two solo cases fail on upstream main). Upstream candidate. A project whose plugin adds a per-Unit stage and an intent stage requiring Build and Test runs `aidlc config` once on the new engine, so its graph is compiled in run order. |
| 17 | fix(unit): pin counts main's earlier send-backs in a Unit's run floor | Thinned: [#2506](https://github.com/awslabs/aidlc-workflows/pull/2506), [#3289](https://github.com/awslabs/aidlc-workflows/pull/3289) and [#3385](https://github.com/awslabs/aidlc-workflows/pull/3385) took the rest (receipts read against the run floor of main's rows, the engine's plan-approval checkpoint name, the row derived from receipts). What is left: #3385 leaves every `GATE_REJECTED` row of main out of the floor rows, but a send-back is a floor boundary numbered among every send-back of its stages, so a Unit sent back after earlier send-backs on main was refused "UNIT_COMPLETED receipts". Main's send-backs now stay; the candidate's shard is new on main, so its own come only with the transported rows. Test: `tests/integration/t-team-unit-pin-send-back-floor.test.ts` (fails on upstream main with that refusal). Upstream candidate. |
| 32 | fix(unit): pin and land say what to do about a record outside the Unit's tree | Thinned: [#3381](https://github.com/awslabs/aidlc-workflows/pull/3381) has publish name the record. The form of open upstream PR [#3507](https://github.com/awslabs/aidlc-workflows/pull/3507) (built on this base): pin's and land's refusals say what to do. Drops out once #3507 merges. |
| 33 | fix(units): a team Unit's stage diary, written after the review, leaves the review standing at pin | The form of draft upstream PR [#3512](https://github.com/awslabs/aidlc-workflows/pull/3512) (built on this base): a team Unit's stage diary, which #3346 keeps in the Unit's stage folder, is not reviewed work, so writing it after the review leaves the review READY. Test: a case in `tests/unit/t331-guard-deadlock-liveness.test.ts`. Drops out once #3512 merges. |

## Needs rework (not on `main`)

These do not rebase onto upstream main without a redesign, and are left out of this `main`
until they are reworked. Their last form on the old base is on fork `main` before this move
(`dccc2c6ab`) and in release `2.11.3-preview.20261103.101`.

| # | Patch | Why it needs rework |
|---|---|---|
| 25 | feat(unit): team-owned Units land through pull requests, across repos (strategy pr) | [#3305](https://github.com/awslabs/aidlc-workflows/pull/3305) removed the merge-dispatch bracket from pin, which chose strategy `pr`; pin now owns the gate. A first port is on branch `rework/strategy-pr-on-upstream-main` (strategy `pr` when pinned in the Unit's own checkout; pin's `merge_gate` asks about the workspace pull request; the drift acknowledgment written to the tracked shard, since a claimed checkout now keeps its rows in `.aidlc-engine/audit/`); `t329-team-unit-pr-strategy` passes there, nothing else was run. Projects that run the `dispatch.invoked` / `dispatch.returned` commands lose them. |
| 26 | feat(guards): a team-owned Unit's first record requires the Unit's start, and the directive says the order | Conflicts with upstream's rework of the plan-approval ask, the construction protocol's lifecycle text and the claimed checkout's local audit record. |
| 28 | fix(team): a step skipped for a team Unit reads as skipped, on main too | Built on 21, which upstream replaced ([#3328](https://github.com/awslabs/aidlc-workflows/pull/3328), [#3468](https://github.com/awslabs/aidlc-workflows/pull/3468)); upstream shows a skipped step `[x]`, and decided a skip with no Unit on a team main is for every Unit ([#3375](https://github.com/awslabs/aidlc-workflows/pull/3375) closed). Needs 25. |
| 29 | feat(unit): a claim can leave stages out for its Unit (claim --skip-stages) | Needs 28 and upstream's skip. Takes the tests `t-team-unit-end-skipped-gate` (30's) and `t-team-unit-replan-claim-shapes` (44's). |
| 34 | fix(unit): pin settles a stage the Unit's kind owes nothing, as the walk does (skipped part) | Its case needs 21 and 29. |
| 36 | fix(unit): a landed Unit with stages skipped for it counts as complete | Needs 29. |
| 40 | feat(unit): a landed team Unit goes back to work, claimed again as a new attempt (claim --reopen) | Needs 25 and 29; upstream's #3410 and #3396 refusals do not name `--reopen`. Takes the tests `t-team-unit-replan-reopen-landed` and the `--reopen` cases of `t-team-unit-replan-no-claims` and `t-team-unit-replan-plan-edits`. |
| 41 | feat(unit): a Unit merged by a pull request without unit land gets its landing recorded (finish --pr) | Needs 25 and 40. Takes `t-team-unit-replan-pr-strategy`. |
| 50 | fix(unit): a reopened Unit publishes the rows its checkout wrote outside its team shard | Built on 18, which upstream replaced ([#3284](https://github.com/awslabs/aidlc-workflows/pull/3284): the claim's shard is nonce-named, publish carries the other shards as the base has them, and a claimed checkout keeps its rows locally). Needs 40 and 41. |

## Merged upstream

Dropped at the move to upstream main `1bdd687e9`:

| # | Patch | Upstream |
|---|---|---|
| 01–03 | fix(unit): a claimed checkout's own session noise no longer blocks publish and pin (and its test, and publish deferring to pin's rule) | [#2506](https://github.com/awslabs/aidlc-workflows/pull/2506), merged 2026-10-29 |
| 04 | fix(record): a subagent's hand-back on Claude Code is no longer recorded as words the person typed | [#3049](https://github.com/awslabs/aidlc-workflows/pull/3049), merged 2026-10-24 |
| 09 | fix(summary): a later round of questions is told the one shape it takes | [#3225](https://github.com/awslabs/aidlc-workflows/pull/3225), merged 2026-10-29 |
| 10 | fix(unit): a committed file larger than 1 MiB is read whole | [#3221](https://github.com/awslabs/aidlc-workflows/pull/3221), merged 2026-10-29 |
| 11 | fix(plan): an approval carried past the person's Request Changes is read as this attempt's | [#3223](https://github.com/awslabs/aidlc-workflows/pull/3223), merged 2026-10-29, narrowed to the tick fix |
| 13 | fix(unit): pin replaces an approved merge that git never landed once its Unit is republished | [#3219](https://github.com/awslabs/aidlc-workflows/pull/3219), merged 2026-10-29 |
| 14 | fix(state): landing a Unit on a main with no Unit Progress table writes the table | [#3217](https://github.com/awslabs/aidlc-workflows/pull/3217), merged 2026-10-29 |

Dropped at the move to upstream main `e67ff4e86` (merged 2026-10-29 to 2026-11-04):

| # | Patch | Upstream |
|---|---|---|
| 05 | fix(unit): a scoped checkout reads other Units' receipts as an unscoped one does | [#3265](https://github.com/awslabs/aidlc-workflows/pull/3265) |
| 06 | fix(hooks): a hook in a host's worktree acts on that worktree, not the main checkout | [#3261](https://github.com/awslabs/aidlc-workflows/pull/3261), in its reviewed form (the fork's test reads helpers it renamed) |
| 07 | fix(pin): a git worktree of a registered project inherits its pin and its space on first use | [#3353](https://github.com/awslabs/aidlc-workflows/pull/3353) (pin) and [#3387](https://github.com/awslabs/aidlc-workflows/pull/3387) (space and intent). Not taken: the one line telling a checkout whose space is empty which space holds the work; upstream's no-intent answer is now another message, and the worktree case it served is fixed |
| 08 | fix(guards): a Unit's revision stays finishable from its own checkout | [#3358](https://github.com/awslabs/aidlc-workflows/pull/3358) and [#3333](https://github.com/awslabs/aidlc-workflows/pull/3333); the gate-beat re-ask ([#3357](https://github.com/awslabs/aidlc-workflows/pull/3357)) and the recovery-review reset ([#3359](https://github.com/awslabs/aidlc-workflows/pull/3359)) were closed, agreed as unreachable on main |
| 16 | fix(learnings): a team-owned Unit keeps its stage diary in its own record tree | [#3346](https://github.com/awslabs/aidlc-workflows/pull/3346) |
| 18 | fix(unit): a Unit claimed in a clone whose shard is on main lands with its own team shard | [#3284](https://github.com/awslabs/aidlc-workflows/pull/3284), its own way (a nonce-named claim shard) |
| 19 | fix(unit): publish carries a team Unit's review records, so pin can count its reviews | [#3373](https://github.com/awslabs/aidlc-workflows/pull/3373) (land leaves them out of main); publish's carry is upstream's `withClaimReviewRecords` |
| 20 | fix(team): an unscoped checkout says nothing runs there and where each claimed Unit is worked | [#3267](https://github.com/awslabs/aidlc-workflows/pull/3267) |
| 21 | fix(team): a team-owned Unit's step in progress can be skipped for that Unit | [#3328](https://github.com/awslabs/aidlc-workflows/pull/3328) and [#3468](https://github.com/awslabs/aidlc-workflows/pull/3468), upstream's own design |
| 22 | fix(team): a team-owned Unit's last step is followed by its landing, not Build and Test | [#3361](https://github.com/awslabs/aidlc-workflows/pull/3361), in its reviewed form (the approved Unit's notice) |
| 23 | fix(record): another Claude session's message and the desktop app's own notes are no longer recorded as yours | [#3272](https://github.com/awslabs/aidlc-workflows/pull/3272) and [#3348](https://github.com/awslabs/aidlc-workflows/pull/3348) |
| 24 | fix(team): a team Unit's gate rebuilt after Request Changes takes the person's answer | [#3263](https://github.com/awslabs/aidlc-workflows/pull/3263); its integration test passes on upstream main |
| 27 | fix(team): a Unit claimed with the unit-end rhythm lands on a per-stage main | [#3276](https://github.com/awslabs/aidlc-workflows/pull/3276) |
| 30 | fix(team): a Unit's unit-end gate leaves out the stages skipped for it | [#3383](https://github.com/awslabs/aidlc-workflows/pull/3383); its test needs 29 and goes with it |
| 31 | fix(learnings): a team Unit's directive that names no Unit makes no stage-level diary | folded into [#3346](https://github.com/awslabs/aidlc-workflows/pull/3346) ([#3398](https://github.com/awslabs/aidlc-workflows/pull/3398) closed); its test passes on upstream main |
| 35 | fix(unit): land says why git refused its commit, when git says it on stdout | [#3274](https://github.com/awslabs/aidlc-workflows/pull/3274) |
| 37 | fix(guards): a team Unit's restart picked at the recovery question runs from its own checkout | [#3350](https://github.com/awslabs/aidlc-workflows/pull/3350) |
| 38 | fix(team): a team Unit's revised gate report passes the plan guard after a recovery question | no PR of its own; its test passes on upstream main |
| 39 | fix(test): the CRLF clone fixture starts no background Git maintenance | [#3371](https://github.com/awslabs/aidlc-workflows/pull/3371) |
| 42 | fix(team): changing the Unit plan keeps each team Unit's work | [#3396](https://github.com/awslabs/aidlc-workflows/pull/3396) |
| 43 | fix(team): approving a revised Unit plan gives each new Unit its row on main | [#3406](https://github.com/awslabs/aidlc-workflows/pull/3406) |
| 44 | fix(unit): a Unit's candidate goes stale only when its own entry in the Unit plan changes | [#3407](https://github.com/awslabs/aidlc-workflows/pull/3407) |
| 45 | fix(unit): no Unit is claimed while main is changing the Unit plan | [#3408](https://github.com/awslabs/aidlc-workflows/pull/3408), reviewed into a warning: the claim goes through and says the plan is being changed |
| 46 | fix(team): main runs Units Generation and Delivery Planning again while Units are claimed | [#3409](https://github.com/awslabs/aidlc-workflows/pull/3409) |
| 47 | fix(team): a revised Unit plan keeps the Units the team landed or claimed | [#3410](https://github.com/awslabs/aidlc-workflows/pull/3410) ([#3411](https://github.com/awslabs/aidlc-workflows/pull/3411) folded in) |
| 48 | fix(unit): a Unit lands after every Unit it depends on, and status says what a claimed one waits on | [#3412](https://github.com/awslabs/aidlc-workflows/pull/3412) |

## Known upstream bugs not yet in the series

None known at the moment.
