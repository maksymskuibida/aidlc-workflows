# The series

Seven patches on upstream main `7c8d9b7d0` (2026-11-05), one commit each on `main`: five
fixes that stand on the base alone (group B) and two features (group D). The numbers are the ones the
patches had on `v2.11.1`, so references stay stable; a patch upstream merged keeps its number
in Merged upstream below. "Upstream candidate" means a single-cause fix with its own test that
can go upstream as its own pull request, after an issue. The fix plan, with every patch's fate
at this move, is the "Upstream Fix Plan" artifact.

The base is a commit of upstream's `main`, not a release tag: upstream merged our fixes there
first. It holds stable `v2.11.3` (recorded on main by #3457), so `AIDLC_VERSION` is 2.11.3.
Upstream check: 2026-11-05, upstream main `7c8d9b7d0`.

How each dropped patch was checked: its own tests, as the fork had them, ran on upstream main
without the patch. A patch whose tests pass there was dropped. Where the fork's test failed on
upstream main, the failing cases were read one by one: a case that failed only on wording or a
step upstream's reviewed form changed (its own test of the same behaviour passes there) is not
a missing fix; a case that showed missing behaviour kept that part as a thinner patch. Some
patches were dropped by the person's decision (2026-11-05), each named with its reason below.

## A · Upstream's own fixes we carry

None.

## B · Our fixes that stand alone (upstream-ready)

| # | Patch | Notes |
|---|---|---|
| 15 | fix(traceability): a ui Unit's Functional Design traces to its design files, not to business rules it does not write | The form of open upstream PR [#3510](https://github.com/awslabs/aidlc-workflows/pull/3510). A `ui` Unit's kind writes no `rules.md`, so each OK row names the Functional Design file that covers it. Test: `tests/unit/t-traceability-ui-unit.test.ts` (fails on upstream main). Drops out once #3510 merges. |
| 17 | fix(unit): pin counts main's earlier send-backs in a Unit's run floor | Thinned: [#2506](https://github.com/awslabs/aidlc-workflows/pull/2506), [#3289](https://github.com/awslabs/aidlc-workflows/pull/3289) and [#3385](https://github.com/awslabs/aidlc-workflows/pull/3385) took the rest. What is left: #3385 leaves every `GATE_REJECTED` row of main out of pin's floor rows, but a send-back is a floor boundary numbered among the send-backs of its stages (the Unit's own and stage-level ones), so a Unit whose stages main had sent back before the claim was refused "UNIT_COMPLETED receipts". Main's send-backs now stay; the candidate's shard is new on main, so its own come only with the transported rows. Reproduced on upstream main with engine commands (2026-11-05): a team main runs `jump reopen --target functional-design --stages <the five> --units alpha` before any claim, alpha is claimed in a clone, whose engine stamps the floor `GATE_REJECTED:<t>#1`, and pin refuses. Test: `tests/integration/t-team-unit-pin-send-back-floor.test.ts` (fails on upstream main with that refusal). Upstream candidate, a follow-up to #3385. |
| 32 | fix(unit): pin and land say what to do about a record outside the Unit's tree | Thinned: [#3381](https://github.com/awslabs/aidlc-workflows/pull/3381) has publish name the record. The form of open upstream PR [#3507](https://github.com/awslabs/aidlc-workflows/pull/3507): pin's and land's refusals say what to do. Drops out once #3507 merges. |
| 33 | fix(units): a team Unit's stage diary, written after the review, leaves the review standing at pin | The form of upstream PR [#3512](https://github.com/awslabs/aidlc-workflows/pull/3512): a team Unit's stage diary, which #3346 keeps in the Unit's stage folder, is not reviewed work, so writing it after the review leaves the review READY. Test: a case in `tests/unit/t331-guard-deadlock-liveness.test.ts`. Drops out once #3512 merges. |
| 26 | fix(guards): a team Unit's first record names its start, so its gate never asks you to mark it finished | A bug fix (the person, 2026-11-05), no longer a feature. A team Unit's stage done without `unit start` reached its gate with no completion receipt: `unit complete` said to start it first, the start refused, and the gate asked the person to "Mark this Unit finished", which records completion from files on disk. A question, an answer, a summary choice or a review request for a team Unit never started is now refused with the `unit start` command named (`refuseWithoutUnitStart` in `aidlc-log.ts`; team ownership on a unit-major walk only; it stands aside for a single-stage run, an autonomous swarm Unit, an open guard-recovery ask and an open Code Generation plan question). Dropped from the fork's form: the steps note (`unit_steps_note`) and the protocol's ordered list, since agents skipped the start on 9 ReviewDesk Units even with the note, and the dead end it guarded was closed by [#3358](https://github.com/awslabs/aidlc-workflows/pull/3358); the protocol says it in one sentence. Tests: `tests/unit/t-unit-start-receipt.test.ts` (cases 1–2); the tests that record a team Unit's question or review start the Unit first. Upstream PR candidate: drop when merged. |

## D · Our features

| # | Patch | Notes |
|---|---|---|
| 25 | feat(unit): team-owned Units across repos, their code merged through each repo's own review (a slice of #2783) | Replaces the fork's strategy `pr` (25) and `finish --pr` (41), by the person's decision (2026-11-05). Teams own the Units of work that records code repos wherever the workspace is a Git repository (the refusal stays only without one, #2783's own condition); claim, publish, pin, gate and land work as for one repo. `unit publish` records each code repo the Unit's Code Generation wrote to on the claim (#2783's `RepoResult`; a folder in the source manifest stands for the files changed under it), `unit pin` says how far the code merged (`code_merges`), the merge gate's Approve waits until every repo has merged (a merge commit, a squash and a rebase all count), and `unit merged <unit> --repo <repo> --user-input <words>` is the lead's word for a merge the check cannot see. No audit event or state field is added, so it drops cleanly once [#2783](https://github.com/awslabs/aidlc-workflows/pull/2783) lands. The merge check (`RepoResult`, `blobsAt`, `patchIdOf`, `unitMergeVerdict`, `writesByRepo`, `mergedStatus` in `aidlc-unit-teams.ts`) and its test are copied byte for byte from #2783's commit `65894dd9e`. AI-DLC pushes nothing and opens no pull request: the project's rules do that, in place of `unit pr` and `unit finish` (`docs/guide/workshop-mode.md`, "Teams across repos"): a worktree per Unit with each code repo's worktree inside it; code pull requests in each code repo, linking `compare/main...claim/<id8>/<unit>`, squash allowed; the lead's records pull request after each land, **merged with a merge commit only** (a squash leaves the developer's checkout scoped to the landed Unit, with a conflicting `aidlc-state.md`). Tests: `tests/unit/t-unit-merge-check.test.ts` (#2783's, 9 cases), `tests/integration/t-team-unit-across-repos.test.ts` (6 cases). Not an upstream candidate on its own (it is #2783's). |
| 40 | feat(unit): a landed team Unit goes back to work, claimed again as a new attempt (claim --reopen) | Kept as a bridge (the person, 2026-11-05), with 50 folded in: drop once upstream draft [#2783](https://github.com/awslabs/aidlc-workflows/pull/2783) merges and the projects' reopened attempts have landed. `unit claim <unit> --reopen --user-input <why>` claims a landed Unit again as the next attempt; every per-Unit stage runs again as the person's change (`jump reopen --via change --feedback <why>`); main stays as it is until the attempt lands and waits on the open attempt (Build and Test does not run); the landing's fold takes the new attempt's row and runs Build and Test again; each step carries `attempt_note`. Ported without the fork's old strategy pr (25) and `claim --skip-stages` (29). 50 (the reopened Unit's audit rows) needs no code here: upstream [#3284](https://github.com/awslabs/aidlc-workflows/pull/3284) gives each claim a shard of its own, and `t-team-unit-reopen-same-checkout` pins that a Unit reopened in the checkout that built it publishes, pins and lands. Tests: `tests/integration/t-team-unit-reopen.test.ts`, `t-team-unit-end-reopen.test.ts`, `t-team-unit-reopen-same-checkout.test.ts`. Not an upstream candidate. |

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

Dropped at the move to upstream main `7c8d9b7d0` (merged 2026-10-29 to 2026-11-04, or dropped by the person's decision, 2026-11-05):

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
| 30 | fix(team): a Unit's unit-end gate leaves out the stages skipped for it | [#3383](https://github.com/awslabs/aidlc-workflows/pull/3383); its test went with 29 |
| 31 | fix(learnings): a team Unit's directive that names no Unit makes no stage-level diary | folded into [#3346](https://github.com/awslabs/aidlc-workflows/pull/3346) ([#3398](https://github.com/awslabs/aidlc-workflows/pull/3398) closed); its test passes on upstream main |
| 35 | fix(unit): land says why git refused its commit, when git says it on stdout | [#3274](https://github.com/awslabs/aidlc-workflows/pull/3274) |
| 37 | fix(guards): a team Unit's restart picked at the recovery question runs from its own checkout | [#3350](https://github.com/awslabs/aidlc-workflows/pull/3350) |
| 38 | fix(team): a team Unit's revised gate report passes the plan guard after a recovery question | no PR of its own; its test passes on upstream main |
| 39 | fix(test): the CRLF clone fixture starts no background Git maintenance | [#3371](https://github.com/awslabs/aidlc-workflows/pull/3371) |
| 41 | feat(unit): a Unit merged by a pull request without unit land gets its landing recorded (finish --pr) | replaced, with the fork's strategy `pr`, by patch 25's slice of [#2783](https://github.com/awslabs/aidlc-workflows/pull/2783), by the person's decision (2026-11-05): the records reach main through the lead's records pull request after `unit land` |
| 42 | fix(team): changing the Unit plan keeps each team Unit's work | [#3396](https://github.com/awslabs/aidlc-workflows/pull/3396) |
| 43 | fix(team): approving a revised Unit plan gives each new Unit its row on main | [#3406](https://github.com/awslabs/aidlc-workflows/pull/3406) |
| 44 | fix(unit): a Unit's candidate goes stale only when its own entry in the Unit plan changes | [#3407](https://github.com/awslabs/aidlc-workflows/pull/3407) |
| 45 | fix(unit): no Unit is claimed while main is changing the Unit plan | [#3408](https://github.com/awslabs/aidlc-workflows/pull/3408), reviewed into a warning: the claim goes through and says the plan is being changed |
| 46 | fix(team): main runs Units Generation and Delivery Planning again while Units are claimed | [#3409](https://github.com/awslabs/aidlc-workflows/pull/3409) |
| 47 | fix(team): a revised Unit plan keeps the Units the team landed or claimed | [#3410](https://github.com/awslabs/aidlc-workflows/pull/3410) ([#3411](https://github.com/awslabs/aidlc-workflows/pull/3411) folded in) |
| 48 | fix(unit): a Unit lands after every Unit it depends on, and status says what a claimed one waits on | [#3412](https://github.com/awslabs/aidlc-workflows/pull/3412) |
| 12 | fix(route): a plugin's per-Unit stage runs with its Unit, before Build and Test | [#3420](https://github.com/awslabs/aidlc-workflows/pull/3420) (run order) and [#3421](https://github.com/awslabs/aidlc-workflows/pull/3421) (the missing Stage Progress row). Dropped by decision: the `requires_stage` runtime guard (12c; only a pre-#3420 engine or a stale graph reaches its state, and `aidlc config` recompiles the graph in run order) and a late joint approval's `next_stage` (12d; the conductor shows the report's reply, not that value, and #3420 left it out on purpose) |
| 28 | fix(team): a step skipped for a team Unit reads as skipped, on main too | 28a closed upstream ([#3375](https://github.com/awslabs/aidlc-workflows/pull/3375): a skip with no Unit named is for every Unit); the merge question naming the skipped steps and the skip waiting on the step's summary confirmation are upstream's [#3328](https://github.com/awslabs/aidlc-workflows/pull/3328) (the skip reads the same walk `next` hands out); 28c (`[S]` for a skipped step) dropped by decision with 29: upstream draws it `[x]` on purpose |
| 29 | feat(unit): a claim can leave stages out for its Unit (claim --skip-stages) | dropped by decision: a plain `unit claim` and then `jump execute --target code-generation --direction forward --units <unit> --stages <list>` does the same; the person reworks the unit-claim plugin |
| 34 | fix(unit): pin settles a stage the Unit's kind owes nothing, as the walk does | [#3278](https://github.com/awslabs/aidlc-workflows/pull/3278) (kind-vacuous) and [#3328](https://github.com/awslabs/aidlc-workflows/pull/3328) (a step skipped for the Unit) |
| 36 | fix(unit): a landed Unit with stages skipped for it counts as complete | dropped by decision with 29: upstream's `[x]` for a skipped step means its case never arises |
| 49 | fix(guards): a team's main checkout is not building a Unit's Code Generation | dropped by decision: it fixes the state a pull request built by hand leaves behind, off upstream's supported path (`unit land`) |
| 50 | fix(unit): a reopened Unit publishes the rows its checkout wrote outside its team shard | folded into 40; no code needed on upstream's [#3284](https://github.com/awslabs/aidlc-workflows/pull/3284) |

## Known upstream bugs not yet in the series

- **51: a skip on a team main before any claim is lost at the claim** (found 2026-11-05, low
  priority). On upstream main `01a5ca019`, `report --stage functional-design --result skipped`
  with no Unit named on a team main nobody has claimed from writes a `UNIT_SKIPPED` row per Unit,
  but Unit Progress still shows `[ ]`, and a team that then claims the Unit is handed Functional
  Design in its checkout. A skip made after a claim cannot arise (main then refuses Unit work).
  Not in the fork; an upstream fix to send later (issue first).
