# Runbook

Everything here runs from a clone of this repository with `git`, `bun`, `gh` and the
`aidlc` launcher installed. Add upstream once:

```bash
git remote add upstream https://github.com/awslabs/aidlc-workflows.git
git fetch upstream --tags
```

## 1. The series

`main` is the base, then the patches, then our own commits. The base is the upstream
commit `README.md` names (now a commit of upstream's `main`; it can be a release tag), called
`<base>` below:

1. Upstream's own fixes we carry before upstream merges them (from its open pull requests).
2. Our bug fixes that stand on the base alone.
3. Our bug fixes that need something before them.
4. Our improvements.
5. Our own commits: `patched/` and the release-workflow changes.

A bug fix never depends on an improvement; one that would goes after it. Every commit
typechecks on its own (`bun scripts/package.ts && bun run typecheck` at each commit).
`PATCHES.md` keeps one section per patch.

## 1a. Tests run here, not in GitHub Actions

The fork's test workflows are off in GitHub (Actions minutes: GitHub turned Actions off for
this repository once). Tests run on this machine instead, against the exact commit pushed:

Every worktree of a clone shares one `core.hooksPath`, so the clone points it at a small
dispatcher in its git directory, which runs the pushing worktree's own
`patched/hooks/pre-push` (a worktree on a branch cut from `upstream/main` has none and
pushes with no hook). A fixed `patched/hooks` path does not work: the Claude desktop app
turns a relative `core.hooksPath` into a per-worktree override that points at the main
checkout's copy of the hook, so a worktree on another branch would run main's hook. Install
the dispatcher once per clone, from any worktree on `main`:

```bash
d="$(git rev-parse --git-common-dir)/fork-hooks" && mkdir -p "$d" && cp patched/hooks/fork-hooks/pre-push "$d/pre-push" && chmod +x "$d/pre-push" && git config core.hooksPath "$d"
```

`git config core.hooksPath` should now print `<clone>/.git/fork-hooks` in every worktree.
A worktree where it prints anything else has an override of its own (the app writes one with
`git config --worktree core.hooksPath`); remove it with
`git config --worktree --unset core.hooksPath`, and the worktree uses the clone's dispatcher
again.

- Only a push to `main` runs the hook's tests; any other branch or tag (an upstream-PR
  branch cut from `upstream/main` has no `patched/` folder) pushes without tests. A push
  to `main` runs `patched/scripts/test-local.sh fast <commit> <base>` from the pre-push
  hook: the checks (`bun run check`: projection, determinism, typecheck, lint), the smoke
  tier, and every unit and integration test file the push adds or changes.
- A push to `main`, and a release, also need `patched/scripts/test-local.sh full <commit>`:
  the checks plus every smoke, unit and integration file, in parallel and the series' patch
  tests first (section 1b; about 1 h 20 min). A pass is recorded for the tree without `patched/`,
  so a rebase or a change to the fork's notes and scripts keeps it. `full-serial` is
  upstream's own runner, one file at a time (8 hours and more); its pass counts the same.
- `patched/known-local-failures.txt` lists the test files that fail on this machine
  whatever the change; `full` fails only on a failure outside it. Take a file off the list
  once it passes.
- Never push past the hook; fix the failure, or record a machine-only failure in the list
  with its reason.

## 1b. Parallel runs, patch tests first, failures as they happen

`full`, `patches` and `files` run through `patched/scripts/test-runner.ts`:

```bash
patched/scripts/test-local.sh full <commit>                      # everything, patch tests first; records a pass
patched/scripts/test-local.sh patches <commit>                   # only the tests tied to the series' patches
patched/scripts/test-local.sh patches <commit> --patches 21,28   # only those patches' tests
patched/scripts/test-local.sh patches <commit> --rest            # patch tests, then everything else (records nothing)
patched/scripts/test-local.sh files <commit> '^(t-foo|t-bar)$'   # named files (summary names, see below)
patched/scripts/test-local.sh plan <commit> [--patches 21]       # the queue and each patch's tests; runs nothing
patched/scripts/test-local.sh watch|status|stop [<run-dir>]      # the latest run by default
```

