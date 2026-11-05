// covers: subcommand:aidlc-state:set-unit-ownership, subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin, subcommand:aidlc-unit:gate, subcommand:aidlc-unit:merged, function:unitMergeVerdict
//
// Team-owned Units for work across repos (a slice of upstream draft #2783). A
// Unit whose code is in a repo of its own (api/) goes through claim, publish,
// pin, gate and land as any team Unit; its code reaches api's main through
// api's own review, merged whichever way api merges. Publish records api's part
// on the claim, pin says how far it merged, and the merge gate's Approve waits
// until it has merged (or the lead's word, `unit merged`, on the claim, counts
// it). A folder the source manifest names stands for the files changed under
// it, and a write in a recorded checkout of api counts for api.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { AIDLC_SRC, intentsDirOf, seededRecordDir } from "../harness/fixtures.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF,
  STATE,
  UNIT,
  cleanupTempDirs,
  git,
  makeSeed,
  replyAfterPin,
  prepareCandidate,
  runMergeTool,
  tempDirs,
  unitProgressRow,
} from "../harness/team-unit-merge.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupTempDirs);

const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

function bareRemote(label: string): string {
  const remote = mkdtempSync(join(tmpdir(), `aidlc-${label}-remote-`));
  tempDirs.push(remote);
  git(remote, ["init", "--bare", "-b", "main"]);
  for (const [key, value] of Object.entries(AUTOMATIC_GIT_MAINTENANCE_OFF)) git(remote, ["config", key, value]);
  return remote;
}

// The workspace records api as its code repo (intents.json `repos`), keeps
// api/ out of its own git, and api is a repo with a remote of its own.
function crossRepoSeed(): { seed: string; remote: string; apiRemote: string } {
  const { seed, remote } = makeSeed();
  const registry = join(intentsDirOf(seed), "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8")) as Array<Record<string, unknown>>;
  rows[0].repos = ["api"];
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(seed, ".gitignore"), `${readFileSync(join(seed, ".gitignore"), "utf-8")}\n/api/\n`);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "record api as the work's code repo"]);
  git(seed, ["push", "origin", "main"]);

  const apiRemote = bareRemote("api");
  const apiSeed = mkdtempSync(join(tmpdir(), "aidlc-api-seed-"));
  tempDirs.push(apiSeed);
  git(apiSeed, ["init", "-b", "main"]);
  git(apiSeed, ["config", "user.name", "main"]);
  git(apiSeed, ["config", "user.email", "main@example.test"]);
  mkdirSync(join(apiSeed, "src"), { recursive: true });
  writeFileSync(join(apiSeed, "src", "app.py"), "app = 'base'\n");
  git(apiSeed, ["add", "-A"]);
  git(apiSeed, ["commit", "-m", "api seed"]);
  git(apiSeed, ["remote", "add", "origin", apiRemote]);
  git(apiSeed, ["push", "-u", "origin", "main"]);
  git(seed, ["clone", "--no-local", apiRemote, "api"]);
  return { seed, remote, apiRemote };
}

// What the developer does in api/: the Unit's branch, its code, pushed.
function buildInApi(checkout: string, apiRemote: string, unit: string): string {
  git(checkout, ["clone", "--no-local", apiRemote, "api"]);
  const api = join(checkout, "api");
  git(api, ["config", "user.name", "dev"]);
  git(api, ["config", "user.email", "dev@example.test"]);
  git(api, ["switch", "-c", `unit/${unit}`]);
  writeFileSync(join(api, "src", `${unit}.py`), `${unit} = 'built by the team'\n`);
  git(api, ["add", "-A"]);
  git(api, ["commit", "-m", `${unit}: the Unit's code`]);
  git(api, ["push", "-u", "origin", `unit/${unit}`]);
  return git(api, ["rev-parse", "HEAD"]);
}

