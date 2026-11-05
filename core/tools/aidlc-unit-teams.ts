// A slice of upstream draft #2783 (awslabs/aidlc-workflows, its item 5, commit
// 65894dd9e): the merge check that sees each code repo's part of a team Unit
// merged its own way. RepoResult, gitIn, blobsAt, patchIdOf, MergeVerdict,
// unitMergeVerdict, writesByRepo and mergedStatus are copied from #2783's
// aidlc-unit-teams.ts byte for byte, so this file folds into #2783's when it
// lands.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { intentRepos } from "./aidlc-lib.ts";

// Whether teams may each own a Unit of work across repos here: the workspace is
// a git repo, the one condition #2783 keeps on it (its workspaceHomeLocation is
// null only without one). Elsewhere one session builds such work's Units.
export function teamsAcrossReposAllowed(projectDir: string): boolean {
  return existsSync(join(projectDir, ".git"));
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

// A Unit's writes by the repo each is in, as its source manifest records them:
// a write names its repo, or is in the work's one recorded repo, or in the
// workspace's own repo (".").
export function writesByRepo(projectDir: string, writes: ReadonlyArray<{ path: string; repo?: string }>): Map<string, string[]> {
  const recorded = intentRepos(projectDir);
  const byRepo = new Map<string, string[]>();
  for (const write of writes) {
    const repo = write.repo ?? (recorded.length === 1 ? recorded[0] : ".");
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), write.path]);
  }
  return byRepo;
}

// How far a pushed Unit's repos are merged, in words: "checkout-api merged,
// billing not merged yet (1 of 2 merged)".
export function mergedStatus(verdicts: ReadonlyArray<{ repo: string; merged: boolean }>): string {
  const merged = verdicts.filter((verdict) => verdict.merged).length;
  const parts = verdicts.map((verdict) => `${verdict.repo === "." ? "the repo" : verdict.repo} ${verdict.merged ? "merged" : "not merged yet"}`);
  return verdicts.length === 1 ? parts[0] : `${parts.join(", ")} (${merged} of ${verdicts.length} merged)`;
}
