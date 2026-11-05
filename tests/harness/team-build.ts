// The helpers t-unit-merge-check (from upstream draft #2783) uses, as #2783's
// tests/harness/team-build.ts writes them; the rest of that harness is #2783's
// own flow, which this fork does not carry.

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

/** Remove every workspace, clone and host a case made; register as afterEach. */
export function cleanupTeamBuild(): void {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
}

// Offline and without background maintenance (git 2.47+ repacks after writes,
// which races back-to-back commands in small repos).
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

export function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `aidlc-team-${label}-`)));
  dirs.push(dir);
  return dir;
}