// The code PR merged on the host: squash (one new commit on main) or a merge commit.
function mergeOnHost(remote: string, branch: string, how: "squash" | "merge"): void {
  const host = mkdtempSync(join(tmpdir(), "aidlc-api-host-"));
  tempDirs.push(host);
  git(tmpdir(), ["clone", "--no-local", remote, host]);
  git(host, ["config", "user.name", "host"]);
  git(host, ["config", "user.email", "host@example.test"]);
  git(host, ["fetch", "origin", branch]);
  if (how === "squash") {
    git(host, ["merge", "--squash", `origin/${branch}`]);
    git(host, ["commit", "-m", `${branch} (squash)`]);
  } else {
    git(host, ["merge", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`]);
  }
  git(host, ["push", "origin", "main"]);
}


// Code Generation's source manifest: the Unit's file in api, or (as Code
// Generation often writes it) the folder it is in.
function writeManifest(checkout: string, unit: string, path = `src/${unit}.py`): void {
  const dir = join(seededRecordDir(checkout), "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: [{ repo: "api", path }],
  }, null, 2)}\n`);
}

// The lead's main has api/ checked out at its integration branch.
function pin(seed: string): Record<string, unknown> {
  const pinned = runMergeTool(UNIT, ["pin", "alpha"], seed);
  expect(pinned.status, pinned.out).toBe(0);
  return JSON.parse(pinned.stdout) as Record<string, unknown>;
}
// The lead's words that api merged, as the agent writes them to the request file.
function saysMerged(seed: string, words: string): { status: number; out: string } {
  const file = "aidlc/.aidlc-request-text/unit-merged-alpha.txt";
  mkdirSync(join(seed, "aidlc", ".aidlc-request-text"), { recursive: true });
  writeFileSync(join(seed, ...file.split("/")), `${words}\n`);
  return runMergeTool(UNIT, ["merged", "alpha", "--repo", "api", "--request-file", file], seed);
}
function gate(seed: string): { status: number; out: string } {
  replyAfterPin(seed, "alpha");
  return runMergeTool(UNIT, ["gate", "alpha", "--decision", "approve", "--user-input", "Approve pinned candidate"], seed);
}

describe("team-owned Units across repos: the code merges through each repo's own review", () => {
  test("team ownership is taken for work that records repos, in a workspace in git", () => {
    const { seed } = crossRepoSeed();
    const set = runMergeTool(STATE, ["set-unit-ownership", "team"], seed);
    expect(set.out).not.toContain("not available yet for work across repos");
  });

  test("not merged: pin says so and approve waits; squash-merged later: approve passes without a re-pin and land lands", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    const before = pin(seed);
    expect(before.code_merges).toBe("api not merged yet");
    expect((before.merge_gate as Record<string, string>).code).toContain("Approve waits until every repo has merged");
    const refused = gate(seed);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("aidlc unit merged alpha --repo <repo>");
    mergeOnHost(apiRemote, "unit/alpha", "squash");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
    expect(unitProgressRow(seed, "alpha")).toContain("| alpha | alpha-team |");
  });

  test("a merge commit on the host reads as merged by ancestry", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    mergeOnHost(apiRemote, "unit/alpha", "merge");
    expect(pin(seed).code_merges).toBe("api merged");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
  });

  test("the lead's word, on the claim, lets a merge the check cannot see through once the Unit is pinned again", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    pin(seed);
    const word = saysMerged(seed, "I merged api's change by hand in PR 12");
    expect(word.status, word.out).toBe(0);
    expect(word.out).toContain("pin");
    expect(pin(seed).code_merges).toBe("api merged");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
  });

  test("the lead's word is the person's own: --person-words, never --user-input", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    const inline = runMergeTool(UNIT, ["merged", "alpha", "--repo", "api", "--person-words", "api merged it by hand"], seed);
    expect(inline.status, inline.out).toBe(0);
    expect(pin(seed).code_merges).toBe("api merged");
    const old = runMergeTool(UNIT, ["merged", "alpha", "--repo", "api", "--user-input", "api merged it by hand"], seed);
    expect(old.status).not.toBe(0);
    expect(old.out).toContain("--request-file");
    const other = runMergeTool(UNIT, ["merged", "alpha", "--repo", "web", "--person-words", "web merged"], seed);
    expect(other.status).not.toBe(0);
    expect(other.out).toContain("not web");
  });

  test("a republish whose head in api moved drops the lead's word for api", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    let checkout = "";
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { checkout = dir; buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    expect(saysMerged(seed, "api has it, merged by hand").status).toBe(0);
    expect(pin(seed).code_merges).toBe("api merged");
    const api = join(checkout, "api");
    writeFileSync(join(api, "src", "alpha.py"), "alpha = 'changed after the word'\n");
    git(api, ["commit", "-am", "alpha: a change after the word"]);
    git(api, ["push", "origin", "unit/alpha"]);
    const republished = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    expect(pin(seed).code_merges).toBe("api not merged yet");
  });

  test("a review fix: the developer commits it in api and publishes again; the host squashes the fixed branch; a new pin sees it merged", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    let checkout = "";
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { checkout = dir; buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha"),
    });
    const first = pin(seed);
    expect(first.code_merges).toBe("api not merged yet");
    const api = join(checkout, "api");
    writeFileSync(join(api, "src", "alpha.py"), "alpha = 'built by the team, fixed in review'\n");
    git(api, ["commit", "-am", "alpha: review fix"]);
    git(api, ["push", "origin", "unit/alpha"]);
    const republished = runMergeTool(UNIT, ["publish", "alpha"], checkout);
    expect(republished.status, republished.out).toBe(0);
    mergeOnHost(apiRemote, "unit/alpha", "squash");
    const second = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(second.status, second.out).toBe(0);
    expect((JSON.parse(second.stdout) as Record<string, unknown>).code_merges).toBe("api merged");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
    const landed = runMergeTool(UNIT, ["land", "alpha"], seed);
    expect(landed.status, landed.out).toBe(0);
  });

  test("a write in a recorded checkout of api (a worktree the agent built in) counts for api", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => {
        git(dir, ["clone", "--no-local", apiRemote, "api"]);
        const tree = join(dir, ".claude", "worktrees", "alpha-api");
        git(join(dir, "api"), ["worktree", "add", "-q", "-b", "unit/alpha", tree]);
        const added = runMergeTool(UTILITY, ["intent", "add-checkout", join(".claude", "worktrees", "alpha-api")], dir);
        expect(added.status, added.out).toBe(0);
        git(tree, ["config", "user.name", "dev"]);
        git(tree, ["config", "user.email", "dev@example.test"]);
        writeFileSync(join(tree, "src", "alpha.py"), "alpha = 'built in a worktree'\n");
        git(tree, ["add", "-A"]);
        git(tree, ["commit", "-m", "alpha: the Unit's code"]);
        git(tree, ["push", "-u", "origin", "unit/alpha"]);
      },
      beforeCommit: (dir) => {
        const stage = join(seededRecordDir(dir), "construction", "alpha", "code-generation");
        mkdirSync(stage, { recursive: true });
        writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify({
          stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "alpha-api@checkout/src/alpha.py" }],
        }, null, 2)}\n`);
      },
    });
    expect(pin(seed).code_merges).toBe("api not merged yet");
    mergeOnHost(apiRemote, "unit/alpha", "squash");
    expect(pin(seed).code_merges).toBe("api merged");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
  });

  test("a folder in the source manifest stands for the files changed under it, so a squash reads as merged", () => {
    const { seed, remote, apiRemote } = crossRepoSeed();
    prepareCandidate(remote, "alpha", "alpha-team", {
      afterClaim: (dir) => { buildInApi(dir, apiRemote, "alpha"); },
      beforeCommit: (dir) => writeManifest(dir, "alpha", "src/"),
    });
    mergeOnHost(apiRemote, "unit/alpha", "squash");
    expect(pin(seed).code_merges).toBe("api merged");
    const approved = gate(seed);
    expect(approved.status, approved.out).toBe(0);
  });
});
