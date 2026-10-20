# Patched AI-DLC

This is a fork of [awslabs/aidlc-workflows](https://github.com/awslabs/aidlc-workflows):
an upstream release plus our own patches as commits on top, released from this
repository. Everything outside `patched/` is upstream's code with those commits applied.
`patched/` holds what is ours only: the fixtures that prove the patches end to end, the
runbook, and the notes on each patch.

- **Base**: upstream's stable `v2.11.1`.
- **Branch `main`**: the base, then the patches (one commit each), then our own commits
  (this folder, and the release-workflow changes). `git log v2.11.1..main` is the series.
- **Releases**: `2.11.2-preview.<date>.<build>`, with our builds numbered from `.101`, so
  they never share a version string with an upstream preview. Each is a GitHub release of
  this repository, built and attested by upstream's own Preview Release workflow.

| Path | What |
|---|---|
| [`PATCHES.md`](PATCHES.md) | Each patch: what it fixes, what it needs before it, whether it can go upstream. |
| [`RUNBOOK.md`](RUNBOOK.md) | Change a patch, move to a newer upstream release, release, roll a release into a project, open an upstream PR. |
| [`fixtures/`](fixtures) | Shell drivers that run a team-mode workspace end to end against the installed `aidlc`. |
| [`scripts/install-local.sh`](scripts/install-local.sh) | Build this checkout and install it as a local test build. |
| [`scripts/test-local.sh`](scripts/test-local.sh) | Run the tests on this machine, `fast` for every push and `full` for `main` and releases (RUNBOOK section 1a). |
| [`hooks/pre-push`](hooks/pre-push) | Runs those tests before every push; turn on with `git config core.hooksPath patched/hooks`. |
| [`known-local-failures.txt`](known-local-failures.txt) | Test files that fail on this machine whatever the change. |
| [`scripts/release.sh`](scripts/release.sh) | Publish a release of `main` once it passed a full local run (RUNBOOK section 4). |

## Installing a release

A project pins a release in `.aidlc-version`. On a machine that runs the project:

```bash
v=$(cat .aidlc-version) && curl -fsSL "https://github.com/maksymskuibida/aidlc-workflows/releases/download/v$v/install.sh" | AIDLC_RELEASE_REPOSITORY=maksymskuibida/aidlc-workflows sh -s -- --version "$v"
```

```bash
v=$(cat .aidlc-version) && aidlc config --pin "$v" --yes && aidlc use "$v"
```

`aidlc config --pin` registers the pin for one checkout. Run it once in every checkout of
the project: each Unit worktree, a fresh clone, a re-created worktree, and the main
checkout after it pulls a shell that pins a new version. Until a checkout does, its
engine commands and hooks refuse with "this project's <version> pin is not registered on
this machine". `aidlc --version` prints the machine's active version, not the pin.

## Fixtures

Each fixture builds its own workspace next to itself (bare remotes, two clones, a fake
`gh`) and drives the machine's active `aidlc` (`~/.local/share/aidlc/active-version`;
`AIDLC_FIXTURE_VERSION` names another). `reset4.sh` builds the seed repositories from
`fixtures/templates/` when they are missing or were built by another version. The
workspaces are git-ignored.

| Fixture | Proves |
|---|---|
| `reset4.sh` + `t4a.sh` | Strategy `pr` end to end: claim, stages, code pull request, publish, pin, the dispatch bracket pin prints, gate, land, workspace pull request, finish; the next claim after finish. |
| `t4b.sh` (after `t4a.sh`) | Finish refusals: before merge, with drift, with the drift accepted; a repeat finish is idempotent. |
| `t4c.sh [aidlc]` | A Unit claimed in the clone whose own audit shard is already on main lands with a team shard of its own. |
| `t4d.sh` | A team Unit with reviews on: its git-ignored review records ride in the candidate, every review counts, main holds none. |
| `t4e.sh` | Strategy `merge` from unscoped main, reviews on, a worktree whose shard is on main; main never receives review records. |
| `t4f.sh` | A team main checkout says nothing runs there and where each claimed Unit is worked; a fresh worktree finds the project's space. |
| `t4g.sh` | A team Unit's step in progress skipped for that Unit (no gate for it, pin and land without its documents), and its Code Generation gate naming the Unit's landing, not Build and Test. |
| `repro-*.sh` | The individual dead ends behind the revision fix, each before and after. |

Fixture names such as `DEMO-2-alpha` and `example/ws` are made up.