Options: `--workers N` (default 8; use 6 when `uptime` shows a load average above the core count, about 12, before the run starts), `--stop-on-first`, `--max-failures N` (default 25: the run
stops when that many files failed, since something broader is wrong), `--no-check` (skip `bun run
check`; not for `full`), `--real-home`.

**How it runs.** Upstream runs smoke and unit files one at a time in one checkout, because
packaging tests regenerate `dist/`; its CI gets parallelism from separate checkouts. The runner
does the same on this Mac: N worktrees of the commit, each with its own `bun install` and
projections (about 10 s each), and a queue of test files. Each file is one call of upstream's
`tests/run-tests.ts --<tier> --verbose --file-retries 1`, picked with `--exclude` so upstream's
tier semantics hold (a `--filter` would make it an explicit selection, where an optional skip
fails). Each job gets its own `TMPDIR`, and each worker its own empty `HOME` (`--real-home` keeps
yours); upstream's runner already gives every file its own git config. t238 and t249 run as one
job, as upstream's shard affinity asks. The Claude preflight `t19` runs first: when it does not
pass (it fails on this Mac, see `known-local-failures.txt`), integration files run with
`--no-llm`, which is the state a serial run is in after its preflight fails.

**The queue.** Smoke files and `t19` first (nothing else starts until they finish, and a smoke
failure stops the run, as upstream's does). Then the tests tied to the series' patches, then
the rest. The series is the commits on top of `upstream/main` (so `git fetch upstream` first),
leaving out `patched:` and `fork:`; a patch's id is its number in `PATCHES.md`, matched by
subject. A test is tied to a patch:

- **own**: the patch adds or changes the test file;
- **near**: the test names a file the patch changes (`aidlc-unit`, `harness/team-unit-merge`,
  the path itself), and at most 40 test files name it;
- **wide**: the test names a hub file the patch changes (`aidlc-lib`, `aidlc-orchestrate`,
  `aidlc-utility`, named by hundreds of tests), ranked by how many changed files it names and how
  rare they are.

own and near run first, shortest first so most patch verdicts are in within minutes (a file
longer than half the group's share per worker starts at once, so it does not end the group),
then wide by rank, then the rest longest first.

Why names and not imports or coverage: most tests run the engine as a CLI
(`bun core/tools/aidlc-engine.ts ...`), so neither a test's import graph nor bun's coverage (which
does not follow child processes) sees what it exercises; a test that names a tool file is how
tests reach it, and the count of naming tests separates a specific tool from a hub cheaply
(`plan` takes about 2 seconds). It misses a test that names nothing the patch touches: of the
six regressions the move to upstream main found, t07-hook-audit-logger and
t-printed-lines-keyboard-dash were near, t-approve-then-add-next, t-skip-undo-window and
t-skip-beside-reopen wide, and t-persons-words-pin tied to no patch (it pins a list in a test
harness file the patch did not change). `plan` prints each patch's counts and the queue.

**Names.** A file is named as upstream's summary names it: its basename without `.test.ts`,
`integration-<name>` where a unit file has the same name (`integration-t19`),
`plugin-<plugin>-<name>` for a plugin's test. `files` and `known-local-failures.txt` use these
names.

**Timing on this Mac** (12 cores, 36 GB):

| Run (commit `d1a6d94b8`) | Wall | Each file, against running alone | Verdicts |
|---|---|---|---|
| 61 unit files (every 13th), upstream's runner, serial | 22.5 min | 1.00 | |
| the same 61, 4 workers | 7.5 min | 1.17 | the same as serial, 61 of 61 |
| the same 61, 8 workers | 5.0 min | 1.17 | the same as serial |
| the same 61, 12 workers | 4.4 min | 1.23 | the same as serial |
| `patches`: 226 files (smoke, t19, the 210 patch-tied), 8 workers | 45 min | 1.9 | 9 new failures, the first at 3 min 43 s |

The sample's files are light; the patch-tied files are the heavy ones (they start many engine
processes, and some run their own pools), so at 8 workers the Mac is CPU-bound (load average
35 to 39 on 12 cores) and each file takes 1.9 times as long as alone. More workers then do not
help much (12 was measured only on the light sample); the default is 8, which also leaves the
Mac usable.

**A full run takes about 1 h 20 min at 8 workers** (`plan` prints the estimate for a commit): the
suite is about 5.5 h of file time on this Mac, 8 workers at 1.9 do 4.2 times a serial run's work,
plus the gate and the queue's tail. `bun run check` (projections, determinism, typecheck,
lint; about 7 min) runs beside the tests in the run's own checkout, which is no worker, and a
failed check is a `fail` event named `bun-run-check` like a failed file. Upstream's serial
runner took 8 hours and more. In the `patches` run above, seven of the nine failures were events
within the first 10 minutes. The runner keeps each file's time in `.git/aidlc-test-timings.json`
(as it would take alone), so the order and the estimate improve with each run.

