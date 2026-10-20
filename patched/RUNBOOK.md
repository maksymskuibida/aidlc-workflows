# Runbook

Everything here runs from a clone of this repository with `git`, `bun`, `gh` and the
`aidlc` launcher installed. Add upstream once:

```bash
git remote add upstream https://github.com/awslabs/aidlc-workflows.git
git fetch upstream --tags
```

## 1. The series

`main` is upstream's release tag, then the patches, then our own commits:

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

```bash
git config core.hooksPath patched/hooks          # once per clone
```

- Every push runs `patched/scripts/test-local.sh fast <commit> <base>` from the pre-push
  hook: the checks (`bun run check`: projection, determinism, typecheck, lint), the smoke
  tier, and every unit and integration test file the push adds or changes.
- A push to `main`, and a release, also need `patched/scripts/test-local.sh full <commit>`:
  the checks plus the smoke, unit and integration tiers (about 4 hours). A pass is recorded for the tree without `patched/`, so a
  rebase or a change to the fork's notes and scripts keeps it.
- `patched/known-local-failures.txt` lists the test files that fail on this machine
  whatever the change; `full` fails only on a failure outside it. Take a file off the list
  once it passes.
- Never push past the hook; fix the failure, or record a machine-only failure in the list
  with its reason.

## 2. Change a patch

Fold a fix into the commit it belongs to, and replay the rest:

```bash
git switch -c work main
# edit, then:
git commit --fixup=<the patch's commit>
GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash v2.11.1
```

A new patch is a new commit placed by its group (section 1). Check each commit
typechecks, run the patch's own tests and the fixtures (`patched/scripts/install-local.sh`
with a `.9xx` version first), update its section in `PATCHES.md`, then replace `main`:

```bash
git push --force-with-lease origin work:main
```

`main` is rewritten on every change: that is the series being kept as reviewable commits.
A release tag keeps every published state reachable.

## 3. Move to a newer upstream release

```bash
git fetch upstream --tags
git switch -c move main
git rebase --onto <new tag> <old tag>      # resolve conflicts patch by patch
```

For each fix, check whether upstream now fixes it itself: apply only its tests to the new
tag and run them; a test that passes without the fix means the patch can be dropped or
made thinner. Then update the base in this README and `PATCHES.md`, verify as in section 2,
and replace `main`.

## 4. Release

```bash
patched/scripts/test-local.sh full origin/main   # once per main; about 4 hours
patched/scripts/release.sh
```

`release.sh` refuses unless `main`'s exact tree passed a full local run on this machine
(section 1a); a change only under patched/ keeps the pass. It then runs upstream's Preview Release workflow on `main`, which in this
fork only builds for every platform, attests and publishes `v<version>` as a pre-release:
its test jobs and upstream's Full Suite run only in upstream. The script stops at the first
failed job, cancels the run and names the job's log. A run on a commit that is already
released is skipped.

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
