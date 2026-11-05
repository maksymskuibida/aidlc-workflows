// A slice of upstream draft #2783 (awslabs/aidlc-workflows, its head
// a346dea3a): the merge check that sees each code repo's part of a team Unit
// merged its own way, and where a Unit's writes are. workspaceHomeLocation,
// sameGitAddress, RepoResult, gitIn, blobsAt, patchIdOf, MergeVerdict,
// unitMergeVerdict, unitWriteTargets, checkoutRepoReader, writesByRepo and
// mergedStatus are copied from #2783's aidlc-unit-teams.ts byte for byte, so
// this file folds into #2783's when it lands.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  intentRepos,
  readRecordedSourceCheckouts,
  recordedCheckoutOfListingPath,
  repoDir,
  sourceCheckoutListingRel,
} from "./aidlc-lib.ts";
import { gitAddressKey } from "./aidlc-workspace-repos.ts";
import { withoutCredentials } from "./aidlc-workspace-manifest.ts";

// What to record as the home's location for a workspace, or null when it is not
// a git repo (teams then keep today's flow in one checkout).
export function workspaceHomeLocation(projectDir: string): string | null {
  if (!existsSync(join(projectDir, ".git"))) return null;
  const read = (args: string[]): string => spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() ?? "";
  const remotes = read(["remote"]).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  const address = remote === null ? "" : read(["remote", "get-url", remote]);
  return address ? withoutCredentials(address.trim()) : "local";
}

// Two spellings of one git address (gitAddressKey).
export function sameGitAddress(a: string, b: string): boolean {
  return gitAddressKey(a) === gitAddressKey(b);
}

// --- A Unit's result, and whether it merged -----------------------------------
//
// What a team's push sends home on the claim: per repo, the branch, the commit
// the Unit started from, every head pushed (the last is current), each changed
// path's blob at the head (null when deleted) and the change's patch-id. The
// home checks each repo against its own integration branch with git alone.

export interface RepoResult {
  // A repo name, or "." for the workspace's own repo.
  repo: string;
  branch: string;
  base: string;
  heads: string[];
  paths: Record<string, string | null>;
  patch_id?: string;
  // The team's own check, for a home that cannot fetch the repo itself.
  reported?: { merged: boolean; commit?: string };
}

function gitIn(dir: string, args: string[], input?: string): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: result.stdout ?? "" };
}

// Each path's blob at a commit; a path the commit does not have is left out.
export function blobsAt(dir: string, commit: string, paths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (paths.length === 0) return blobs;
  const listed = gitIn(dir, ["ls-tree", "-r", "--full-tree", commit, "--", ...paths]);
  for (const line of listed.out.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    blobs.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[2]);
  }
  return blobs;
}