**Where a run's output goes.** `.git/aidlc-test-runs/<UTC time>-<commit>-<mode>/` (the newest
ten are kept; `latest` links the newest):

- `events.jsonl`: one JSON line per event, written as it happens. `start` (jobs, workers, the
  estimate); `fail` for each file that still failed after its retry and is not a known local
  failure: `file`, `name`, `tier`, `group`, `patches` (`own`, `near`, `wide` ids), `likely` (the
  own and near patches with their subjects), `retried`, `error` (the first failing case and what
  it expected), `log` (that file's full log), `tail` (its last 40 lines); `known-fail` for a
  listed one; `flaky` for a file that passed on its retry; `phase` when the patch tests are done;
  `done` or `stopped` with the totals and the summary's path.
- `check.log`: the output of `bun run check`;
- `summary.txt`: the per-file table in upstream's format, and totals; `status.json`: progress,
  rewritten after every file; `logs/<name>/`: upstream's log directory for each file;
  `runner.log`: the runner's own lines.

**How an agent drives a run.**

1. Start it in the background (Bash `run_in_background`), so you are told when it ends:
   `patched/scripts/test-local.sh full <commit>`. Its first lines print the run directory.
2. Follow it with Claude Code's `Monitor`, command `patched/scripts/test-local.sh watch <run-dir>`,
   `timeout_ms` 1800000. `watch` prints one line per `start`, `fail`, `phase` and `done`/`stopped`
   event and exits at the end; it keeps its place in `<run-dir>/.watch-cursor`, so when the
   Monitor expires, arm the same command again and nothing is printed twice or lost.
3. On each `FAIL` line, judge it while the run goes on:
   - Read the `log` (or the event's `tail`). A file tied to a patch as own or near is most
     likely ours: read that patch (`git show <sha>`), `likely` names it.
   - Run the file alone on the same commit:
     `patched/scripts/test-local.sh files <commit> '^<name>$' --no-check --workers 1`. Fails
     alone too: a real failure. Passes alone: flaky; run it twice more, and if it only fails
     beside other files, add it to the parallel-only list below.
   - A failure upstream has too (run the file on `upstream/main` the same way) or one caused by
     this Mac goes in `known-local-failures.txt` with its reason.
4. Fix ours in another worktree (`git worktree add ../aidlc-fix-<n> <branch>`), as a fixup of the
   patch (section 2). The run tests its own checkout of the commit, so editing elsewhere does
   not disturb it. Check the fix with `files` or `patches --patches <id>` on the new commit
   while the run goes on; keep such a run to a few files, since it shares the CPU with the
   full one.
5. Let the run finish when it still tells you something: every failure it finds now is one the
   next run does not have to find. Stop it (`test-local.sh stop <run-dir>`; within seconds it
   stops the files that are running, keeps what finished, and writes its summary) when its result no longer counts: a fix that
   changes many files' outcomes, a storm of failures with one cause, or a run on a commit you
   have already replaced and whose remaining files the fix touches. A pass is recorded only for
   the commit a complete `full` tested, so after any fix the pass needs a new `full` on the
   fixed commit. Do not kill the background task instead: the runner then cannot stop its jobs.
6. `--stop-on-first` is for a quick yes/no (a candidate fix, a rebase): the run stops at the
   first new failure.

**Only flaky beside other files.** Files that passed in a serial run and failed in a parallel
one on the same commit:

None found so far. The 61-file sample gave the same verdict for every file at 4, 8 and 12
workers as serially. The failures the `patches` run found that were checked alone (t07, t91,
t131, t144, t221, t342) fail alone too, in a plain clone, and pass on upstream's base.
Add a file here, with the run that showed it, when it fails beside other files and passes alone
three times.

## 2. Change a patch

Fold a fix into the commit it belongs to, and replay the rest:

```bash
git switch -c work main
# edit, then:
git commit --fixup=<the patch's commit>
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>
```

A new patch is a new commit placed by its group (section 1). Check each commit
typechecks, run the patch's own tests and the fixtures (`patched/scripts/install-local.sh`
with a `.9xx` version first), update its section in `PATCHES.md`, then replace `main`:

```bash
git push --force-with-lease origin work:main
```

`main` is rewritten on every change: that is the series being kept as reviewable commits.
A release tag keeps every published state reachable.

## 3. Move to a newer upstream base

The new base is a release tag or, once upstream has merged our fixes there, a commit of
upstream's `main`:

```bash
git fetch upstream --tags
git switch -c move main
git rebase --onto <new base> <old base>     # resolve conflicts patch by patch
```

For each fix, check whether upstream now fixes it itself: apply only its tests to the new
base and run them; a test that passes without the fix means the patch can be dropped or
made thinner. A patch upstream merged moves to Merged upstream in `PATCHES.md` and keeps its
number. `core/tools/aidlc-lib.ts` takes no new names upstream (t-aidlc-lib-only-shrinks):
put a patch's new code where upstream now keeps that area, or in a module of its own. Then
update the base in `README.md` and `PATCHES.md`, verify as in section 2, and replace `main`.

## 4. Release

```bash
patched/scripts/test-local.sh full origin/main   # once per main; about 1 h 20 min (section 1b)
patched/scripts/release.sh
```

`release.sh` refuses unless `main`'s exact tree passed a full local run on this machine
(section 1a); a change only under patched/ keeps the pass. It then runs upstream's Preview Release workflow on `main`, which in this
fork only builds for every platform, attests and publishes `v<version>` as a pre-release:
its test jobs and upstream's Full Suite run only in upstream. The script stops at the first
failed job, cancels the run and names the job's log. A run on a commit that is already
released is skipped.

The version is the patch release after the base's `AIDLC_VERSION`, as a preview of that day,
with our builds from `.101` (`AIDLC_PREVIEW_BUILD_FLOOR` in the workflow): on a base whose
`AIDLC_VERSION` is 2.11.2, the first release of a day is `2.11.3-preview.<YYYYMMDD>.101`.

## 5. Roll a release into a project

In a scratch clone of the project, never in a checkout that holds live Unit work:

```bash
v=<version> && aidlc config --pin "$v" --yes && aidlc config --harness claude --yes
git add -A && git commit -m "Engine shell: pin release $v" && git push -u origin HEAD
```

Open the pull request. Once it is merged, every checkout of the project runs
`aidlc config --pin <version> --yes` once (README, Installing a release).

## 6. Open an upstream pull request

Upstream asks for an issue first. Then cut the fix from upstream's `main`, not from ours:

```bash
git fetch upstream
git switch -c fix/<name> upstream/main
git cherry-pick <the patch's commit>      # resolve against upstream main
git push -u origin fix/<name>
gh pr create --repo awslabs/aidlc-workflows --head maksymskuibida:fix/<name>
```

Nothing from `patched/` goes upstream. Once upstream merges a fix, the next move
(section 3) drops that patch from the series.