// The stable patch-id of the change from one commit to another over the paths.
export function patchIdOf(dir: string, from: string, to: string, paths: readonly string[]): string | null {
  const diff = gitIn(dir, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--", ...paths]);
  if (!diff.ok || diff.out.length === 0) return null;
  return gitIn(dir, ["patch-id", "--stable"], diff.out).out.split(" ")[0] || null;
}

export type MergeVerdict =
  | { merged: true; commit: string; how: "ancestry" | "same content" | "same change" }
  | { merged: false };

// Whether a repo's part of a Unit is in its integration branch: the last head
// is an ancestor of it (a merge commit, a fast-forward); or a first-parent
// commit after the base has every changed path at the head's blob and every
// deleted path gone (a squash, a rebase; a later edit to the same files comes
// after it); or one first-parent commit is the same change by patch-id.
// Anything else is not merged yet.
// ponytail: the walk reads the latest 500 first-parent commits after the base.
export function unitMergeVerdict(dir: string, integration: string, result: RepoResult): MergeVerdict {
  const head = result.heads.at(-1);
  if (head && gitIn(dir, ["merge-base", "--is-ancestor", head, integration]).ok) {
    return { merged: true, commit: head, how: "ancestry" };
  }
  const paths = Object.keys(result.paths);
  if (paths.length === 0) return { merged: false };
  const known = gitIn(dir, ["rev-parse", "--verify", "--quiet", `${result.base}^{commit}`]).ok;
  const commits = gitIn(dir, ["rev-list", "--first-parent", "--reverse", "--max-count=500", known ? `${result.base}..${integration}` : integration])
    .out.split("\n").filter(Boolean);
  for (const commit of commits) {
    const at = blobsAt(dir, commit, paths);
    if (paths.every((path) => (result.paths[path] === null ? !at.has(path) : at.get(path) === result.paths[path]))) {
      return { merged: true, commit, how: "same content" };
    }
  }
  if (result.patch_id) {
    for (const commit of commits) {
      if (patchIdOf(dir, `${commit}^`, commit, paths) === result.patch_id) return { merged: true, commit, how: "same change" };
    }
  }
  return { merged: false };
}

// A Unit's writes by the repo each is in, as its source manifest records them,
// with the folder its push runs in and how the source walk names that folder's
// files (its listing keys' prefix): a write names its repo; or is a recorded
// checkout's (`<label>@checkout/<path>`, a worktree or clone the agent built
// in and recorded), read as the recorded repo that checkout is of by git's own
// repository, in the checkout's folder; or is in the work's one recorded repo;
// or in the workspace's own repo ("."). A checkout of no recorded repo keeps
// its write at the workspace, where the push names it.
export function unitWriteTargets(
  projectDir: string,
  writes: ReadonlyArray<{ path: string; repo?: string }>,
): Map<string, { dir: string; paths: string[]; listedAs: string }> {
  const recorded = intentRepos(projectDir);
  const checkouts = writes.some((write) => write.repo === undefined) ? readRecordedSourceCheckouts(projectDir) : [];
  const repoOf = checkoutRepoReader(projectDir, recorded);
  const targets = new Map<string, { dir: string; paths: string[]; listedAs: string }>();
  const add = (repo: string, dir: string, listedAs: string, path: string): void => {
    const at = targets.get(repo) ?? { dir, paths: [], listedAs };
    at.paths.push(path);
    targets.set(repo, at);
  };
  for (const write of writes) {
    const inCheckout = write.repo === undefined ? recordedCheckoutOfListingPath(write.path, checkouts) : null;
    if (inCheckout !== null && inCheckout.rest !== "") {
      const { checkout, rest } = inCheckout;
      const repo = repoOf(checkout.real);
      if (repo) {
        add(repo, checkout.real, `\0${sourceCheckoutListingRel(checkout.label)}/`, rest);
        continue;
      }
    }
    const repo = write.repo ?? (recorded.length === 1 ? recorded[0] : ".");
    add(repo, repo === "." ? projectDir : repoDir(projectDir, repo), repo === "." ? "\0" : `${repo}\0`, write.path);
  }
  return targets;
}

// Which recorded repo a recorded checkout's folder is of: a worktree shares
// its repo's own git folder, a clone of it its origin; null for neither.
function checkoutRepoReader(projectDir: string, recorded: readonly string[]): (real: string) => string | null {
  const commonDir = (dir: string): string | null => {
    const read = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf-8" });
    return read.status === 0 && read.stdout.trim() ? resolve(dir, read.stdout.trim()) : null;
  };
  const originOf = (dir: string): string | null => {
    const read = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf-8" });
    return read.status === 0 && read.stdout.trim() ? read.stdout.trim() : null;
  };
  const seen = new Map<string, string | null>();
  return (real) => {
    if (!seen.has(real)) {
      const own = commonDir(real);
      const origin = originOf(real);
      seen.set(real,
        recorded.find((repo) => own !== null && commonDir(repoDir(projectDir, repo)) === own) ??
          recorded.find((repo) => {
            const theirs = origin === null ? null : originOf(repoDir(projectDir, repo));
            return theirs !== null && sameGitAddress(origin!, theirs);
          }) ??
          null);
    }
    return seen.get(real) ?? null;
  };
}

// The same, by repo only.
export function writesByRepo(projectDir: string, writes: ReadonlyArray<{ path: string; repo?: string }>): Map<string, string[]> {
  return new Map([...unitWriteTargets(projectDir, writes)].map(([repo, target]) => [repo, target.paths]));
}

// How far a pushed Unit's repos are merged, in words: "checkout-api merged,
// billing not merged yet (1 of 2 merged)".
export function mergedStatus(verdicts: ReadonlyArray<{ repo: string; merged: boolean }>): string {
  const merged = verdicts.filter((verdict) => verdict.merged).length;
  const parts = verdicts.map((verdict) => `${verdict.repo === "." ? "the repo" : verdict.repo} ${verdict.merged ? "merged" : "not merged yet"}`);
  return verdicts.length === 1 ? parts[0] : `${parts.join(", ")} (${merged} of ${verdicts.length} merged)`;
}
