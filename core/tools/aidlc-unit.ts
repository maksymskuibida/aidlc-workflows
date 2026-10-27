// aidlc-unit.ts - atomic Unit claim registry and checkout-local scope binding.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  activeIntentUuid,
  activeSpace,
  artifactFilename,
  auditBlockField,
  auditShardBlocks,
  auditShardName,
  type AuditShardEvent,
  type CachedUnitClaim,
  candidateReviewCoverageProjection,
  clearClaimGeneration,
  clearUnitScopeStamp,
  committedTextBytes,
  ensureCloneId,
  errorMessage,
  extractMarkdownSection,
  filterProducesByKind,
  getField,
  humanPresenceGuardDisabled,
  idSuffix,
  intentRepos,
  invalidateLiveClaimPayloadCache,
  isNonAnswer,
  isReadOnlyEngineProbe,
  isTeamUnitOwnership,
  isoTimestamp,
  loadStageGraphAll,
  parseArgs,
  parseBoltDag,
  readAuditShardEvents,
  readUnitClaimRegistryCache,
  readApplicableTeamUnitScopeStamp,
  readUnitMergeTransaction,
  readStateFile,
  readUnitGateRhythm,
  readUnitScopeStamp,
  parseReviewRecordBytes,
  pairedReviewRecordForCompletion,
  relativeRecordDir,
  repoDir,
  REVIEW_RECORDS_DIR,
  reviewRecordDigest,
  type ReviewRecord,
  requireLiveClaimForTeamUnit,
  resolveProjectDir,
  resolveProjectFlag,
  resolveReviewClass,
  teamSkeletonOn,
  type UnitMergeEvidence,
  type UnitMergeTransaction,
  UNIT_MERGE_DIR,
  type UnitScopeStamp,
  unitGateStatus,
  unitLifecycleSnapshot,
  unitDependencyPath,
  unitMergedReceipts,
  unitMergeTransactionPath,
  unitMajorConstructionStageSlugs,
  unitParticipantPath,
  unitReleasePendingPath,
  validateUnitName,
  withAuditLock,
  writeUnitClaimRegistryCache,
  writeUnitMergeTransaction,
  writeStateFile,
  writeUnitScopeStamp,
  writeClaimGeneration,
  writeFileAtomic,
} from "./aidlc-lib.js";
import {
  parseTestingContract,
  PLAN_APPROVAL_CHECKPOINT,
  recordedApprovalFingerprint,
  resolveTestingPosture,
} from "./aidlc-testing-posture.ts";
import { aidlcEngineCommand, isCompiledExecutable } from "./aidlc-runtime-paths.ts";

const CLAIM_FILE = ".aidlc-unit-claim.json";
const ZERO_OID = "0000000000000000000000000000000000000000";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface GitBytesResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  code: number;
}

// Bun's spawnSync stops a pipe read at 1 MiB and hands back what it had, and a
// Unit's audit shard outgrows that in one long attempt, so the cap is lifted
// the way the other git readers lift it. A run that could not start, was killed
// or overflowed is a failed run, whatever its exit status.
function gitBytes(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): GitBytesResult {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    env: { ...process.env, ...env },
    maxBuffer: 512 * 1024 * 1024,
  });
  const failure = result.error
    ? `${result.error.message}\n`
    : result.signal
      ? `git stopped by ${result.signal}\n`
      : "";
  return {
    ok: result.status === 0 && !result.error && !result.signal,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: failure + (result.stderr?.toString("utf-8") ?? ""),
    code: result.status ?? 1,
  };
}

function git(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const result = gitBytes(projectDir, args, env);
  return { ...result, stdout: result.stdout.toString("utf-8") };
}

// Why a git command failed: git commit reports some refusals ("nothing to
// commit", a hook's own words) on stdout, so stderr alone can be empty.
function gitFailure(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
}

function localGit(
  projectDir: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): GitResult {
  return git(projectDir, args, {
    GIT_NO_LAZY_FETCH: "1",
    ...env,
  });
}

function fail(message: string): never {
  throw new Error(message);
}

export interface UnitClaimPayload {
  version: 1;
  status: "claimed" | "released";
  owner: string;
  space: string;
  intent_uuid: string;
  intent_id8: string;
  unit: string;
  generation: number;
  nonce: string;
  base_oid: string;
  integration_ref: string;
  claim_ref: string;
  predecessor_oid: string | null;
  gate_rhythm: "per-stage" | "unit-end";
  audit_shard?: string;
  /**
   * The claiming clone's own shard, kept only when it is not `audit_shard`: it
   * was already on main when the Unit was claimed or first published, so the
   * Unit's rows are in `audit_shard` and this one stays as main has it.
   */
  clone_audit_shard?: string;
  candidate_tree_oid?: string;
  candidate_head_oid?: string;
}

export interface UnitClaimView {
  unit: string;
  status: "claimed" | "released";
  owner: string;
  generation: number;
  nonce: string;
  oid: string;
  ref: string;
  observedAt?: string;
  movementObserved?: boolean;
  payload: UnitClaimPayload;
}

export interface UnitClaimOverview {
  claimable: string[];
  claimed: Array<{ unit: string; owner: string; generation: number }>;
  waiting: Array<{ unit: string; blockedBy: string[] }>;
  claims: Map<string, UnitClaimView>;
  warning?: string;
}

function repositoryRemote(projectDir: string): string | null {
  const result = git(projectDir, ["remote"]);
  if (!result.ok) return null;
  const remotes = result.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  fail(`Multiple git remotes are configured (${remotes.join(", ")}); configure origin for Unit claims.`);
}

function currentBranch(projectDir: string): string {
  const result = git(projectDir, ["branch", "--show-current"]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : "main";
}

// A Way of Working line names the team's branch only when it says so: "the
// integration branch", "the base branch", "the merge-target branch" or "the
// merge target", with the name in backticks in the same sentence. A line such
// as "Integration tests live in `tests/integration`" names no branch.
const INTEGRATION_BRANCH_WORDS =
  "(?:(?:base|integration|merge[ -]target) branch|merge target)";
const INTEGRATION_BRANCH_AFTER_WORDS = new RegExp(
  `\\b${INTEGRATION_BRANCH_WORDS}\\b[^\`\\n.;]*\`([^\`]+)\``,
  "i",
);
const INTEGRATION_BRANCH_BEFORE_WORDS = new RegExp(
  `\`([^\`]+)\`[^.;\\n]*\\b${INTEGRATION_BRANCH_WORDS}\\b`,
  "i",
);

// The branch the team wrote down under "## Way of Working", narrowest layer
// first. Whatever it is called, that branch is used; a name git cannot use as a
// branch is refused with its file, never skipped for a broader layer's choice.
function affirmedIntegrationBranch(
  projectDir: string,
): { branch: string; source: string } | null {
  const space = activeSpace(projectDir);
  for (const name of ["project.md", "team.md", "org.md"]) {
    const source = `aidlc/spaces/${space}/memory/${name}`;
    let body: string;
    try {
      body = readFileSync(join(projectDir, ...source.split("/")), "utf-8");
    } catch {
      continue;
    }
    const section = extractMarkdownSection(body, "## Way of Working");
    const explicit =
      INTEGRATION_BRANCH_AFTER_WORDS.exec(section) ??
      INTEGRATION_BRANCH_BEFORE_WORDS.exec(section);
    if (!explicit) continue;
    const branch = explicit[1].trim();
    if (!git(projectDir, ["check-ref-format", "--branch", branch]).ok) {
      fail(
        `The integration branch "${branch}", named in ${source} under "Way of Working", ` +
          "is not a valid git branch name. Correct it there and run the command again.",
      );
    }
    return { branch, source };
  }
  return null;
}

function integrationBranch(projectDir: string, remote: string | null): string {
  if (remote) {
    const cached = git(projectDir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    if (cached.ok && cached.stdout.trim().startsWith(`${remote}/`)) {
      return cached.stdout.trim().slice(remote.length + 1);
    }
    const advertised = git(projectDir, ["ls-remote", "--symref", remote, "HEAD"]);
    const match = advertised.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  const current = currentBranch(projectDir);
  const configured = git(projectDir, ["config", `branch.${current}.merge`]);
  if (configured.ok && configured.stdout.trim().startsWith("refs/heads/")) {
    return configured.stdout.trim().slice("refs/heads/".length);
  }
  for (const candidate of ["main", "master", current]) {
    if (
      candidate &&
      git(projectDir, ["rev-parse", "--verify", `refs/heads/${candidate}`]).ok
    ) {
      return candidate;
    }
  }
  return current || "main";
}

function fetchIntegration(projectDir: string): {
  remote: string | null;
  branch: string;
  ref: string;
  oid: string;
} {
  const remote = repositoryRemote(projectDir);
  const affirmed = affirmedIntegrationBranch(projectDir);
  const branch = affirmed?.branch ?? integrationBranch(projectDir, remote);
  const named = affirmed
    ? `The integration branch "${affirmed.branch}", named in ${affirmed.source} under "Way of Working",`
    : null;
  if (remote) {
    const fetched = git(projectDir, ["fetch", remote, branch]);
    if (!fetched.ok) {
      fail(
        named
          ? `${named} could not be fetched from ${remote}: ${fetched.stderr.trim().replace(/^fatal:\s*/i, "")}`
          : `git fetch ${remote} ${branch} failed: ${fetched.stderr.trim()}`,
      );
    }
  }
  const ref = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
  const oid = git(projectDir, ["rev-parse", "--verify", ref]);
  if (!oid.ok) {
    fail(named ? `${named} does not exist in this repository.` : `Integration ref ${ref} does not exist.`);
  }
  return { remote, branch, ref, oid: oid.stdout.trim() };
}

function claimRef(intentId8: string, unit: string): string {
  return `refs/heads/claim/${intentId8}/${unit}`;
}

function fetchClaimRefs(projectDir: string, remote: string | null): void {
  if (!remote) return;
  const fetched = git(projectDir, [
    "fetch",
    "--no-filter",
    remote,
    "+refs/heads/claim/*:refs/remotes/" + remote + "/claim/*",
  ]);
  if (!fetched.ok) {
    fail(`Unit claim registry fetch failed: ${fetched.stderr.trim()}`);
  }
}

function refTip(
  projectDir: string,
  remote: string | null,
  ref: string,
): string | null {
  if (remote) {
    const found = git(projectDir, ["ls-remote", remote, ref]);
    if (!found.ok) {
      fail(`Unit claim registry read failed: ${found.stderr.trim() || found.stdout.trim()}`);
    }
    const line = found.stdout.trim().split(/\r?\n/).find(Boolean);
    return line ? line.split(/\s+/)[0] : null;
  }
  const found = git(projectDir, ["rev-parse", "--verify", ref]);
  return found.ok ? found.stdout.trim() : null;
}

function readPayload(
  projectDir: string,
  oid: string,
  options: { localOnly?: boolean } = {},
): UnitClaimPayload | null {
  const shown = options.localOnly
    ? localGit(projectDir, ["show", `${oid}:${CLAIM_FILE}`, "--"])
    : git(projectDir, ["show", `${oid}:${CLAIM_FILE}`, "--"]);
  if (!shown.ok) return null;
  try {
    const parsed = JSON.parse(shown.stdout) as UnitClaimPayload;
    if (
      parsed.version !== 1 ||
      (parsed.status !== "claimed" && parsed.status !== "released") ||
      typeof parsed.unit !== "string" ||
      !Number.isInteger(parsed.generation) ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f]{40}$/.test(parsed.base_oid) ||
      typeof parsed.integration_ref !== "string" ||
      typeof parsed.claim_ref !== "string" ||
      (parsed.audit_shard !== undefined &&
        (typeof parsed.audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(parsed.audit_shard))) ||
      (parsed.clone_audit_shard !== undefined &&
        (typeof parsed.clone_audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(parsed.clone_audit_shard))) ||
      (
        parsed.candidate_tree_oid !== undefined &&
        !/^[0-9a-f]{40}$/.test(parsed.candidate_tree_oid)
      ) ||
      (
        parsed.candidate_head_oid !== undefined &&
        !/^[0-9a-f]{40}$/.test(parsed.candidate_head_oid)
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function ensureObject(
  projectDir: string,
  remote: string | null,
  oid: string,
  ref: string,
): void {
  const hasCommit = (): boolean =>
    localGit(projectDir, ["cat-file", "-e", `${oid}^{commit}`]).ok;
  const payloadBlob = (): string | null => {
    const found = localGit(projectDir, ["rev-parse", `${oid}:${CLAIM_FILE}`]);
    return found.ok && /^[0-9a-f]{40}$/.test(found.stdout.trim())
      ? found.stdout.trim()
      : null;
  };
  const hasBlob = (blob: string | null): boolean =>
    blob !== null && localGit(projectDir, ["cat-file", "-e", blob]).ok;
  let blob = payloadBlob();
  if (hasCommit() && hasBlob(blob)) return;
  if (!remote) {
    fail(
      `Unit claim registry payload is unavailable at ${ref}; the local repository may be a partial clone with the claim payload blob missing.`,
    );
  }
  const fetched = git(projectDir, [
    "fetch",
    "--no-tags",
    "--no-filter",
    remote,
    ref,
  ]);
  if (!fetched.ok) {
    fail(
      `Unit claim registry fetch failed: ${fetched.stderr.trim()} ` +
        `(a partial clone requires a non-filtered fetch of ${ref}).`,
    );
  }
  blob = payloadBlob();
  if (blob && !hasBlob(blob)) {
    const hydrated = git(projectDir, [
      "fetch",
      "--no-tags",
      "--no-filter",
      remote,
      blob,
    ]);
    if (!hydrated.ok) {
      fail(
        `Unit claim registry fetch failed: ${hydrated.stderr.trim()} ` +
          `(the partial clone is missing payload blob ${blob} for ${ref}).`,
      );
    }
  }
  if (!hasCommit() || !hasBlob(blob)) {
    fail(
      `Unit claim registry fetch failed: payload at ${ref} is unavailable after a non-filtered fetch; ` +
        "the partial clone is missing the claim payload blob.",
    );
  }
}

function currentClaim(
  projectDir: string,
  remote: string | null,
  ref: string,
): UnitClaimView | null {
  const oid = refTip(projectDir, remote, ref);
  if (!oid) return null;
  ensureObject(projectDir, remote, oid, ref);
  const payload = readPayload(projectDir, oid, { localOnly: true });
  if (!payload) fail(`Unit claim registry payload is invalid at ${ref}.`);
  return {
    unit: payload.unit,
    status: payload.status,
    owner: payload.owner,
    generation: payload.generation,
    nonce: payload.nonce,
    oid,
    ref,
    payload,
  };
}

// git's own words when it has no author or committer identity to use.
const NO_GIT_IDENTITY =
  /identity unknown|Please tell me who you are|auto-detect email|no (?:email|name) was given/i;

// Builds a tree equal to `baseTreeOid` but with `path` replaced (or added) by
// `content`, via a scratch index so the real worktree/index is untouched.
function writeTreeWithBlob(
  projectDir: string,
  baseTreeOid: string,
  path: string,
  content: string,
): string {
  return writeTreeWithEntries(projectDir, baseTreeOid, [{ path, content }]);
}

// A tree equal to `baseTreeOid` except for the given files' new text.
function writeTreeWithEntries(
  projectDir: string,
  baseTreeOid: string,
  entries: ReadonlyArray<{ path: string; content: string }>,
): string {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-tree-"));
  const index = join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    const read = git(projectDir, ["read-tree", baseTreeOid], env);
    if (!read.ok) fail(`git read-tree failed: ${read.stderr.trim()}`);
    for (const entry of entries) {
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: projectDir,
        encoding: "utf-8",
        input: entry.content,
      });
      if (blob.status !== 0) fail(`git hash-object failed: ${(blob.stderr ?? "").trim()}`);
      const update = git(
        projectDir,
        ["update-index", "--add", "--cacheinfo", `100644,${(blob.stdout ?? "").trim()},${entry.path}`],
        env,
      );
      if (!update.ok) fail(`git update-index failed: ${update.stderr.trim()}`);
    }
    const tree = git(projectDir, ["write-tree"], env);
    if (!tree.ok) fail(`git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function createClaimCommit(
  projectDir: string,
  parentOid: string,
  payload: UnitClaimPayload,
  sourceTreeOid?: string,
  additionalParentOid?: string,
): string {
  // The claim is the person's own commit: their git name, email and signing
  // settings apply as they do to any commit they make, so a remote that
  // matches the committer to the pusher accepts it, and the claim history
  // shows who claimed.
  const tree = writeTreeWithBlob(
    projectDir,
    sourceTreeOid ?? parentOid,
    CLAIM_FILE,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  // commit-tree does not read commit.gpgsign on its own; porcelain commits do.
  const signed =
    git(projectDir, ["config", "--type=bool", "commit.gpgsign"]).stdout.trim() === "true";
  const commitArgs = [
    "commit-tree",
    tree,
    "-p",
    parentOid,
    ...(additionalParentOid ? ["-p", additionalParentOid] : []),
    ...(signed ? ["-S"] : []),
    "-m",
    `aidlc unit ${payload.status}: ${payload.unit} generation ${payload.generation}`,
  ];
  const commit = git(projectDir, commitArgs);
  if (!commit.ok) {
    if (NO_GIT_IDENTITY.test(commit.stderr)) {
      fail(
        "Git has no name and email for your commits yet. Set them with " +
          'git config --global user.name "Your Name" and git config --global user.email "you@example.com", ' +
          "then run the command again.",
      );
    }
    fail(`git commit-tree failed: ${commit.stderr.trim()}`);
  }
  return commit.stdout.trim();
}

// What the remote said when it refused a push: its own `remote:` lines, then
// git's reason in parentheses; the whole stderr when it printed neither.
function pushRefusal(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const remoteSaid = lines
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter(Boolean);
  const reason = lines
    .map((line) => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/.exec(line)?.[1])
    .find(Boolean);
  const parts = [...remoteSaid, ...(reason ? [`(${reason})`] : [])];
  return (parts.length > 0 ? parts : lines).join(" ");
}

// The compare-and-swap: ok when the ref moved from expectedOid to commitOid.
// A stale lease, or a ref the remote could not lock because another push got
// there first, is another claimant winning; any other push failure is the
// remote refusing the commit, and `refused` carries its reason for the person.
const CLAIM_RACE_LOST = /stale info|failed to update ref|cannot lock ref/;
function updateClaimRef(
  projectDir: string,
  remote: string | null,
  ref: string,
  commitOid: string,
  expectedOid: string | null,
): { ok: boolean; refused?: string } {
  if (remote) {
    const lease = `--force-with-lease=${ref}:${expectedOid ?? ""}`;
    const pushed = git(projectDir, ["push", remote, lease, `${commitOid}:${ref}`]);
    if (pushed.ok) return { ok: true };
    if (CLAIM_RACE_LOST.test(pushed.stderr)) return { ok: false };
    return { ok: false, refused: pushRefusal(pushed.stderr) };
  }
  const updated = git(projectDir, [
    "update-ref",
    ref,
    commitOid,
    expectedOid ?? ZERO_OID,
  ]);
  return { ok: updated.ok };
}

function activeIdentity(projectDir: string): {
  space: string;
  intentUuid: string;
  intentId8: string;
} {
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) fail("No active intent UUID; switch to the workflow before claiming a Unit.");
  return { space, intentUuid, intentId8: idSuffix(intentUuid) };
}

function stateAtOid(projectDir: string, oid: string): string {
  const relative = relativeRecordDir(projectDir);
  if (!relative) fail("Cannot resolve the active intent record path.");
  const shown = git(projectDir, ["show", `${oid}:${relative}/aidlc-state.md`, "--"]);
  if (!shown.ok) fail("The fetched integration ref does not contain the active intent state.");
  return shown.stdout;
}

function dependencyBodyAtOid(projectDir: string, oid: string): string {
  const relative = relativeRecordDir(projectDir);
  if (!relative) fail("Cannot resolve the active intent record path.");
  const shown = git(
    projectDir,
    ["show", `${oid}:${relative}/inception/units-generation/unit-of-work-dependency.md`, "--"],
  );
  if (!shown.ok) fail("The fetched integration ref has no Unit dependency artifact.");
  return shown.stdout;
}

function completedUnits(state: string): Set<string> {
  const match = /^## Unit Progress\s*$/m.exec(state);
  if (!match) return new Set();
  const after = match.index + match[0].length;
  const next = /^## /m.exec(state.slice(after));
  const section = state.slice(after, next ? after + next.index : state.length);
  const table = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = table.find((cells) => cells[0]?.toLowerCase() === "unit");
  if (!header) return new Set();
  const mergedIndex = header.findIndex(
    (cell) => cell.toLowerCase() === "merged",
  );
  const gateIndex = header.findIndex((cell) => cell.toLowerCase() === "gate");
  const done = new Set<string>();
  for (const cells of table) {
    if (cells.length !== header.length || cells.length < 4) continue;
    if (
      (cells[0].toLowerCase() === "unit" &&
        cells[1].toLowerCase() === "owner") ||
      cells.every((cell) => /^-+$/.test(cell))
    ) {
      continue;
    }
    const workCells = cells.slice(
      2,
      mergedIndex >= 0 ? mergedIndex : undefined,
    );
    // A stage skipped for the Unit ([S], as a claim's --skip-stages folds it)
    // is settled; its gate and merged cells still have to be [x].
    if (
      workCells.every((cell, offset) =>
        cell === "[x]" || (cell === "[S]" && offset + 2 !== gateIndex)
      ) &&
      (mergedIndex < 0 || cells[mergedIndex] === "[x]")
    ) {
      done.add(cells[0]);
    }
  }
  return done;
}

type OpeningStatus = {
  units: string[];
  blockers: Map<string, string[]>;
  completed: Set<string>;
  skeleton: string;
};

function openingStatus(projectDir: string, baseOid: string): OpeningStatus {
  return openingStatusFrom(
    stateAtOid(projectDir, baseOid),
    dependencyBodyAtOid(projectDir, baseOid),
  );
}

function localOpeningStatus(projectDir: string): OpeningStatus {
  const state = readStateFile(projectDir);
  const dependencyBody = readFileSync(unitDependencyPath(projectDir), "utf-8");
  return openingStatusFrom(state, dependencyBody);
}

// The one opening rule for the claim, status, release, the picker and the
// board. The walking skeleton is the first DAG Unit, built on main; while it is
// on, every Unit waits until its Unit Progress row is complete, the same
// evidence a dependency is read from.
function openingStatusFrom(state: string, dependencyBody: string): OpeningStatus {
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  const parsed = parseBoltDag(dependencyBody);
  if (!parsed.ok) fail(`Cannot resolve Unit dependencies: ${parsed.reason}: ${parsed.detail}`);
  const completed = completedUnits(state);
  const skeleton = parsed.batches[0][0];
  const skeletonBlocked = teamSkeletonOn(state) && !completed.has(skeleton);
  const blockers = new Map<string, string[]>();
  for (const edge of parsed.units) {
    const waiting = edge.depends_on.filter((dep) => !completed.has(dep));
    if (skeletonBlocked) waiting.unshift("walking-skeleton");
    blockers.set(edge.name, [...new Set(waiting)]);
  }
  return { units: parsed.units.map((edge) => edge.name), blockers, completed, skeleton };
}

function allClaims(
  projectDir: string,
  remote: string | null,
  intentId8: string,
  units: string[],
): Map<string, UnitClaimView> {
  fetchClaimRefs(projectDir, remote);
  const claims = new Map<string, UnitClaimView>();
  for (const unit of units) {
    const ref = claimRef(intentId8, unit);
    const claim = currentClaim(projectDir, remote, ref);
    if (claim) claims.set(unit, claim);
  }
  return claims;
}

function buildOverview(
  opening: ReturnType<typeof openingStatus>,
  claims: Map<string, UnitClaimView>,
  warning?: string,
): UnitClaimOverview {
  const claimable: string[] = [];
  const claimed: Array<{ unit: string; owner: string; generation: number }> = [];
  const waiting: Array<{ unit: string; blockedBy: string[] }> = [];
  for (const unit of opening.units) {
    if (opening.completed.has(unit)) continue;
    const claim = claims.get(unit);
    if (claim?.status === "claimed") {
      claimed.push({ unit, owner: claim.owner, generation: claim.generation });
      continue;
    }
    const blockedBy = opening.blockers.get(unit) ?? [];
    if (blockedBy.length > 0) waiting.push({ unit, blockedBy });
    else claimable.push(unit);
  }
  return { claimable, claimed, waiting, claims, ...(warning ? { warning } : {}) };
}

function cacheClaims(
  projectDir: string,
  claims: Map<string, UnitClaimView>,
  warning?: string,
): Map<string, UnitClaimView> {
  const identity = activeIdentity(projectDir);
  const priorCache = readUnitClaimRegistryCache(projectDir);
  const cached: Record<string, CachedUnitClaim> = {};
  for (const [unit, claim] of claims) {
    const prior =
      priorCache?.space === identity.space &&
        priorCache.intent_uuid === identity.intentUuid
        ? priorCache.claims[unit]
        : undefined;
    const movementObserved =
      prior !== undefined && prior.oid !== claim.oid;
    const observedAt = prior?.observed_at ?? isoTimestamp();
    const nextObservedAt = movementObserved ? isoTimestamp() : observedAt;
    claim.observedAt = observedAt;
    claim.movementObserved = movementObserved;
    cached[unit] = {
      status: claim.status,
      owner: claim.owner,
      generation: claim.generation,
      nonce: claim.nonce,
      ref: claim.ref,
      oid: claim.oid,
      observed_at: nextObservedAt,
    };
    if (claim.status === "claimed") {
      writeClaimGeneration(projectDir, unit, claim.generation);
    } else {
      clearClaimGeneration(projectDir, unit);
    }
  }
  writeUnitClaimRegistryCache(projectDir, {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    claims: cached,
    ...(warning ? { warning } : {}),
  });
  return claims;
}

interface UnitClaimIdentity {
  space: string;
  intentUuid: string;
  intentId8: string;
}

function cachedClaimsForIdentity(
  projectDir: string,
  identity: UnitClaimIdentity,
  includeCache: boolean,
): Map<string, UnitClaimView> {
  const cache = readUnitClaimRegistryCache(projectDir);
  const claims = new Map<string, UnitClaimView>();
  if (
    includeCache &&
    cache &&
    cache.space === identity.space &&
    cache.intent_uuid === identity.intentUuid
  ) {
    for (const [unit, claim] of Object.entries(cache.claims)) {
      claims.set(unit, {
        unit,
        status: claim.status,
        owner: claim.owner,
        generation: claim.generation,
        nonce: claim.nonce,
        oid: claim.oid,
        ref: claim.ref,
        observedAt: claim.observed_at,
        movementObserved: false,
        payload: {
          version: 1,
          status: claim.status,
          owner: claim.owner,
          space: identity.space,
          intent_uuid: identity.intentUuid,
          intent_id8: identity.intentId8,
          unit,
          generation: claim.generation,
          nonce: claim.nonce,
          base_oid: "",
          integration_ref: "",
          claim_ref: claim.ref,
          predecessor_oid: null,
          gate_rhythm: "per-stage",
        },
      });
    }
  }
  const refs = localGit(projectDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads/claim/",
    "refs/remotes/",
  ]);
  if (!refs.ok) return claims;
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (!oid || !ref) continue;
    if (
      !ref.startsWith(`refs/heads/claim/${identity.intentId8}/`) &&
      !new RegExp(
        `^refs/remotes/[^/]+/claim/${identity.intentId8.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
      ).test(ref)
    ) {
      continue;
    }
    const payload = readPayload(projectDir, oid, { localOnly: true });
    if (!payload || payload.intent_uuid !== identity.intentUuid) {
      throw new Error(
        `Local Unit claim registry payload is unavailable or invalid at ${ref}; ` +
          "fetch that claim ref without a partial-clone filter before retrying.",
      );
    }
    const prior = claims.get(payload.unit);
    if (
      prior &&
      (prior.generation > payload.generation ||
        (prior.generation === payload.generation &&
          (
            prior.oid === oid ||
            (prior.status === "claimed" && payload.status === "released")
          )))
    ) {
      continue;
    }
    claims.set(payload.unit, {
      unit: payload.unit,
      status: payload.status,
      owner: payload.owner,
      generation: payload.generation,
      nonce: payload.nonce,
      oid,
      ref: payload.claim_ref,
      observedAt:
        cache?.space === identity.space &&
          cache.intent_uuid === identity.intentUuid
          ? cache.claims[payload.unit]?.observed_at
          : undefined,
      movementObserved:
        cache?.space === identity.space &&
          cache.intent_uuid === identity.intentUuid &&
          cache.claims[payload.unit] !== undefined &&
          cache.claims[payload.unit]?.oid !== oid,
      payload,
    });
  }
  return claims;
}

function cachedClaims(projectDir: string): Map<string, UnitClaimView> {
  return cachedClaimsForIdentity(projectDir, activeIdentity(projectDir), true);
}

export function cachedUnitClaimOverview(
  projectDir: string,
  options: { writeCache?: boolean } = {},
): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const opening = localOpeningStatus(pd);
  const cache = readUnitClaimRegistryCache(pd);
  let claims = cachedClaims(pd);
  if (options.writeCache !== false && !isReadOnlyEngineProbe()) {
    claims = cacheClaims(pd, claims, cache?.warning);
  }
  return buildOverview(opening, claims, cache?.warning);
}

export function localUnitClaimOverviewForIntent(
  projectDir: string,
  selector: {
    space: string;
    intentUuid: string;
    stateContent: string;
    dependencyBody: string;
  },
): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  if (!isTeamUnitOwnership(selector.stateContent)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const opening = openingStatusFrom(
    selector.stateContent,
    selector.dependencyBody,
  );
  const claims = cachedClaimsForIdentity(
    pd,
    {
      space: selector.space,
      intentUuid: selector.intentUuid,
      intentId8: idSuffix(selector.intentUuid),
    },
    true,
  );
  return buildOverview(opening, claims);
}

export function unitClaimOverview(projectDir: string): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const opening = openingStatus(pd, integration.oid);
  const claims = allClaims(pd, integration.remote, identity.intentId8, opening.units);
  const observedClaims = cacheClaims(pd, claims);
  return buildOverview(opening, observedClaims);
}

function updateCachedClaim(
  projectDir: string,
  claim: UnitClaimView,
): void {
  const claims = cachedClaims(projectDir);
  claims.set(claim.unit, claim);
  cacheClaims(projectDir, claims);
}

function gitOutput(projectDir: string, args: string[], label: string): string {
  const result = git(projectDir, args);
  if (!result.ok) {
    fail(`${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

function gitPathExistsAt(
  projectDir: string,
  oid: string,
  path: string,
): boolean {
  return git(projectDir, ["cat-file", "-e", `${oid}:${path}`]).ok;
}

export function gitTextAt(
  projectDir: string,
  oid: string,
  path: string,
): string {
  // `cat-file` takes oid:path as an object name only, never a worktree path,
  // so Git does not stat it (which could exceed Windows' path limit). The
  // blob's recorded size is checked against the bytes read: a short read
  // never stands in for the file.
  const object = `${oid}:${path}`;
  const size = git(projectDir, ["cat-file", "-s", object]);
  if (!size.ok) fail(`Pinned candidate is missing ${path}.`);
  const expected = Number(size.stdout.trim());
  const shown = gitBytes(projectDir, ["cat-file", "blob", object]);
  if (!shown.ok || shown.stdout.length !== expected) {
    fail(
      `Could not read all of ${path} from the pinned candidate: ` +
        `${shown.stdout.length} of ${expected} bytes${shown.ok ? "" : ` (${shown.stderr.trim()})`}.`,
    );
  }
  return shown.stdout.toString("utf-8");
}

type CandidateAuditEvent = AuditShardEvent;

function candidateAuditEvents(
  projectDir: string,
  oid: string,
  shards: string[],
): CandidateAuditEvent[] {
  const events = shards.flatMap((path, shardIndex) =>
    auditShardBlocks(gitTextAt(projectDir, oid, path))
      .filter((block) => block.trim().length > 0)
      .map((block, pos): CandidateAuditEvent | null => {
        const event = auditBlockField(block, "Event");
        if (!event) return null;
        return {
          event,
          block,
          timestamp: auditBlockField(block, "Timestamp") ?? "",
          shard: path,
          shardIndex,
          pos,
        };
      })
      .filter((event): event is CandidateAuditEvent => event !== null)
  );
  return events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

function auditBlockMatchesStage(block: string, stage: string): boolean {
  const gateStages = auditBlockField(block, "Gate Stages");
  if (gateStages) {
    return gateStages
      .split(",")
      .map((value) => value.trim())
      .includes(stage);
  }
  return auditBlockField(block, "Stage") === stage;
}

function attemptEventMatches(
  event: CandidateAuditEvent,
  unit: string,
  generation: number,
  stage: string,
): boolean {
  return (
    auditBlockField(event.block, "Unit") === unit &&
    auditBlockField(event.block, "Attempt Generation") ===
      String(generation) &&
    auditBlockMatchesStage(event.block, stage)
  );
}

function candidateReviewFingerprint(
  projectDir: string,
  oid: string,
  recordPrefix: string,
  unit: string,
  stage: {
    slug: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  unitKind: string | null,
): string {
  const names = filterProducesByKind(
    stage.produces_kinds,
    [...(stage.produces ?? []), ...(stage.optional_produces ?? [])],
    unitKind,
  );
  const manifest: Array<[string, string]> = names.map((name) => {
    const logicalPath =
      `construction/${unit}/${stage.slug}/${artifactFilename(name)}`;
    const path = `${recordPrefix}/${logicalPath}`;
    if (!gitPathExistsAt(projectDir, oid, path)) {
      return [logicalPath, "missing"];
    }
    // CRLF text reads as LF, as the review's fingerprint read it.
    const digest = createHash("sha256")
      .update(committedTextBytes(Buffer.from(gitTextAt(projectDir, oid, path), "utf-8")))
      .digest("hex");
    return [logicalPath, `sha256:${digest}`];
  });
  manifest.sort(([a], [b]) => a.localeCompare(b));
  return `sha256:${
    createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
  }`;
}

function candidateReviewerReady(
  events: CandidateAuditEvent[],
  projectDir: string,
  oid: string,
  recordPrefix: string,
  unit: string,
  generation: number,
  stage: {
    slug: string;
    reviewer?: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  unitKind: string | null,
): boolean {
  const expectedFingerprint = candidateReviewFingerprint(
    projectDir,
    oid,
    recordPrefix,
    unit,
    stage,
    unitKind,
  );
  const completionRecord = (block: string): ReviewRecord | null =>
    pairedReviewRecordForCompletion(projectDir, block, (_projectDir, ref) => {
      const path = `${recordPrefix}/${ref.path}`;
      if (!gitPathExistsAt(projectDir, oid, path)) return null;
      const bytes = gitTextAt(projectDir, oid, path);
      if (reviewRecordDigest(bytes) !== ref.digest) return null;
      return parseReviewRecordBytes(bytes);
    });
  const artifactPrefix = `construction/${unit}/${stage.slug}/`;
  return candidateReviewCoverageProjection(events, {
    unit,
    generation,
    stage: stage.slug,
    reviewer: stage.reviewer,
    artifactPrefix,
    expectedFingerprint,
    completionRecord,
  });
}

function mainUnitRowMerged(
  projectDir: string,
  transaction: UnitMergeTransaction,
): boolean {
  const state = readStateFile(projectDir);
  const heading = /^## Unit Progress\s*$/m.exec(state);
  if (!heading) return false;
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(state.slice(after));
  const rows = state
    .slice(after, next ? after + next.index : state.length)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells[0]?.toLowerCase() === "unit");
  const row = rows.find((cells) => cells[0] === transaction.unit);
  if (!header || !row || row.length !== header.length) return false;
  const expected = [
    "owner",
    ...(transaction.live_stage_columns ?? transaction.evidence.stages_expected),
    "gate",
    "merged",
  ];
  // A step skipped for the Unit is folded as skipped, not as done.
  const skipped = new Set(transaction.evidence.stages_skipped ?? []);
  return expected.every((name) => {
    const index = header.findIndex((cell) => cell.toLowerCase() === name);
    if (index < 0) return false;
    if (name === "owner") return row[index] === transaction.owner;
    return row[index] === "[x]" || (skipped.has(name) && row[index] === "[S]");
  });
}

interface CandidateBoundary {
  changedAudit: string[];
  outsideUnitRecordPaths: string[];
  violations: string[];
}

const TRANSPORTED_ATTEMPT_EVENTS = new Set([
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  "UNIT_SKIPPED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "PLAN_APPROVAL_RECORDED",
  "PLAN_APPROVAL_SKIPPED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
]);
const TRANSPORTED_DATA_EVENTS = new Set([
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
]);

function isTransportedMainAuthority(event: CandidateAuditEvent): boolean {
  // A Unit's own merge gate is main-authority evidence wherever it was
  // written: under strategy pr it is written in the Unit's own checkout, so
  // publish withholds it and pin refuses it like a dispatch row.
  if (
    (event.event === "GATE_APPROVED" || event.event === "GATE_REJECTED") &&
    auditBlockField(event.block, "Gate Scope") === "unit-merge"
  ) {
    return true;
  }
  if (
    event.event === "HUMAN_TURN" ||
    event.event === "QUESTION_ANSWERED" ||
    event.event === "SUMMARY_CONFIRMATION_RECORDED" ||
    event.event === "AUTONOMY_MODE_SET" ||
    event.event === "UNIT_MERGED" ||
    event.event.startsWith("MERGE_DISPATCH_")
  ) {
    return true;
  }
  return (
    (event.event === "GATE_APPROVED" || event.event === "GATE_REJECTED") &&
    (
      auditBlockField(event.block, "Stage") === "unit-merge" ||
      auditBlockField(event.block, "Gate Scope") === "unit-merge"
    )
  );
}

function transportedAuditViolation(
  event: CandidateAuditEvent,
  unit: string,
  generation: number,
): string | null {
  if (isTransportedMainAuthority(event)) {
    return `${event.event} is main-authority evidence`;
  }
  if (TRANSPORTED_ATTEMPT_EVENTS.has(event.event)) {
    const eventUnit = auditBlockField(event.block, "Unit");
    const eventGeneration = auditBlockField(
      event.block,
      "Attempt Generation",
    );
    if (eventUnit !== unit) {
      return `${event.event} receipt belongs to Unit ${eventUnit ?? "(unitless)"}`;
    }
    // A Unit's row with no attempt generation was written before rows carried
    // one (a `jump reopen` row did not): on the Unit's first claim it can only
    // be that claim's. Later receipts were stamped with run floors that count
    // it, so leaving it behind would put every one of them off its floor.
    if (eventGeneration === null && generation === 1) return null;
    if (eventGeneration !== String(generation)) {
      return (
        `${event.event} receipt belongs to attempt generation ` +
        `${eventGeneration ?? "(missing)"}, expected ${generation}`
      );
    }
    return null;
  }
  if (TRANSPORTED_DATA_EVENTS.has(event.event)) {
    const eventUnit = auditBlockField(event.block, "Unit");
    const eventGeneration = auditBlockField(
      event.block,
      "Attempt Generation",
    );
    if (eventUnit !== null && eventUnit !== unit) {
      return `${event.event} row belongs to Unit ${eventUnit}`;
    }
    if (
      eventGeneration !== null &&
      eventGeneration !== String(generation)
    ) {
      return `${event.event} row belongs to attempt generation ${eventGeneration}`;
    }
    const file = (auditBlockField(event.block, "File") ?? "")
      .replace(/\\/g, "/");
    const unitArtifactRoot = `construction/${unit}/`;
    if (
      !file.startsWith(unitArtifactRoot) &&
      !file.includes(`/${unitArtifactRoot}`)
    ) {
      return `${event.event} row is outside claimed Unit artifacts`;
    }
    return null;
  }
  return `${event.event} is not in the transported Unit evidence allowlist`;
}

// Mirrors appendAuditBlockAtPath's on-disk shape: a one-line preamble (only
// ever written once, fused with the first block since no `\n---\n` separates
// them), then every block as `\n---\n`-joined `renderAuditBlock` output.
const AUDIT_SHARD_HEADER = "# AI-DLC Audit Log\n";

// A claimed checkout's own shard carries far more than the Unit's attempt
// receipts, because appendAuditEntry has no notion of a claimed checkout:
// session lifecycle, a typed prompt, an answered question box, sensors,
// subagent tracking, doctor and guard refusals all land in the SAME shard.
// Publish ships exactly the evidence pin accepts, so a real session's shard
// publishes clean.
//
// transportedAuditViolation is the ONE owner of what transports: this projects
// the shard onto that same predicate rather than restating it as a second
// list, so no event type can be ordinary in a session yet fatal at pin (of 118
// valid event types only a handful are transportable, and a list here would
// silently block every type absent from both). Parsed exactly as
// candidateAuditEvents parses it - CRLF normalised, blank blocks skipped - so
// publish and pin can never disagree about a block.
//
// PROVISIONAL. This compensates at publish for a conflation at write time, and
// for an authority model that is not expressed: a transported shard's rows are
// refused by type because nothing records whose shard a row came from. When
// authority is scoped by provenance, pin can select its evidence instead of
// refusing a whole file, and this projection should be DELETED rather than
// kept alongside it.
//
// Returns null when nothing is dropped, so an untouched shard keeps its own
// bytes (a CRLF candidate is not rewritten to LF for no reason).
function transportableAuditShardText(
  content: string,
  unit: string,
  generation: number,
): { text: string; withheld: number } | null {
  // auditShardBlocks is the grammar the candidate walk splits with, so these
  // are the same blocks, with the same bytes, in the same order pin reads.
  const blocks = auditShardBlocks(content);
  const keep = blocks.map((block, pos) => {
    // The candidate walk drops both before it evaluates anything, so neither
    // is ever a violation; the trailing blank block carries the last separator.
    if (block.trim().length === 0) return true;
    const event = auditBlockField(block, "Event");
    if (!event) return true;
    return transportedAuditViolation(
      {
        event,
        block,
        timestamp: auditBlockField(block, "Timestamp") ?? "",
        shard: "",
        shardIndex: 0,
        pos,
      },
      unit,
      generation,
    ) === null;
  });
  const withheld = keep.filter((kept) => !kept).length;
  if (withheld === 0) return null;
  const kept = blocks.filter((_, pos) => keep[pos]).join("\n---\n");
  // The shard's one-line header is written once, with no separator after it,
  // so it rides inside the first block rather than standing on its own. It
  // survives that block being withheld: each rendered block opens with its
  // own newline, so prepending the header reproduces the on-disk shape.
  const headerWithheld = blocks.length > 0 && !keep[0] &&
    blocks[0].startsWith(AUDIT_SHARD_HEADER);
  return {
    text: headerWithheld ? AUDIT_SHARD_HEADER + kept : kept,
    withheld,
  };
}

// Projects the claim-bound audit shard inside `treeOid` onto the transportable
// evidence, returning a tree equal to `treeOid` except for that one blob. The
// clone's own history and working copy keep the whole shard; only the tree
// about to be published is projected.
function transportableCandidateTree(
  projectDir: string,
  treeOid: string,
  recordPrefix: string,
  auditShard: string,
  unit: string,
  generation: number,
): { tree: string; withheld: number } {
  const shardPath = `${recordPrefix}/audit/${auditShard}`;
  if (!gitPathExistsAt(projectDir, treeOid, shardPath)) {
    return { tree: treeOid, withheld: 0 };
  }
  const content = gitTextAt(projectDir, treeOid, shardPath);
  const projected = transportableAuditShardText(content, unit, generation);
  if (!projected) return { tree: treeOid, withheld: 0 };
  return {
    tree: writeTreeWithBlob(projectDir, treeOid, shardPath, projected.text),
    withheld: projected.withheld,
  };
}

// A Unit's own review record: `<record>/.aidlc-engine/reviews/<stage>/units/<unit>/<attempt>/<file>`,
// the one record path pin's ownership boundary lets a candidate carry.
function isUnitReviewRecordPath(path: string, recordPrefix: string, unit: string): boolean {
  const root = `${recordPrefix}/${REVIEW_RECORDS_DIR}/`;
  if (!path.startsWith(root)) return false;
  const parts = path.slice(root.length).split("/");
  return parts.length === 5 && parts[1] === "units" && parts[2] === unit && parts.every(Boolean);
}

// A review record the candidate carries for pin alone: the Unit's own, and
// ignored by the checkout's .gitignore as framework state is in every project.
// A merge landing leaves it out of the merge commit, so main never tracks it.
function isCarriedReviewRecord(
  projectDir: string,
  path: string,
  recordPrefix: string | null,
  unit: string,
): boolean {
  return recordPrefix !== null &&
    isUnitReviewRecordPath(path, recordPrefix, unit) &&
    git(projectDir, ["check-ignore", "-q", "--no-index", "--", path]).ok;
}

// The review records the candidate's transported REVIEW_COMPLETED rows name.
// They are framework state, git-ignored in every project, so the Unit's
// branch never holds them; pin reads each one from the candidate to count its
// review. Publish carries each one whose bytes still match the row's digest,
// from this checkout, the way it carries the projected shard; a record that
// is missing or changed is left out, and pin does not count that review.
function unitReviewRecordEntries(
  projectDir: string,
  treeOid: string,
  recordPrefix: string,
  auditShard: string,
  unit: string,
  generation: number,
): Array<{ path: string; content: string }> {
  const shardPath = `${recordPrefix}/audit/${auditShard}`;
  if (!gitPathExistsAt(projectDir, treeOid, shardPath)) return [];
  const entries = new Map<string, string>();
  for (const block of auditShardBlocks(gitTextAt(projectDir, treeOid, shardPath))) {
    if (auditBlockField(block, "Event") !== "REVIEW_COMPLETED") continue;
    const event: CandidateAuditEvent = {
      event: "REVIEW_COMPLETED", block, timestamp: auditBlockField(block, "Timestamp") ?? "",
      shard: shardPath, shardIndex: 0, pos: 0,
    };
    if (transportedAuditViolation(event, unit, generation) !== null) continue;
    const ref = auditBlockField(block, "Review Record");
    const digest = auditBlockField(block, "Review Record Digest");
    if (!ref || !digest) continue;
    const path = `${recordPrefix}/${ref}`;
    if (!isUnitReviewRecordPath(path, recordPrefix, unit) || entries.has(path)) continue;
    let bytes: string;
    try {
      bytes = readFileSync(join(projectDir, path), "utf-8");
    } catch {
      continue;
    }
    if (reviewRecordDigest(bytes) === digest) entries.set(path, bytes);
  }
  return [...entries].map(([path, content]) => ({ path, content }));
}

// The team shard a Unit's rows travel in. A clone that ran the earlier phases
// already has its own shard on main, and a candidate may add only a new shard,
// never change one main holds: claimed from such a clone, the Unit's rows go
// in a shard named for the Unit's attempt instead.
function teamAuditShard(
  projectDir: string,
  baseOid: string,
  recordPrefix: string,
  shard: string,
  unit: string,
  generation: number,
): string {
  if (!gitPathExistsAt(projectDir, baseOid, `${recordPrefix}/audit/${shard}`)) return shard;
  return `${shard.replace(/\.md$/, "")}-${unit}-g${generation}.md`;
}

// A Unit claimed before its rows had a team shard of their own wrote them into
// the clone's shard, which main already holds. One commit on the Unit's branch
// moves them: the clone's shard goes back to main's bytes, and the rows after
// them (shards are append-only) open the team shard. The branch then lands the
// way a Unit claimed in a fresh clone does. Done once; a branch that already
// holds the split is left as it is.
function splitTeamAuditShard(
  projectDir: string,
  recordPrefix: string,
  baseOid: string,
  cloneShard: string,
  teamShard: string,
  unit: string,
): boolean {
  const clonePath = `${recordPrefix}/audit/${cloneShard}`;
  const teamPath = `${recordPrefix}/audit/${teamShard}`;
  return withAuditLock(projectDir, () => {
    const base = gitTextAt(projectDir, baseOid, clonePath);
    const head = gitPathExistsAt(projectDir, "HEAD", clonePath) ? gitTextAt(projectDir, "HEAD", clonePath) : base;
    if (head === base) return false;
    if (!head.startsWith(base)) {
      fail(
        `Unit "${unit}" cannot move its audit rows out of ${clonePath}: on this branch the shard does not begin ` +
          "with the rows main holds. Bring main into the branch, then publish again.",
      );
    }
    if (gitPathExistsAt(projectDir, "HEAD", teamPath)) {
      fail(`Unit "${unit}" cannot move its audit rows: ${teamPath} already exists on this branch.`);
    }
    const restored = git(projectDir, ["checkout", baseOid, "--", clonePath]);
    if (!restored.ok) fail(`Cannot restore ${clonePath}: ${restored.stderr.trim()}`);
    writeFileSync(join(projectDir, teamPath), AUDIT_SHARD_HEADER + head.slice(base.length), "utf-8");
    const added = git(projectDir, ["add", "--", teamPath]);
    if (!added.ok) fail(`Cannot stage ${teamPath}: ${added.stderr.trim()}`);
    const committed = git(projectDir, [
      "commit", "-q", "-m", `Unit ${unit}: its audit rows move to its team shard ${teamShard}`,
      "-m", `${cloneShard} is already on main, and a published Unit may only add a shard of its own. ` +
        `The rows this branch appended to it now open ${teamShard}; ${cloneShard} is as main has it.`,
      "--", clonePath, teamPath,
    ]);
    if (!committed.ok) fail(`Cannot commit the audit shard split: ${gitFailure(committed)}`);
    return true;
  });
}

const OUTSIDE_UNIT_RECORD_TREE = "outside claimed Unit record tree";

// What to do about a record the Unit changed outside its own tree, said with the
// refusal: a claimed Unit lands only `construction/<unit>/` and its own audit
// shard, so a shared record is changed on main.
function ownershipAdvice(unit: string, violations: string[]): string {
  if (!violations.some((violation) => violation.endsWith(`(${OUTSIDE_UNIT_RECORD_TREE})`))) return "";
  return ` A claimed Unit lands only construction/${unit}/ and its own audit shard. ` +
    "A shared record (an Inception artifact such as contract-summary.md, or a stage-level " +
    "file under construction/<stage>/) is changed on main, not in the Unit's checkout: take " +
    "it out of the Unit's branch (git rm a file main does not have, or git checkout <base> -- " +
    "<path> for one it does), commit, and publish again.";
}

function candidateBoundary(
  projectDir: string,
  baseOid: string,
  candidateOid: string,
  recordPrefix: string,
  unit: string,
  generation: number,
  expectedAuditShard?: string,
): CandidateBoundary {
  const auditRoot = `${recordPrefix}/audit`;
  const auditChanges = gitOutput(
    projectDir,
    [
      "diff",
      "--no-renames",
      "--name-status",
      `${baseOid}..${candidateOid}`,
      "--",
      auditRoot,
    ],
    "Cannot compare candidate audit shards",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const addedAudit = auditChanges
    .filter((line) => line.startsWith("A\t"))
    .map((line) => line.split("\t").at(-1) ?? "")
    .filter(Boolean);
  const changedAudit = addedAudit.filter((path) =>
    isActiveIntentAuditPath(path, recordPrefix)
  );
  const violations = auditChanges
    .filter((line) => !line.startsWith("A\t"))
    .map((line) => `${line.split("\t").at(-1) ?? line} (inherited audit shard)`);
  for (const path of addedAudit.filter((path) =>
    !isActiveIntentAuditPath(path, recordPrefix)
  )) {
    violations.push(`${path} (invalid active-intent audit shard path)`);
  }
  if (changedAudit.length !== 1) {
    violations.push(
      `${auditRoot}/ (expected exactly one newly added team audit shard; found ${changedAudit.length})`,
    );
  }
  if (
    expectedAuditShard &&
    (
      changedAudit.length !== 1 ||
      changedAudit[0] !== `${auditRoot}/${expectedAuditShard}`
    )
  ) {
    violations.push(
      `${auditRoot}/ (expected claim-bound audit shard ${expectedAuditShard})`,
    );
  }

  const changedPaths = gitOutput(
    projectDir,
    ["diff", "--no-renames", "--name-only", `${baseOid}..${candidateOid}`],
    "Cannot inspect pinned candidate diff",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const unitRoot = `${recordPrefix}/construction/${unit}/`;
  const constructionRoot = `${recordPrefix}/construction/`;
  const reviewUnitMarker = `/${REVIEW_RECORDS_DIR}/`;
  const unitRootKey = unitRoot.toLowerCase();
  const constructionRootKey = constructionRoot.toLowerCase();
  const recordPrefixKey = `${recordPrefix}/`.toLowerCase();
  const outsideUnitRecordPaths: string[] = [];
  for (const path of changedPaths) {
    if (isEngineMergeMetadata(projectDir, path, recordPrefix)) continue;
    const pathKey = path.toLowerCase();
    const reviewMarkerIndex = path.indexOf(reviewUnitMarker);
    if (reviewMarkerIndex !== -1) {
      const reviewParts = path.slice(reviewMarkerIndex + reviewUnitMarker.length).split("/");
      if (
        reviewParts.length === 5 &&
        reviewParts[1] === "units" &&
        reviewParts[2] === unit
      ) continue;
    }
    if (pathKey.startsWith(unitRootKey)) continue;
    if (changedAudit.includes(path)) continue;
    if (
      pathKey.startsWith(constructionRootKey) ||
      pathKey.startsWith(recordPrefixKey) ||
      pathKey.startsWith("aidlc/")
    ) {
      violations.push(`${path} (${OUTSIDE_UNIT_RECORD_TREE})`);
      continue;
    }
    outsideUnitRecordPaths.push(path);
  }

  for (const event of candidateAuditEvents(
    projectDir,
    candidateOid,
    changedAudit,
  )) {
    const violation = transportedAuditViolation(event, unit, generation);
    if (violation) {
      violations.push(
        `${event.shard} (${violation})`,
      );
    }
  }

  return {
    changedAudit: [...new Set(changedAudit)].sort(),
    outsideUnitRecordPaths: [...new Set(outsideUnitRecordPaths)].sort(),
    violations: [...new Set(violations)].sort(),
  };
}

function candidateEvidence(
  projectDir: string,
  claim: UnitClaimView,
  candidateBaseOid: string,
  liveIntegrationOid = candidateBaseOid,
): UnitMergeEvidence {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) fail("Cannot resolve the active intent record for candidate evidence.");
  const statePath = `${recordPrefix}/aidlc-state.md`;
  const state = gitTextAt(projectDir, claim.oid, statePath);
  if (!isTeamUnitOwnership(state)) {
    fail("Pinned candidate state does not record Unit Ownership: team.");
  }
  const integrationState = stateAtOid(projectDir, liveIntegrationOid);
  if (!isTeamUnitOwnership(integrationState)) {
    fail("Pinned integration state does not record Unit Ownership: team.");
  }
  const scope = getField(integrationState, "Scope") ?? "";
  const stages = unitMajorConstructionStageSlugs(
    scope,
    integrationState,
    true,
  );
  if (stages.length === 0) fail("Pinned candidate has no active per-unit Construction stages.");
  // The Unit's row is derived from the candidate's receipts below, as the board
  // and the fold derive it; the candidate's copy of aidlc-state.md is engine
  // metadata a land discards, so it is not read.
  const graph = loadStageGraphAll();
  const baseState = stateAtOid(projectDir, candidateBaseOid);
  const baseStages = unitMajorConstructionStageSlugs(
    getField(baseState, "Scope") ?? "",
    baseState,
    true,
  );
  const baseDag = parseBoltDag(dependencyBodyAtOid(projectDir, candidateBaseOid));
  const dag = parseBoltDag(dependencyBodyAtOid(projectDir, liveIntegrationOid));
  if (!baseDag.ok) {
    fail(`Pinned candidate base Unit DAG is ${baseDag.reason}: ${baseDag.detail}.`);
  }
  if (!dag.ok) {
    fail(`Pinned integration Unit DAG is ${dag.reason}: ${dag.detail}.`);
  }
  const contract = (
    units: typeof dag.units,
    stageColumns: string[],
  ): string => JSON.stringify({
    stage_columns: stageColumns,
    units: units.map((entry) => ({
      name: entry.name,
      kind: entry.kind ?? null,
      depends_on: [...entry.depends_on].sort(),
    })),
  });
  if (contract(baseDag.units, baseStages) !== contract(dag.units, stages)) {
    fail(
      `Unit "${claim.unit}" candidate is based on a stale Construction contract; ` +
        "rebase onto the current integration branch and publish again.",
    );
  }
  const unit = dag.units.find((entry) => entry.name === claim.unit);
  if (!unit) fail(`Pinned integration Unit DAG has no Unit "${claim.unit}".`);
  const unitKind = unit.kind ?? null;
  const forcedMergeJournals = gitOutput(
    projectDir,
    [
      "diff",
      "--name-only",
      `${candidateBaseOid}..${claim.oid}`,
      "--",
      `aidlc/${UNIT_MERGE_DIR}`,
    ],
    "Cannot inspect candidate merge journals",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (forcedMergeJournals.length > 0) {
    fail(
      `Pinned candidate contains engine merge journals: ${forcedMergeJournals.join(", ")}.`,
    );
  }
  const boundary = candidateBoundary(
    projectDir,
    candidateBaseOid,
    claim.oid,
    recordPrefix,
    claim.unit,
    claim.generation,
    claim.payload.audit_shard,
  );
  if (!claim.payload.audit_shard) {
    fail(
      `Pinned candidate claim has no bound audit shard; release and re-claim Unit "${claim.unit}" before publishing again.`,
    );
  }
  if (boundary.violations.length > 0) {
    fail(
      `Pinned candidate violates claimed Unit ownership at: ${
        boundary.violations.join(", ")
      }.${ownershipAdvice(claim.unit, boundary.violations)}`,
    );
  }
  const changedAudit = boundary.changedAudit;
  const transportedEvents = candidateAuditEvents(
    projectDir,
    claim.oid,
    changedAudit,
  );
  const authorityRows = transportedEvents.filter((event) =>
    TRANSPORTED_ATTEMPT_EVENTS.has(event.event) ||
    TRANSPORTED_DATA_EVENTS.has(event.event)
  );
  const events = authorityRows;
  // A stage whose documents all belong to other kinds of Unit applies to this
  // one no more than it does to the walk: it settles with no directive, so it
  // earns no receipt, review or gate.
  const notApplicable = new Set(stages.filter((slug) => {
    const stage = graph.find((entry) => entry.slug === slug);
    return (stage?.produces ?? []).length > 0 &&
      filterProducesByKind(stage?.produces_kinds, stage?.produces ?? [], unitKind).length === 0;
  }));
  // The clone stamped each receipt with the run floor it read from the whole
  // audit record (the workflow's own rows plus its own). Read the candidate's
  // receipts against the same floor: this checkout's rows that are not Unit
  // attempt rows, with the transported rows on top. Transported rows alone
  // hold no WORKFLOW_STARTED, so every real receipt would miss the floor.
  const floorRows = orderedAuditRows(projectDir).filter((row) =>
    !TRANSPORTED_ATTEMPT_EVENTS.has(row.event) &&
    !TRANSPORTED_DATA_EVENTS.has(row.event)
  );
  const snapshotRows = [...floorRows, ...authorityRows];
  const snapshots = new Map(stages.map((stage) => [
    stage,
    unitLifecycleSnapshot(
      projectDir,
      stage,
      snapshotRows,
      integrationState,
      {
        artifactFingerprint: (stageNode, unitName) =>
          candidateReviewFingerprint(
            projectDir,
            claim.oid,
            recordPrefix,
            unitName,
            stageNode,
            unitKind,
          ),
      },
    ),
  ]));
  // A step skipped for this Unit in this attempt is settled by its
  // UNIT_SKIPPED receipt: it has no documents, review or gate of its own. The
  // Unit's own approval at the end of its walk still counts under unit-end.
  const skipped = new Set(stages.filter((stage) => snapshots.get(stage)?.skipped.has(claim.unit)));
  // Settled with no work of its own: skipped for this Unit, or one its kind
  // owes nothing (which cannot be skipped either).
  const settledWithoutWork = (stage: string): boolean => skipped.has(stage) || notApplicable.has(stage);
  const stagesCompleted = stages.filter((stage) =>
    settledWithoutWork(stage) || snapshots.get(stage)?.receipts.has(claim.unit)
  );
  const gatesExpected =
    claim.payload.gate_rhythm === "unit-end"
      ? [stages[stages.length - 1]]
      : stages.filter((stage) => !settledWithoutWork(stage));
  const gatesApproved = gatesExpected.filter((stage) =>
    unitGateStatus(
      projectDir,
      stage,
      claim.unit,
      claim.payload.gate_rhythm,
      authorityRows,
    ) === "approved"
  );
  const reviewersExpected: string[] = [];
  const reviewersReady: string[] = [];
  const artifactPaths: string[] = [];
  for (const stageSlug of stages) {
    if (settledWithoutWork(stageSlug)) continue;
    const stage = graph.find((entry) => entry.slug === stageSlug);
    if (!stage) fail(`Pinned candidate references unknown stage "${stageSlug}".`);
    const names = filterProducesByKind(
      stage.produces_kinds,
      stage.produces ?? [],
      unitKind,
    );
    for (const name of names) {
      const path = `${recordPrefix}/construction/${claim.unit}/${stageSlug}/${artifactFilename(name)}`;
      if (!gitPathExistsAt(projectDir, claim.oid, path)) {
        fail(`Pinned candidate is missing required artifact ${path}.`);
      }
      artifactPaths.push(path);
    }
    if (stage.reviewer) {
      const reviewClass = resolveReviewClass(
        stage.review_class ?? "adversarial",
        scope,
        integrationState,
      );
      if (reviewClass !== "none") {
        reviewersExpected.push(stageSlug);
        if (
          candidateReviewerReady(
            events,
            projectDir,
            claim.oid,
            recordPrefix,
            claim.unit,
            claim.generation,
            stage,
            unitKind,
          )
        ) {
          reviewersReady.push(stageSlug);
        }
      }
    }
  }
  const questionsPath =
    `${recordPrefix}/construction/${claim.unit}/code-generation/code-generation-questions.md`;
  let planFingerprint: string | null = null;
  const plansCode = stages.includes("code-generation") && !skipped.has("code-generation");
  if (plansCode) {
    const plan = gitTextAt(
      projectDir,
      claim.oid,
      `${recordPrefix}/construction/${claim.unit}/code-generation/code-generation-plan.md`,
    );
    const instructions = gitTextAt(
      projectDir,
      claim.oid,
      `${recordPrefix}/construction/${claim.unit}/code-generation/unit-test-instructions.md`,
    );
    const questions = gitTextAt(projectDir, claim.oid, questionsPath);
    const fingerprint = recordedApprovalFingerprint(questions);
    const embedded = parseTestingContract(plan);
    const currentContract = resolveTestingPosture(projectDir);
    // A plan built with plan approval off carries the engine's own record of
    // that instead of the person's approval; both bind the same content.
    const approvalEvent = events.findLast((event) =>
      (event.event === "PLAN_APPROVAL_RECORDED" || event.event === "PLAN_APPROVAL_SKIPPED") &&
      attemptEventMatches(
        event,
        claim.unit,
        claim.generation,
        "code-generation",
      )
    );
    const questionsSha256 = createHash("sha256")
      .update(questions, "utf-8")
      .digest("hex");
    const promptSha256 = createHash("sha256")
      .update(
        `${questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex");
    if (
      fingerprint &&
      instructions.trim().length > 0 &&
      embedded?.contract_sha256 === currentContract.contract_sha256 &&
      approvalEvent &&
      auditBlockField(approvalEvent.block, "Details") ===
        (approvalEvent.event === "PLAN_APPROVAL_SKIPPED" ? "Plan approval off" : "Approve Plan") &&
      // The engine's own plan question (aidlc-plan-approval-ask) stamps the
      // checkpoint as "plan-approval"; the conductor-recorded answer
      // (aidlc-log) stamps the long name. Both are the same approval.
      [PLAN_APPROVAL_CHECKPOINT, "plan-approval"].includes(
        auditBlockField(approvalEvent.block, "Checkpoint") ?? "",
      ) &&
      auditBlockField(approvalEvent.block, "Plan Target") ===
        `unit:${claim.unit}` &&
      auditBlockField(approvalEvent.block, "Intent") ===
        claim.payload.intent_uuid &&
      auditBlockField(approvalEvent.block, "Approval Fingerprint") ===
        fingerprint &&
      auditBlockField(approvalEvent.block, "Questions File") ===
        questionsPath &&
      auditBlockField(approvalEvent.block, "Questions SHA-256") ===
        questionsSha256 &&
      auditBlockField(approvalEvent.block, "Prompt SHA-256") ===
        promptSha256 &&
      (auditBlockField(approvalEvent.block, "Directive Epoch") ?? "").length >
        0 &&
      (auditBlockField(approvalEvent.block, "Run floor") ?? "").length > 0 &&
      // The approval row pins the questions file's bytes (Questions SHA-256
      // above); no label on its `[Answer]:` line is read.
      (approvalEvent.event === "PLAN_APPROVAL_SKIPPED"
        ? (auditBlockField(approvalEvent.block, "Source") ?? "").length > 0
        : (auditBlockField(approvalEvent.block, "Session") ?? "").length > 0)
    ) {
      planFingerprint = fingerprint;
    }
  }
  const mergeHeld = (getField(state, "Merge-Held") ?? "").trim() === "true";
  const evidence: UnitMergeEvidence = {
    stages_expected: stages,
    stages_completed: stagesCompleted,
    ...(skipped.size > 0 ? { stages_skipped: stages.filter((stage) => skipped.has(stage)) } : {}),
    gates_expected: gatesExpected,
    gates_approved: gatesApproved,
    reviewers_expected: reviewersExpected,
    reviewers_ready: reviewersReady,
    plan_fingerprint: planFingerprint,
    artifact_paths: artifactPaths,
    audit_shards: changedAudit,
    outside_unit_record_paths: boundary.outsideUnitRecordPaths,
    merge_held: mergeHeld,
  };
  const incomplete: string[] = [];
  if (stagesCompleted.length !== stages.length) incomplete.push("UNIT_COMPLETED receipts");
  if (gatesApproved.length !== gatesExpected.length) incomplete.push("team gate approvals");
  if (reviewersReady.length !== reviewersExpected.length) {
    const missingReviewStages = reviewersExpected.filter((stage) => !reviewersReady.includes(stage));
    incomplete.push(`reviewer READY receipts (${missingReviewStages.join(", ")})`);
  }
  if (plansCode && !planFingerprint) {
    incomplete.push("Plan Approval fingerprint");
  }
  if (changedAudit.length === 0) {
    incomplete.push("transportable audit shard");
  }
  if (incomplete.length > 0) {
    // A missing READY is usually a stale one: a reviewed file changed after it.
    const reviewAdvice = reviewersReady.length !== reviewersExpected.length
      ? " A stage's READY counts only while the files it reviewed are unchanged: in the Unit's checkout, " +
        "have the stage reviewed again, commit, publish and pin again."
      : "";
    fail(`Pinned candidate evidence is incomplete: ${incomplete.join(", ")}.${reviewAdvice}`);
  }
  return evidence;
}

function publishUnit(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit publish <unit>");
  const pd = resolveProjectDir(projectDir);
  const stamp = requireLiveClaimForTeamUnit(pd, unit);
  if (!stamp) fail("Unit publication requires a scoped team checkout.");
  const dirty = gitOutput(
    pd,
    ["status", "--porcelain", "--untracked-files=no"],
    "Cannot inspect candidate worktree",
  );
  if (dirty) fail("Unit publication requires a clean tracked worktree; commit the candidate first.");
  const remote = repositoryRemote(pd);
  const current = currentClaim(pd, remote, stamp.claim_ref);
  if (
    current?.status !== "claimed" ||
    current.nonce !== stamp.nonce ||
    current.generation !== stamp.generation
  ) {
    fail(`Unit "${unit}" claim is stale or released; publication refused.`);
  }
  const recordPrefix = relativeRecordDir(pd);
  if (!recordPrefix) fail("Cannot resolve the active intent record for publication.");
  // The shard the claim bound at claim time, which is the one pin inspects
  // (candidateEvidence fails without it). Reading it from the claim rather
  // than resolving a name here keeps one owner for the shard's identity.
  const claimShard = current.payload.audit_shard;
  if (!claimShard || !/^[A-Za-z0-9._-]+\.md$/.test(claimShard)) {
    fail(
      `Unit "${unit}" claim has no bound audit shard; release and re-claim it before publishing again.`,
    );
  }
  let headOid = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve candidate HEAD");
  const integration = fetchIntegration(pd);
  const integrationIsAncestor = localGit(
    pd,
    ["merge-base", "--is-ancestor", integration.oid, headOid],
  ).ok;
  const publicationBaseOid = integrationIsAncestor
    ? integration.oid
    : current.payload.base_oid;
  const publicationIntegrationRef = integrationIsAncestor
    ? integration.ref
    : current.payload.integration_ref;
  // A claim made before Units had a team shard of their own names the clone's
  // shard; the first publication that finds it on the base moves the Unit's
  // rows to the team shard, and the claim keeps both names from then on.
  const cloneShard = current.payload.clone_audit_shard ?? claimShard;
  const auditShard = current.payload.clone_audit_shard !== undefined
    ? claimShard
    : teamAuditShard(pd, publicationBaseOid, recordPrefix, claimShard, unit, current.generation);
  if (auditShard !== cloneShard) {
    if (splitTeamAuditShard(pd, recordPrefix, publicationBaseOid, cloneShard, auditShard, unit)) {
      headOid = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve candidate HEAD");
    }
    // Rows written from here on are the team shard's.
    if (stamp.audit_shard !== auditShard) writeUnitScopeStamp(pd, { ...stamp, audit_shard: auditShard });
  }
  const rawHeadTree = gitOutput(
    pd,
    ["rev-parse", "HEAD^{tree}"],
    "Cannot resolve candidate tree",
  );
  const projected = transportableCandidateTree(
    pd,
    rawHeadTree,
    recordPrefix,
    auditShard,
    unit,
    current.generation,
  );
  const reviewRecords = unitReviewRecordEntries(
    pd, projected.tree, recordPrefix, auditShard, unit, current.generation,
  );
  const headTree = reviewRecords.length > 0
    ? writeTreeWithEntries(pd, projected.tree, reviewRecords)
    : projected.tree;
  if (
    current.payload.candidate_tree_oid === headTree &&
    current.payload.candidate_head_oid === headOid &&
    current.payload.base_oid === publicationBaseOid &&
    current.payload.integration_ref === publicationIntegrationRef
  ) {
    const recoveredStamp = { ...stamp, claim_oid: current.oid };
    finalizeClaimCheckout(pd, recoveredStamp, current);
    console.log(JSON.stringify({
      published: true,
      recovered: true,
      unit,
      candidate_oid: current.oid,
      generation: current.generation,
      local_rows_withheld: projected.withheld,
    }));
    return;
  }
  const payload: UnitClaimPayload = {
    ...current.payload,
    predecessor_oid: current.oid,
    base_oid: publicationBaseOid,
    integration_ref: publicationIntegrationRef,
    candidate_tree_oid: headTree,
    candidate_head_oid: headOid,
    audit_shard: auditShard,
    ...(auditShard !== cloneShard ? { clone_audit_shard: cloneShard } : {}),
  };
  const commit = createClaimCommit(
    pd,
    current.oid,
    payload,
    headTree,
    headOid,
  );
  // Pin refuses a record outside the Unit's tree; say so here, before the
  // candidate is published, rather than at pin.
  const outside = candidateBoundary(
    pd, publicationBaseOid, commit, recordPrefix, unit, current.generation, auditShard,
  ).violations.filter((violation) => violation.endsWith(`(${OUTSIDE_UNIT_RECORD_TREE})`));
  if (outside.length > 0) {
    fail(
      `Unit "${unit}" candidate violates claimed Unit ownership at: ${outside.join(", ")}; ` +
        `pin would refuse it, so it was not published.${ownershipAdvice(unit, outside)}`,
    );
  }
  const pushed = updateClaimRef(pd, remote, stamp.claim_ref, commit, current.oid);
  if (!pushed.ok) {
    if (pushed.refused) {
      fail(`Unit "${unit}" publication was rejected by ${remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" publication compare-and-swap failed; refresh the claim and retry.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const published = currentClaim(pd, remote, stamp.claim_ref);
  if (!published || published.oid !== commit || published.nonce !== stamp.nonce) {
    fail(`Unit "${unit}" publication verification failed.`);
  }
  const updatedStamp = { ...stamp, claim_oid: published.oid };
  finalizeClaimCheckout(pd, updatedStamp, published);
  console.log(JSON.stringify({
    published: true,
    unit,
    candidate_oid: published.oid,
    candidate_head_oid: headOid,
    generation: published.generation,
    // Said rather than done quietly: the candidate carries the Unit's evidence,
    // and this many of the clone's own local rows stayed behind.
    local_rows_withheld: projected.withheld,
  }));
}

interface PinnedClaimCheck {
  claim: UnitClaimView;
  releasedTombstone?: UnitClaimView;
}

function pinnedClaimFromTransaction(
  projectDir: string,
  transaction: UnitMergeTransaction,
): UnitClaimView {
  const payload = readPayload(projectDir, transaction.pinned_oid, {
    localOnly: true,
  });
  if (
    payload?.status !== "claimed" ||
    payload.unit !== transaction.unit ||
    payload.intent_uuid !== transaction.intent_uuid ||
    payload.generation !== transaction.generation ||
    payload.nonce !== transaction.nonce ||
    payload.owner !== transaction.owner ||
    payload.base_oid !== transaction.candidate_base_oid ||
    payload.candidate_tree_oid !== transaction.candidate_tree_oid
  ) {
    fail(`Pinned Unit "${transaction.unit}" claim payload is unavailable or invalid.`);
  }
  return {
    unit: payload.unit,
    status: payload.status,
    owner: payload.owner,
    generation: payload.generation,
    nonce: payload.nonce,
    oid: transaction.pinned_oid,
    ref: transaction.claim_ref,
    payload,
  };
}

function currentPinnedClaim(
  projectDir: string,
  transaction: UnitMergeTransaction,
  options: { acceptReleasedAttempt?: boolean } = {},
): PinnedClaimCheck {
  invalidateLiveClaimPayloadCache(projectDir, transaction.unit);
  let current: UnitClaimView | null;
  try {
    current = currentClaim(
      projectDir,
      repositoryRemote(projectDir),
      transaction.claim_ref,
    );
  } catch (error) {
    const message = errorMessage(error);
    if (
      !message.startsWith("Unit claim registry read failed:") &&
      !message.startsWith("Unit claim registry fetch failed:")
    ) {
      throw error;
    }
    fail(
      `Unit "${transaction.unit}" claim registry is unavailable (${message}); ` +
        "merge gate and landing fail closed because the pinned attempt may have been tombstoned. Restore registry access and retry.",
    );
  }
  if (
    current?.status === "released" &&
    current.payload.predecessor_oid === transaction.pinned_oid &&
    current.generation === transaction.generation + 1
  ) {
    const accepted =
      transaction.released_after_git?.tombstone_oid === current.oid &&
      transaction.released_after_git.tombstone_generation ===
        current.generation;
    if (
      (!options.acceptReleasedAttempt && !accepted) ||
      transaction.status !== "git-landed"
    ) {
      fail(
        `Unit "${transaction.unit}" was released after its merge commit landed. ` +
          `Inspect the landed commit, then recover explicitly with aidlc unit land ${transaction.unit} ` +
          '--accept-released-attempt --user-input "<human acknowledgment>".',
      );
    }
    return {
      claim: pinnedClaimFromTransaction(projectDir, transaction),
      releasedTombstone: current,
    };
  }
  if (
    current?.status === "claimed" &&
    current.oid === transaction.pinned_oid &&
    current.generation === transaction.generation &&
    current.nonce === transaction.nonce &&
    current.owner !== transaction.owner
  ) {
    fail(
      `Unit "${transaction.unit}" merge journal owner does not match the pinned claim payload owner.`,
    );
  }
  if (
    current?.status !== "claimed" ||
    current.oid !== transaction.pinned_oid ||
    current.generation !== transaction.generation ||
    current.nonce !== transaction.nonce ||
    current.owner !== transaction.owner ||
    current.payload.base_oid !== transaction.candidate_base_oid ||
    current.payload.candidate_tree_oid !== transaction.candidate_tree_oid
  ) {
    fail(
      `Unit "${transaction.unit}" claim ref moved or changed attempt after pin; run aidlc-unit pin ${transaction.unit} again.`,
    );
  }
  return { claim: current };
}

function orderedAuditRows(projectDir: string): ReturnType<typeof readAuditShardEvents> {
  return readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

function mainAuthorityAuditRows(
  projectDir: string,
): ReturnType<typeof readAuditShardEvents> {
  const mainShard = auditShardName(projectDir);
  return orderedAuditRows(projectDir).filter(
    (row) => basename(row.shard) === mainShard,
  );
}

function assertTransactionIdentity(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  const identity = activeIdentity(projectDir);
  if (
    transaction.space !== identity.space ||
    transaction.intent_uuid !== identity.intentUuid ||
    transaction.intent_id8 !== identity.intentId8 ||
    transaction.claim_ref !== claimRef(identity.intentId8, transaction.unit)
  ) {
    fail(
      `Unit "${transaction.unit}" merge transaction belongs to another active space or intent.`,
    );
  }
}

function requireMergeDispatchDecision(
  projectDir: string,
  transaction: UnitMergeTransaction,
): { strategy: "merge" | "pr"; target: string } {
  const all = mainAuthorityAuditRows(projectDir);
  if (!transaction.pin_id) {
    fail(`Unit "${transaction.unit}" merge transaction has no pin identity; pin it again.`);
  }
  const relevant = all.filter(
    (row) =>
      (
        row.event === "MERGE_DISPATCH_INVOKED" ||
        row.event === "MERGE_DISPATCH_RETURNED" ||
        row.event === "MERGE_DISPATCH_FALLBACK"
      ) &&
      auditBlockField(row.block, "Bolt slug") === transaction.unit &&
      auditBlockField(row.block, "Pinned OID") === transaction.pinned_oid &&
      auditBlockField(row.block, "Attempt Generation") ===
        String(transaction.generation) &&
      auditBlockField(row.block, "Pin Transaction") === transaction.pin_id,
  );
  const invokedIndex = relevant.findLastIndex(
    (row) => row.event === "MERGE_DISPATCH_INVOKED",
  );
  if (invokedIndex < 0) {
    fail(`Unit "${transaction.unit}" merge gate requires MERGE_DISPATCH_INVOKED after pinning.`);
  }
  const terminal = relevant
    .slice(invokedIndex + 1)
    .findLast(
      (row) =>
        row.event === "MERGE_DISPATCH_RETURNED" ||
        row.event === "MERGE_DISPATCH_FALLBACK",
    );
  if (!terminal) {
    fail(`Unit "${transaction.unit}" merge dispatch has no terminal result.`);
  }
  if (!humanPresenceGuardDisabled()) {
    const terminalIndex = all.indexOf(terminal);
    const previousGate = [...all]
      .reverse()
      .find(
        (row) =>
          (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
          auditBlockField(row.block, "Stage") !== null,
      );
    const previousGateIndex = previousGate ? all.indexOf(previousGate) : -1;
    const humanFloor = Math.max(terminalIndex, previousGateIndex);
    if (
      terminalIndex < 0 ||
      !all.slice(humanFloor + 1).some((row) => row.event === "HUMAN_TURN")
    ) {
      fail(
        `Unit "${transaction.unit}" merge gate requires a typed human turn after merge dispatch.`,
      );
    }
  }
  if (terminal.event === "MERGE_DISPATCH_FALLBACK") {
    return { strategy: "merge", target: transaction.integration_branch };
  }
  const strategy = auditBlockField(terminal.block, "Strategy");
  const target = auditBlockField(terminal.block, "Target branch");
  if (strategy !== "merge" && strategy !== "pr") {
    fail(
      `Unit "${transaction.unit}" pinned transaction requires merge or pr strategy; dispatch returned "${strategy ?? "missing"}".`,
    );
  }
  if (!target) fail(`Unit "${transaction.unit}" merge dispatch omitted its target branch.`);
  return { strategy, target };
}

type LandedPullRequest = {
  ref: string;
  url: string;
  repo: string;
  head: string;
  merge_commit: string;
  merged_at: string;
  approvers: string[];
};

function ghBinary(): string {
  return process.env.AIDLC_GH_BIN?.trim() || "gh";
}

function parsePullRequestRef(ref: string): { owner: string; repo: string; number: string } | null {
  const match = /^(?:https?:\/\/[^/]+\/)?([^/#\s]+)\/([^/#\s]+?)(?:\/pull\/|#)(\d+)$/.exec(ref);
  return match ? { owner: match[1], repo: match[2], number: match[3] } : null;
}

type PullRequestView = {
  owner: string;
  repo: string;
  number: string;
  url: string;
  state: string | undefined;
  mergedAt: string | null;
  mergeCommit: string | null;
  headRefOid: string | null;
  reviewDecision: string | undefined;
  approvers: string[];
};

// One pull request as GitHub reports it, read through `gh`.
function viewPullRequest(ref: string): PullRequestView {
  const parsed = parsePullRequestRef(ref);
  if (!parsed) fail(`Pull request "${ref}" is not <owner>/<repo>#<n> or a pull request URL.`);
  const { owner, repo, number } = parsed;
  const result = spawnSync(
    ghBinary(),
    [
      "pr",
      "view",
      number,
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "url,state,mergedAt,mergeCommit,headRefOid,reviewDecision,latestReviews",
    ],
    { encoding: "utf-8", env: { ...process.env }, timeout: 20_000 },
  );
  if (result.status !== 0) {
    fail(`gh pr view ${ref} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}.`);
  }
  let view: {
    url?: string;
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | string | null;
    headRefOid?: string;
    reviewDecision?: string;
    latestReviews?: Array<{ state?: string; author?: { login?: string } }>;
  };
  try {
    view = JSON.parse(result.stdout) as typeof view;
  } catch {
    fail(`gh pr view ${ref} returned no JSON.`);
  }
  const mergeCommit = typeof view.mergeCommit === "string"
    ? view.mergeCommit
    : view.mergeCommit?.oid ?? null;
  return {
    owner,
    repo,
    number,
    url: view.url ?? ref,
    state: view.state,
    mergedAt: view.mergedAt ?? null,
    mergeCommit: mergeCommit && /^[0-9a-f]{40}$/.test(mergeCommit) ? mergeCommit : null,
    headRefOid: /^[0-9a-f]{40}$/.test(view.headRefOid ?? "") ? (view.headRefOid as string) : null,
    reviewDecision: view.reviewDecision,
    approvers: (view.latestReviews ?? [])
      .filter((review) => review?.state === "APPROVED")
      .map((review) => review?.author?.login ?? "")
      .filter(Boolean),
  };
}

// `--pr <owner>/<repo>#<n>[,...]` (or pull request URLs), by default the code
// pull requests `aidlc unit pr --repo` recorded: one per code repository the
// Unit changed. Each must be merged, and approved when the project asks for
// it (`aidlc config flags --pull-request-approval on`); the approvers found
// are recorded either way. Its repository must be one the intent records, its
// head commit is what land verifies on that repository's integration branch.
function pullRequestsFromGitHub(
  projectDir: string,
  value: string | undefined,
): LandedPullRequest[] {
  const refs = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (refs.length === 0) return [];
  const recorded = new Set(intentRepos(projectDir));
  const approvalRequired =
    resolveProjectFlag("AIDLC_PR_REQUIRE_APPROVAL", process.env, projectDir) === "1";
  return refs.map((ref) => {
    const view = viewPullRequest(ref);
    if (!recorded.has(view.repo)) {
      fail(`--pr "${ref}" names repository "${view.repo}", which this intent does not record.`);
    }
    if (view.state !== "MERGED" || !view.mergedAt || !view.mergeCommit) {
      fail(`Pull request ${ref} is not merged (state ${view.state ?? "unknown"}).`);
    }
    if (approvalRequired && view.reviewDecision !== "APPROVED") {
      fail(
        `Pull request ${ref} is not approved (review decision ${view.reviewDecision || "none"}); ` +
          "this project requires approved code pull requests (aidlc config flags --pull-request-approval).",
      );
    }
    if (!view.headRefOid) {
      fail(`Pull request ${ref} has no usable head or merge commit.`);
    }
    return {
      ref,
      url: view.url,
      repo: view.repo,
      head: view.headRefOid,
      merge_commit: view.mergeCommit,
      merged_at: view.mergedAt,
      approvers: view.approvers,
    };
  });
}

// The pinned Unit's merge gate under strategy pr, in the person's words: what
// was checked, and what approving does. Approving merges nothing: it lands the
// Unit on its own branch and opens the workspace pull request, and nothing
// reaches main until the person merges that. The conductor shows it as given.
export function pullRequestMergeGateAsk(projectDir: string, unit: string): {
  context: string;
  question: string;
  options: Array<{ label: string; description: string }>;
} | null {
  const transaction = readUnitMergeTransaction(projectDir, unit);
  if (!transaction) return null;
  const evidence = transaction.evidence;
  const skipped = evidence.stages_skipped ?? [];
  const gates = evidence.gates_approved.length !== evidence.gates_expected.length
    ? `${evidence.gates_approved.length} of ${evidence.gates_expected.length} stage approvals are recorded`
    : skipped.length === 0
      ? `all ${evidence.stages_expected.length} stages are approved`
      : `${evidence.stages_expected.length - skipped.length} of ${evidence.stages_expected.length} stages are approved and ` +
        `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} skipped for this Unit`;
  const reviews = evidence.reviewers_expected.length === 0
    ? ""
    : evidence.reviewers_ready.length === evidence.reviewers_expected.length
      ? ", every review is READY"
      : `, ${evidence.reviewers_ready.length} of ${evidence.reviewers_expected.length} reviews are READY`;
  const code = (readUnitPullRequests(projectDir, unit)?.code ?? []).map((entry) => entry.ref);
  return {
    context: `${unit} is ready to land: ${gates}${reviews}` +
      `${code.length > 0 ? `, and its code is merged (${code.join(", ")})` : ""}.`,
    question: `Open the workspace pull request that lands ${unit}?`,
    options: [
      {
        label: "Approve",
        description: "Records your approval, updates the Unit's branch and opens the workspace pull request. " +
          "Nothing reaches main until you merge it.",
      },
      {
        label: "Reject",
        description: "Records that you don't want it landed yet; nothing is pushed. Say what should change.",
      },
    ],
  };
}

function recordedCodePullRequestRefs(projectDir: string, unit: string): string | undefined {
  const refs = (readUnitPullRequests(projectDir, unit)?.code ?? []).map((entry) => entry.ref);
  return refs.length > 0 ? refs.join(",") : undefined;
}

function mergeGateRecord(
  projectDir: string,
  transaction: UnitMergeTransaction,
): {
  decision: "approve" | "reject";
  strategy: string | null;
  target: string | null;
} | null {
  const decisions = mainAuthorityAuditRows(projectDir).filter(
    (row) =>
      (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
      auditBlockField(row.block, "Stage") === "unit-merge" &&
      auditBlockField(row.block, "Unit") === transaction.unit &&
      auditBlockField(row.block, "Pinned OID") === transaction.pinned_oid &&
      auditBlockField(row.block, "Attempt Generation") ===
        String(transaction.generation) &&
      auditBlockField(row.block, "Gate Scope") === "unit-merge",
  );
  const latest = decisions.at(-1);
  if (!latest) return null;
  return {
    decision: latest.event === "GATE_APPROVED" ? "approve" : "reject",
    strategy: auditBlockField(latest.block, "Strategy"),
    target: auditBlockField(latest.block, "Target branch"),
  };
}

function pinUnit(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit pin <unit>");
  const pd = resolveProjectDir(projectDir);
  const ownStamp = readApplicableTeamUnitScopeStamp(pd);
  if (ownStamp && ownStamp.unit !== unit) {
    fail(`This checkout is scoped to Unit "${ownStamp.unit}"; pin Unit "${unit}" from an unscoped checkout or its own.`);
  }
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit pinning requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const inFlight = readUnitMergeTransaction(pd, unit);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const claim = currentClaim(pd, integration.remote, ref);
  let superseded: UnitMergeTransaction | null = null;
  if (
    inFlight &&
    inFlight.space === identity.space &&
    inFlight.intent_uuid === identity.intentUuid &&
    ["approved", "git-landed", "state-folded", "complete"].includes(
      inFlight.status,
    )
  ) {
    if (!approvalOutlivedByRepublish(pd, inFlight, claim)) {
      fail(
        `Unit "${unit}" already has a ${inFlight.status} merge transaction; recover it with aidlc unit land ${unit} instead of re-pinning.`,
      );
    }
    superseded = inFlight;
  }
  if (
    claim?.status !== "claimed" ||
    claim.payload.intent_uuid !== identity.intentUuid ||
    !claim.payload.candidate_tree_oid
  ) {
    fail(`Unit "${unit}" has no published live candidate to pin.`);
  }
  writeClaimGeneration(pd, unit, claim.generation);
  const evidence = candidateEvidence(
    pd,
    claim,
    claim.payload.base_oid,
    integration.oid,
  );
  const mainBefore = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve main HEAD");
  const pinId = randomUUID();
  const transaction: UnitMergeTransaction = {
    version: 1,
    status: "pinned",
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner: claim.owner,
    generation: claim.generation,
    nonce: claim.nonce,
    claim_ref: ref,
    pinned_oid: claim.oid,
    candidate_tree_oid: claim.payload.candidate_tree_oid,
    candidate_base_oid: claim.payload.base_oid,
    integration_oid: integration.oid,
    integration_branch: integration.branch,
    main_before_oid: mainBefore,
    pinned_at: isoTimestamp(),
    pin_id: pinId,
    audit_shard: claim.payload.audit_shard,
    evidence,
  };
  updateCachedClaim(pd, claim);
  writeUnitMergeTransaction(pd, transaction);
  console.log(JSON.stringify({
    pinned: true,
    unit,
    pinned_oid: claim.oid,
    pin_id: pinId,
    generation: claim.generation,
    evidence,
    gate_required: true,
    merge_dispatch_required: true,
    dispatch: mergeDispatchCommands(pd, unit, claim.oid, claim.generation, pinId),
    ...(superseded
      ? { superseded: { pinned_oid: superseded.pinned_oid, status: superseded.status } }
      : {}),
  }));
}

// An approved merge that git never landed, whose Unit was republished since
// (a refused landing, then a reopened stage): the approval was for a candidate
// the claim no longer holds, and gate and land both send the person back to
// pin. Pin replaces it. The approval stays bound to its own Pinned OID and
// Attempt Generation, so it never counts for the new candidate.
function approvalOutlivedByRepublish(
  projectDir: string,
  transaction: UnitMergeTransaction,
  claim: UnitClaimView | null,
): boolean {
  if (
    transaction.status !== "approved" ||
    transaction.git_commit_oid ||
    transaction.checkpoint_commit_oid ||
    claim?.status !== "claimed" ||
    claim.payload.intent_uuid !== transaction.intent_uuid ||
    (
      claim.oid === transaction.pinned_oid &&
      claim.generation === transaction.generation &&
      claim.nonce === transaction.nonce
    )
  ) {
    return false;
  }
  if (transaction.strategy === "pr") return true;
  if (git(projectDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) return false;
  const landed = firstParentMergeOf(projectDir, transaction);
  return landed === null;
}

// The dispatch bracket for this pin, its values filled in: the Unit's own
// checkout lands through pull requests on its branch, unscoped main merges
// into its own. The three values in angle brackets are the dispatcher's to
// write: the team practice it read, how sure it is, and a one-line note.
function mergeDispatchCommands(
  projectDir: string,
  unit: string,
  pinnedOid: string,
  generation: number,
  pinId: string,
): { strategy: "pr" | "merge"; invoked: string; returned: string; note: string } {
  const strategy = readUnitScopeStamp(projectDir) ? "pr" : "merge";
  const target = currentBranch(projectDir) || "<branch>";
  const pin = `--slug ${unit} --pinned-oid ${pinnedOid} --attempt-generation ${generation} --pin-id ${pinId}`;
  return {
    strategy,
    invoked: `aidlc engine bolt dispatch-event --event MERGE_DISPATCH_INVOKED ${pin} ` +
      "--practices-excerpt '<the team practice on landing>'",
    returned: `aidlc engine bolt dispatch-event --event MERGE_DISPATCH_RETURNED ${pin} ` +
      `--strategy ${strategy} --target ${target} --confidence <0-1> --notes '<one line>'`,
    note: "Run invoked, then returned. Returned prints the merge gate to put to the person; " +
      `record their answer with aidlc unit gate ${unit}.`,
  };
}

function gateUnitMerge(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const decision = flags.decision;
  const userInput = flags["user-input"]?.trim();
  if (!unit || (decision !== "approve" && decision !== "reject") || !userInput) {
    fail(
      "Usage: aidlc-unit gate <unit> --decision <approve|reject> --user-input <text>",
    );
  }
  const pd = resolveProjectDir(projectDir);
  if (
    !humanPresenceGuardDisabled() &&
    isNonAnswer(userInput)
  ) {
    fail(
      `Refusing Unit "${unit}" merge approval: --user-input "${userInput}" is cancellation boilerplate, not a human decision.`,
    );
  }
  const transaction = readUnitMergeTransaction(pd, unit);
  if (!transaction || !["pinned", "approved", "rejected"].includes(transaction.status)) {
    fail(`Unit "${unit}" has no pinned merge transaction.`);
  }
  assertTransactionIdentity(pd, transaction);
  const claim = currentPinnedClaim(pd, transaction).claim;
  const liveIntegration = fetchIntegration(pd);
  const evidence = candidateEvidence(
    pd,
    claim,
    transaction.candidate_base_oid,
    liveIntegration.oid,
  );
  if (JSON.stringify(evidence) !== JSON.stringify(transaction.evidence)) {
    fail(`Unit "${unit}" pinned evidence journal changed; run aidlc-unit pin ${unit} again.`);
  }
  if (transaction.evidence.merge_held) {
    fail(
      `Unit "${unit}" merge is held. Resolve the existing HOLD-MERGE flow in the team checkout, publish, and re-pin.`,
    );
  }
  const existingDecision = mergeGateRecord(pd, transaction)?.decision;
  if (
    (
      (transaction.status === "approved" && decision === "approve") ||
      (transaction.status === "rejected" && decision === "reject")
    ) &&
    existingDecision === decision
  ) {
    console.log(JSON.stringify({
      gated: true,
      recovered: true,
      unit,
      decision,
      pinned_oid: transaction.pinned_oid,
    }));
    return;
  }
  const dispatch = requireMergeDispatchDecision(pd, transaction);
  if (dispatch.strategy !== "pr" && flags.pr) {
    fail(`--pr applies to the pr strategy; dispatch returned "${dispatch.strategy}".`);
  }
  const pullRequests = dispatch.strategy === "pr"
    ? pullRequestsFromGitHub(pd, flags.pr ?? recordedCodePullRequestRefs(pd, unit))
    : [];
  appendAuditEntry(
    decision === "approve" ? "GATE_APPROVED" : "GATE_REJECTED",
    {
      Stage: "unit-merge",
      Unit: unit,
      "Pinned OID": transaction.pinned_oid,
      "Attempt Generation": String(transaction.generation),
      "Gate Scope": "unit-merge",
      Strategy: dispatch.strategy,
      "Target branch": dispatch.target,
      ...(dispatch.strategy === "pr"
        ? {
            "Pull requests": pullRequests.map((pr) => pr.url).join(", ") || "none",
            "Code heads": pullRequests.map((pr) => `${pr.repo}=${pr.head}`).join(", ") || "none",
            "Merge commits": pullRequests.map((pr) => `${pr.repo}=${pr.merge_commit}`).join(", ") || "none",
            "Approved by": [...new Set(pullRequests.flatMap((pr) => pr.approvers))].join(", ") || "none",
          }
        : {}),
      "Outside the unit record tree":
        transaction.evidence.outside_unit_record_paths.join(", ") || "none",
      ...(decision === "approve"
        ? { "User Input": userInput }
        : { Feedback: userInput }),
    },
    pd,
  );
  writeUnitMergeTransaction(pd, {
    ...transaction,
    status: decision === "approve" ? "approved" : "rejected",
    decision,
    user_input: userInput,
    target_branch: dispatch.target,
    strategy: dispatch.strategy,
    ...(dispatch.strategy === "pr" ? { pull_requests: pullRequests } : {}),
  });
  console.log(JSON.stringify({
    gated: true,
    unit,
    decision,
    pinned_oid: transaction.pinned_oid,
    generation: transaction.generation,
    outside_unit_record_paths:
      transaction.evidence.outside_unit_record_paths,
    outside_unit_record_tree_note:
      "These paths are outside the unit's record tree and require human overlap judgment.",
  }));
}

function isActiveIntentAuditPath(
  path: string,
  recordPrefix: string,
): boolean {
  const root = `${recordPrefix}/audit/`;
  if (!path.startsWith(root)) return false;
  const leaf = path.slice(root.length);
  return /^[A-Za-z0-9._-]+\.md$/.test(leaf);
}

function isEngineMergeMetadata(
  projectDir: string,
  path: string,
  recordPrefix = relativeRecordDir(projectDir),
): boolean {
  if (!recordPrefix) return path === CLAIM_FILE;
  const activeIntentPointer = `${dirname(recordPrefix)}/active-intent`;
  return new Set([
    CLAIM_FILE,
    "aidlc/active-space",
    activeIntentPointer,
    `${recordPrefix}/aidlc-state.md`,
    `${recordPrefix}/runtime-graph.json`,
  ]).has(path);
}

function conflictFiles(projectDir: string): string[] {
  const listed = git(projectDir, ["diff", "--name-only", "--diff-filter=U"]);
  return listed.ok
    ? listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
}

// What the landing checkout's worktree holds beyond the engine's own merge
// metadata: `unsafe` is anything a landing must not sweep up (a person's
// uncommitted source, a stray audit file), `staged` what the checkpoint
// commits. A stage's observation diary is engine scratch the next run
// rewrites; it neither blocks the checkpoint nor rides in it.
function landingWorktreePaths(
  projectDir: string,
): { unsafe: string[]; staged: string[] } {
  const statusResult = git(
    projectDir,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  if (!statusResult.ok) {
    fail(
      `Cannot inspect main worktree: ${statusResult.stderr.trim() || `exit ${statusResult.code}`}`,
    );
  }
  const status = statusResult.stdout;
  if (!status) return { unsafe: [], staged: [] };
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) {
    fail("Cannot resolve active intent metadata for Unit landing.");
  }
  const paths: string[] = [];
  const records = status.split("\u0000");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(code) && records[i + 1]) {
      paths.push(records[++i]);
    }
  }
  const stageDiary = new RegExp(
    `^${recordPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/construction/[^/]+/memory\\.md$`,
  );
  return {
    unsafe: paths.filter(
      (path) =>
        !isEngineMergeMetadata(projectDir, path, recordPrefix) &&
        path !== `${recordPrefix}/audit/${auditShardName(projectDir)}` &&
        !stageDiary.test(path),
    ),
    staged: paths.filter((path) => !stageDiary.test(path)),
  };
}

function assertCleanSourceWorktree(projectDir: string): void {
  const { unsafe } = landingWorktreePaths(projectDir);
  if (unsafe.length > 0) {
    fail(
      `Unit landing requires a clean source worktree; commit or stash: ${unsafe.join(", ")}.`,
    );
  }
}

function checkpointMainMetadata(
  projectDir: string,
  message: string,
): { parentOid: string; commitOid?: string } {
  const parentOid = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot resolve metadata checkpoint parent",
  );
  assertCleanSourceWorktree(projectDir);
  const { staged } = landingWorktreePaths(projectDir);
  // Only diaries changed: nothing to checkpoint (a refold that found the
  // rebased branch already current).
  if (staged.length === 0) return { parentOid };
  const added = git(projectDir, ["add", "-A", "--", ...staged]);
  if (!added.ok) {
    fail(
      `Failed to stage main engine metadata checkpoint: ${added.stderr.trim() || added.stdout.trim()}.`,
    );
  }
  const committed = git(projectDir, [
    "commit",
    "-m",
    message,
  ]);
  if (!committed.ok) {
    fail(`Failed to checkpoint main engine metadata: ${gitFailure(committed)}.`);
  }
  return {
    parentOid,
    commitOid: gitOutput(
      projectDir,
      ["rev-parse", "HEAD"],
      "Cannot resolve metadata checkpoint commit",
    ),
  };
}

function restoreMainMetadata(
  projectDir: string,
  paths: string[],
): void {
  const recordPrefix = relativeRecordDir(projectDir);
  for (const path of paths.filter((path) =>
    isEngineMergeMetadata(projectDir, path, recordPrefix)
  )) {
    if (gitPathExistsAt(projectDir, "HEAD", path)) {
      const restored = git(projectDir, ["checkout", "HEAD", "--", path]);
      if (!restored.ok) fail(`Failed to retain main metadata path ${path}.`);
      const added = git(projectDir, ["add", "--", path]);
      if (!added.ok) fail(`Failed to stage retained metadata path ${path}.`);
    } else {
      git(projectDir, ["rm", "-f", "--cached", "--ignore-unmatch", "--", path]);
      try {
        unlinkSync(join(projectDir, path));
      } catch {
        // Candidate-only metadata may already be absent.
      }
    }
  }
}

interface GitObjectRead {
  oid: string | null;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface CandidateExactDetails {
  version: 1;
  phase: "pending-index" | "merge-commit";
  unit: string;
  generation: number;
  treeish: string;
  passed_pending_tree_oid?: string;
  main_parent_oid: string;
  pinned_oid: string;
  candidate_base_oid: string;
  violations: string[];
  boundary_violations: string[];
  unexpected_changes: string[];
  object_mismatches: Array<{
    path: string;
    expected_treeish: string;
    actual: GitObjectRead;
    expected: GitObjectRead;
  }>;
}

class CandidateExactPolicyError extends Error {
  constructor(message: string, readonly details: CandidateExactDetails) {
    super(message);
  }
}

function gitObjectAt(
  projectDir: string,
  oid: string,
  path: string,
): GitObjectRead {
  // Preserve the original lookup outcome: a later diagnostic read may succeed
  // after the failure, and must not replace what the policy actually compared.
  const result = spawnSync("git", ["rev-parse", "--verify", `${oid}:${path}`], {
    cwd: projectDir,
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    oid: result.status === 0 ? (result.stdout ?? "").trim() : null,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function candidateChangedPaths(
  projectDir: string,
  transaction: UnitMergeTransaction,
): string[] {
  return gitOutput(
    projectDir,
    [
      "diff",
      "--name-only",
      `${transaction.candidate_base_oid}..${transaction.pinned_oid}`,
    ],
    "Cannot inspect pinned candidate diff",
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function mergeCommitParents(projectDir: string, commitOid: string): string[] {
  return gitOutput(
    projectDir,
    ["show", "-s", "--format=%P", commitOid],
    `Cannot inspect merge commit ${commitOid}`,
  )
    .split(/\s+/)
    .filter(Boolean);
}

function inspectLandedTree(
  projectDir: string,
  transaction: UnitMergeTransaction,
  treeish: string,
  mainParent: string,
): Omit<CandidateExactDetails, "phase"> {
  const candidatePaths = candidateChangedPaths(projectDir, transaction);
  const recordPrefix = relativeRecordDir(projectDir);
  const boundary = recordPrefix
    ? candidateBoundary(
        projectDir,
        transaction.candidate_base_oid,
        transaction.pinned_oid,
        recordPrefix,
        transaction.unit,
        transaction.generation,
        transaction.audit_shard,
      )
    : {
        violations: ["active intent record is unavailable"],
      };
  const carriedOnly = (path: string): boolean =>
    isCarriedReviewRecord(projectDir, path, recordPrefix, transaction.unit);
  const allowedCommitChanges = new Set(
    candidatePaths.filter((path) =>
      !isEngineMergeMetadata(projectDir, path, recordPrefix) && !carriedOnly(path)
    ),
  );
  const actualCommitChanges = gitOutput(
    projectDir,
    ["diff", "--name-only", `${mainParent}..${treeish}`],
    "Cannot inspect landed merge tree",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const unexpectedChanges = actualCommitChanges.filter((path) => !allowedCommitChanges.has(path));
  const violations = [...boundary.violations, ...unexpectedChanges];
  const objectMismatches: CandidateExactDetails["object_mismatches"] = [];
  for (const path of candidatePaths) {
    const actual = gitObjectAt(projectDir, treeish, path);
    const expectedTreeish = isEngineMergeMetadata(projectDir, path, recordPrefix) || carriedOnly(path)
      ? mainParent
      : transaction.pinned_oid;
    const expected = gitObjectAt(projectDir, expectedTreeish, path);
    if (actual.oid !== expected.oid) {
      violations.push(path);
      objectMismatches.push({ path, expected_treeish: expectedTreeish, actual, expected });
    }
  }
  return {
    version: 1,
    unit: transaction.unit,
    generation: transaction.generation,
    treeish,
    main_parent_oid: mainParent,
    pinned_oid: transaction.pinned_oid,
    candidate_base_oid: transaction.candidate_base_oid,
    violations: [...new Set(violations)].sort(),
    boundary_violations: boundary.violations,
    unexpected_changes: unexpectedChanges,
    object_mismatches: objectMismatches,
  };
}

function assertLandCandidateBoundary(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) {
    fail("Cannot resolve the active intent record for Unit landing.");
  }
  const boundary = candidateBoundary(
    projectDir,
    transaction.candidate_base_oid,
    transaction.pinned_oid,
    recordPrefix,
    transaction.unit,
    transaction.generation,
    transaction.audit_shard,
  );
  if (boundary.violations.length > 0) {
    fail(
      `Unit "${transaction.unit}" landing violates claimed Unit ownership at: ${
        boundary.violations.join(", ")
      }.${ownershipAdvice(transaction.unit, boundary.violations)}`,
    );
  }
}

function validateLandedMerge(
  projectDir: string,
  transaction: UnitMergeTransaction,
  commitOid: string,
  target: string,
): void {
  const branch = gitOutput(
    projectDir,
    ["branch", "--show-current"],
    "Cannot resolve landing branch",
  );
  if (branch !== target) {
    fail(`Unit landing expected branch "${target}", found "${branch}".`);
  }
  if (
    !git(
      projectDir,
      ["merge-base", "--is-ancestor", commitOid, "HEAD"],
    ).ok
  ) {
    fail(`Recorded Unit merge commit ${commitOid} is not on ${target}.`);
  }
  const parents = mergeCommitParents(projectDir, commitOid);
  if (parents.length < 2 || parents[1] !== transaction.pinned_oid) {
    fail(
      `Unit "${transaction.unit}" landing is not a controlled merge of pinned OID ${transaction.pinned_oid}.`,
    );
  }
  const mainParent = parents[0];
  const inspection = inspectLandedTree(
    projectDir,
    transaction,
    commitOid,
    mainParent,
  );
  if (inspection.violations.length > 0) {
    throw new CandidateExactPolicyError(
      `Unit "${transaction.unit}" merge commit violates candidate-exact policy at: ${inspection.violations.join(", ")}.`,
      { ...inspection, phase: "merge-commit" },
    );
  }
}

// The paths a commit range changed whose blob on `tipOid` differs from the
// blob on `headOid`: the content a platform merge (squash included) must have
// carried onto the integration branch. A path absent on both sides matches.
function contentNotOnTip(
  repoDir: string,
  baseOid: string,
  headOid: string,
  tipOid: string,
  skip: (path: string) => boolean = () => false,
  carries: (path: string) => boolean = () => false,
): string[] {
  const changed = gitOutput(
    repoDir,
    ["diff", "--name-only", "--no-renames", `${baseOid}..${headOid}`],
    `Cannot inspect ${baseOid}..${headOid}`,
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const mismatches: string[] = [];
  for (const path of changed) {
    if (skip(path)) continue;
    const expected = gitObjectAt(repoDir, headOid, path).oid;
    const actual = gitObjectAt(repoDir, tipOid, path).oid;
    if (expected !== actual && !carries(path)) mismatches.push(path);
  }
  return mismatches;
}

// The claim-bound audit shard is the one candidate file whose bytes differ
// by design: publish transports only the Unit's receipts, while the pull
// request carries the clone's whole file. The integration tip carries the
// candidate when every transported block appears in its copy verbatim.
function auditShardCarriesCandidate(
  projectDir: string,
  transaction: UnitMergeTransaction,
  tipOid: string,
  path: string,
): boolean {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix || !transaction.audit_shard) return false;
  if (path !== `${recordPrefix}/audit/${transaction.audit_shard}`) return false;
  if (!gitPathExistsAt(projectDir, tipOid, path)) return false;
  const expected = gitTextAt(projectDir, transaction.pinned_oid, path);
  const actual = gitTextAt(projectDir, tipOid, path);
  // Blocks start at their `## ` heading; the file's own title line is not one.
  const blocks = expected
    .split(/\n---\n/)
    .map((block) => block.replace(/^[\s\S]*?(?=^## )/m, "").trim())
    .filter((block) => block.startsWith("## "));
  return blocks.length > 0 && blocks.every((block) => actual.includes(block));
}

// Pull-request landing: GitHub merged the Unit's code through reviewed pull
// requests; this step verifies each one on its repository's integration
// branch (the merge commit is on it, and the head's content is there, squash
// or not) and records this branch's head as the landing commit. The Unit's
// record and the fold travel together in this branch's own pull request.
function landPr(
  projectDir: string,
  transaction: UnitMergeTransaction,
  target: string,
  landingHead: string,
): UnitMergeTransaction {
  assertLandCandidateBoundary(projectDir, transaction);
  for (const pr of transaction.pull_requests ?? []) {
    const repoDir = join(projectDir, pr.repo);
    if (!existsSync(join(repoDir, ".git"))) {
      fail(`Code repository "${pr.repo}" is not checked out at ${repoDir}.`);
    }
    const integration = fetchIntegration(repoDir);
    for (const oid of [pr.head, pr.merge_commit]) {
      if (!git(repoDir, ["cat-file", "-e", `${oid}^{commit}`]).ok) {
        git(repoDir, ["fetch", "--all", "--quiet"]);
        if (!git(repoDir, ["cat-file", "-e", `${oid}^{commit}`]).ok) {
          fail(`Commit ${oid} of ${pr.ref} is not available in ${repoDir}; fetch it first.`);
        }
      }
    }
    if (!git(repoDir, ["merge-base", "--is-ancestor", pr.merge_commit, integration.oid]).ok) {
      fail(
        `Merge commit ${pr.merge_commit} of ${pr.ref} is not on ${pr.repo}'s ${integration.branch} at ${integration.oid}.`,
      );
    }
    const base = gitOutput(
      repoDir,
      ["merge-base", pr.head, integration.oid],
      `Cannot find the merge base of ${pr.head} and ${integration.ref} in ${pr.repo}`,
    );
    const mismatches = contentNotOnTip(repoDir, base, pr.head, integration.oid);
    if (mismatches.length > 0) {
      fail(
        `Unit "${transaction.unit}" code from ${pr.ref} is not on ${pr.repo}'s ${integration.branch} at: ` +
          `${mismatches.join(", ")}.`,
      );
    }
  }
  return {
    ...transaction,
    status: "git-landed",
    target_branch: target,
    strategy: "pr",
    git_commit_oid: landingHead,
    conflict_files: undefined,
  };
}

// The state step's re-check of a pull-request landing: the recorded
// integration tip is on the landing branch and still carries the candidate.
function validateLandedPr(
  projectDir: string,
  transaction: UnitMergeTransaction,
  commitOid: string,
  target: string,
): void {
  const branch = gitOutput(
    projectDir,
    ["branch", "--show-current"],
    "Cannot resolve landing branch",
  );
  if (branch !== target) {
    fail(`Unit landing expected branch "${target}", found "${branch}".`);
  }
  if (!git(projectDir, ["merge-base", "--is-ancestor", commitOid, "HEAD"]).ok) {
    fail(`Recorded integration tip ${commitOid} is not on ${target}.`);
  }
  const recordPrefix = relativeRecordDir(projectDir);
  const mismatches = contentNotOnTip(
    projectDir,
    transaction.candidate_base_oid,
    transaction.pinned_oid,
    commitOid,
    (path) => isEngineMergeMetadata(projectDir, path, recordPrefix),
    // The Unit's review records ride in the candidate for pin only: they are
    // git-ignored framework state, so the pull request never carries them.
    (path) => auditShardCarriesCandidate(projectDir, transaction, commitOid, path) ||
      (recordPrefix !== null && isUnitReviewRecordPath(path, recordPrefix, transaction.unit)),
  );
  if (mismatches.length > 0) {
    fail(
      `Unit "${transaction.unit}" integration tip ${commitOid} no longer carries the candidate at: ${mismatches.join(", ")}.`,
    );
  }
}

// The merge commit of the pinned candidate on HEAD's first-parent line since
// pin, or null when there is none. Undefined when the history cannot be read.
function firstParentMergeOf(
  projectDir: string,
  transaction: UnitMergeTransaction,
): string | null | undefined {
  const history = git(
    projectDir,
    [
      "log",
      "--first-parent",
      "--format=%H%x00%P",
      `${transaction.main_before_oid}..HEAD`,
    ],
  );
  if (!history.ok) return undefined;
  for (const line of history.stdout.split(/\r?\n/).filter(Boolean)) {
    const [commitOid, parentText = ""] = line.split("\u0000");
    const parents = parentText.split(/\s+/).filter(Boolean);
    if (parents[1] === transaction.pinned_oid) return commitOid;
  }
  return null;
}

function recoveredMergeCommit(
  projectDir: string,
  transaction: UnitMergeTransaction,
  target: string,
): string | null {
  const commitOid = firstParentMergeOf(projectDir, transaction);
  if (!commitOid) return null;
  validateLandedMerge(projectDir, transaction, commitOid, target);
  return commitOid;
}

function metadataCheckpointAtHead(
  projectDir: string,
  unit: string,
): { parentOid: string; commitOid: string } | null {
  const commitOid = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot inspect metadata checkpoint",
  );
  const subject = gitOutput(
    projectDir,
    ["show", "-s", "--format=%s", commitOid],
    "Cannot inspect metadata checkpoint subject",
  );
  if (subject !== `Checkpoint Unit ${unit} merge gate`) return null;
  const parents = mergeCommitParents(projectDir, commitOid);
  if (parents.length !== 1) return null;
  const paths = gitOutput(
    projectDir,
    ["diff", "--name-only", `${parents[0]}..${commitOid}`],
    "Cannot inspect metadata checkpoint paths",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) return null;
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !isEngineMergeMetadata(projectDir, path, recordPrefix) &&
        !isActiveIntentAuditPath(path, recordPrefix),
    )
  ) {
    return null;
  }
  return { parentOid: parents[0], commitOid };
}

function validateMetadataCheckpoint(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  if (!transaction.checkpoint_commit_oid) return;
  const checkpoint = metadataCheckpointAtHead(projectDir, transaction.unit);
  if (
    !checkpoint ||
    checkpoint.commitOid !== transaction.checkpoint_commit_oid ||
    checkpoint.parentOid !== transaction.checkpoint_parent_oid
  ) {
    fail(`Unit "${transaction.unit}" metadata checkpoint is invalid.`);
  }
}

function rollbackMetadataCheckpoint(
  projectDir: string,
  transaction: UnitMergeTransaction,
): UnitMergeTransaction {
  if (
    transaction.checkpoint_commit_oid &&
    transaction.checkpoint_parent_oid &&
    gitOutput(projectDir, ["rev-parse", "HEAD"], "Cannot inspect checkpoint HEAD") ===
      transaction.checkpoint_commit_oid
  ) {
    validateMetadataCheckpoint(projectDir, transaction);
    const reset = git(
      projectDir,
      ["reset", "--mixed", transaction.checkpoint_parent_oid],
    );
    if (!reset.ok) {
      fail(`Failed to restore pre-merge metadata checkpoint: ${reset.stderr.trim()}.`);
    }
  }
  return {
    ...transaction,
    checkpoint_parent_oid: undefined,
    checkpoint_commit_oid: undefined,
  };
}

function landGit(
  projectDir: string,
  transaction: UnitMergeTransaction,
  target: string,
): UnitMergeTransaction {
  assertLandCandidateBoundary(projectDir, transaction);
  if (transaction.git_commit_oid) {
    validateLandedMerge(
      projectDir,
      transaction,
      transaction.git_commit_oid,
      target,
    );
    return transaction;
  }
  const recovered = recoveredMergeCommit(projectDir, transaction, target);
  if (recovered) {
    return {
      ...transaction,
      status: "git-landed",
      target_branch: target,
      strategy: "merge",
      git_commit_oid: recovered,
    };
  }
  currentPinnedClaim(projectDir, transaction);
  const branch = gitOutput(
    projectDir,
    ["branch", "--show-current"],
    "Cannot resolve main branch",
  );
  if (branch !== target) {
    fail(`Unit landing expected branch "${target}", found "${branch}".`);
  }
  let working = transaction;
  if (!working.checkpoint_commit_oid) {
    const recoveredCheckpoint = metadataCheckpointAtHead(
      projectDir,
      transaction.unit,
    );
    if (recoveredCheckpoint) {
      working = {
        ...working,
        checkpoint_parent_oid: recoveredCheckpoint.parentOid,
        checkpoint_commit_oid: recoveredCheckpoint.commitOid,
      };
      writeUnitMergeTransaction(projectDir, working);
    }
  } else {
    validateMetadataCheckpoint(projectDir, working);
  }
  const existingMergeHead = git(
    projectDir,
    ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
  );
  if (!existingMergeHead.ok) {
    if (working.checkpoint_commit_oid) {
      const head = gitOutput(
        projectDir,
        ["rev-parse", "HEAD"],
        "Cannot inspect metadata checkpoint",
      );
      if (head !== working.checkpoint_commit_oid) {
        fail("Unit merge metadata checkpoint no longer matches HEAD.");
      }
    } else {
      const checkpoint = checkpointMainMetadata(
        projectDir,
        `Checkpoint Unit ${transaction.unit} merge gate`,
      );
      working = {
        ...working,
        checkpoint_parent_oid: checkpoint.parentOid,
        checkpoint_commit_oid: checkpoint.commitOid,
      };
      writeUnitMergeTransaction(projectDir, working);
    }
  } else if (existingMergeHead.stdout.trim() !== transaction.pinned_oid) {
    fail("Another git merge is already in progress.");
  }
  const changed = candidateChangedPaths(projectDir, transaction);
  const merged = existingMergeHead.ok
    ? { ok: true, stdout: "", stderr: "", code: 0 }
    : git(
      projectDir,
      ["merge", "--no-commit", "--no-ff", transaction.pinned_oid],
    );
  restoreMainMetadata(projectDir, changed);
  const landingRecordPrefix = relativeRecordDir(projectDir);
  for (const path of changed.filter((path) =>
    isCarriedReviewRecord(projectDir, path, landingRecordPrefix, transaction.unit)
  )) {
    const dropped = git(projectDir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
    if (!dropped.ok) fail(`Failed to leave the review record ${path} out of the merge: ${dropped.stderr.trim()}.`);
  }
  const conflicts = conflictFiles(projectDir).filter(
    (path) => !isEngineMergeMetadata(projectDir, path),
  );
  if (conflicts.length > 0) {
    git(projectDir, ["merge", "--abort"]);
    working = rollbackMetadataCheckpoint(projectDir, working);
    writeUnitMergeTransaction(projectDir, {
      ...working,
      conflict_files: conflicts,
    });
    fail(`Unit "${transaction.unit}" source conflicts: ${conflicts.join(", ")}.`);
  }
  if (!merged.ok && !git(projectDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    working = rollbackMetadataCheckpoint(projectDir, working);
    writeUnitMergeTransaction(projectDir, working);
    fail(`Pinned git merge failed: ${merged.stderr.trim() || merged.stdout.trim()}.`);
  }
  const pendingTree = gitOutput(
    projectDir,
    ["write-tree"],
    "Cannot materialize pending Unit merge tree",
  );
  const mainParent = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot resolve pending Unit merge parent",
  );
  const inspection = inspectLandedTree(
    projectDir,
    working,
    pendingTree,
    mainParent,
  );
  if (inspection.violations.length > 0) {
    git(projectDir, ["merge", "--abort"]);
    working = rollbackMetadataCheckpoint(projectDir, working);
    writeUnitMergeTransaction(projectDir, {
      ...working,
      conflict_files: inspection.violations,
    });
    throw new CandidateExactPolicyError(
      `Unit "${transaction.unit}" candidate-exact merge policy refused auto-merged paths: ` +
        `${inspection.violations.join(", ")}. Rebase onto the current target and republish.`,
      { ...inspection, phase: "pending-index" },
    );
  }
  const committed = git(projectDir, [
    "commit",
    "--no-edit",
    "-m",
    `Merge Unit ${transaction.unit} @ ${transaction.pinned_oid.slice(0, 12)}`,
  ]);
  if (!committed.ok) {
    git(projectDir, ["merge", "--abort"]);
    working = rollbackMetadataCheckpoint(projectDir, working);
    writeUnitMergeTransaction(projectDir, working);
    fail(`Pinned git merge commit failed: ${gitFailure(committed)}.`);
  }
  const commitOid = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot resolve landed merge commit",
  );
  try {
    validateLandedMerge(projectDir, working, commitOid, target);
  } catch (error) {
    if (error instanceof CandidateExactPolicyError) {
      error.details.passed_pending_tree_oid = pendingTree;
    }
    const reset = git(projectDir, ["reset", "--hard", mainParent]);
    if (!reset.ok) {
      fail(
        `Unit merge validation failed and rollback also failed: ${errorMessage(error)}; ${reset.stderr.trim()}.`,
      );
    }
    working = rollbackMetadataCheckpoint(projectDir, working);
    writeUnitMergeTransaction(projectDir, working);
    throw error;
  }
  return {
    ...working,
    status: "git-landed",
    target_branch: target,
    strategy: "merge",
    git_commit_oid: commitOid,
    conflict_files: undefined,
  };
}

// Put the integration branch's state file back on the landing branch, staged,
// before a pull-request landing's fold.
function restoreIntegrationState(projectDir: string): void {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) fail("Cannot resolve the active intent record for the state fold.");
  const integration = fetchIntegration(projectDir);
  const path = `${recordPrefix}/aidlc-state.md`;
  if (!gitPathExistsAt(projectDir, integration.oid, path)) {
    fail(`${integration.ref} at ${integration.oid} holds no ${path} to fold the Unit into.`);
  }
  const restored = git(projectDir, ["checkout", integration.oid, "--", path]);
  if (!restored.ok) fail(`Cannot take ${path} from ${integration.ref}: ${restored.stderr.trim()}`);
}

function runStateFold(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  // A compiled install has no aidlc-state.ts beside this module: its URL is
  // inside the bundle, and process.execPath is the aidlc binary, which reads a
  // script path as an unknown command. Route the fold through `engine state`
  // there, as the orchestrator's spawnState does, and like it use only this
  // process's own identity, never an executable supplied through the
  // environment, since the child inherits the unit-merge owner token (#1286).
  const [command, ...args] = aidlcEngineCommand(
    "state",
    [
      "fold-unit-merge",
      "--unit",
      transaction.unit,
      "--pinned-oid",
      transaction.pinned_oid,
      "--generation",
      String(transaction.generation),
      "--project-dir",
      projectDir,
    ],
    join(dirname(fileURLToPath(import.meta.url)), "aidlc-state.ts"),
    isCompiledExecutable() ? process.execPath : null,
  );
  const result = spawnSync(
    command,
    args,
    {
      cwd: projectDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_STATE_TRANSITION_OWNER: `unit-merge:${process.pid}`,
      },
    },
  );
  if (result.status !== 0) {
    fail(`Unit state fold failed: ${(result.stderr || result.stdout).trim()}.`);
  }
}

function validateMergeRiskAcknowledgment(
  projectDir: string,
  unit: string,
  userInput: string | undefined,
): string {
  const answer = userInput?.trim();
  if (!answer) {
    fail(
      `Unit "${unit}" released-attempt recovery requires --user-input <human acknowledgment>.`,
    );
  }
  if (!humanPresenceGuardDisabled() && isNonAnswer(answer)) {
    fail(
      `Refusing Unit "${unit}" released-attempt recovery: --user-input "${answer}" is cancellation boilerplate.`,
    );
  }
  if (!humanPresenceGuardDisabled()) {
    const all = mainAuthorityAuditRows(projectDir);
    const floor = all.findLastIndex(
      (row) =>
        row.event === "GATE_APPROVED" ||
        row.event === "GATE_REJECTED" ||
        (
          row.event === "RECOVERY_COMPLETED" &&
          auditBlockField(row.block, "Recovery") ===
            "unit-merge-released-attempt"
        ),
    );
    if (!all.slice(floor + 1).some((row) => row.event === "HUMAN_TURN")) {
      fail(
        `Unit "${unit}" released-attempt recovery requires a fresh typed human turn from main's audit shard.`,
      );
    }
  }
  return answer;
}

function recordReleasedAfterGitAcceptance(
  projectDir: string,
  transaction: UnitMergeTransaction,
  tombstone: UnitClaimView,
  userInput: string,
): UnitMergeTransaction {
  if (
    transaction.released_after_git?.tombstone_oid === tombstone.oid &&
    transaction.released_after_git.tombstone_generation ===
      tombstone.generation
  ) {
    return transaction;
  }
  appendAuditEntry(
    "RECOVERY_COMPLETED",
    {
      Recovery: "unit-merge-released-attempt",
      Unit: transaction.unit,
      "Pinned OID": transaction.pinned_oid,
      "Attempt Generation": String(transaction.generation),
      "Tombstone OID": tombstone.oid,
      "Tombstone Generation": String(tombstone.generation),
      "User Input": userInput,
      Details:
        "Human accepted completion of the already-landed merge after the exact claim attempt was tombstoned.",
    },
    projectDir,
  );
  const updated: UnitMergeTransaction = {
    ...transaction,
    released_after_git: {
      accepted_at: isoTimestamp(),
      user_input: userInput,
      tombstone_oid: tombstone.oid,
      tombstone_generation: tombstone.generation,
    },
  };
  writeUnitMergeTransaction(projectDir, updated);
  updateCachedClaim(projectDir, tombstone);
  return updated;
}

function landUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const step = flags.step ?? "all";
  const acceptReleasedAttempt =
    flags["accept-released-attempt"] === "true";
  if (
    !unit ||
    !["git", "state", "audit", "all"].includes(step) ||
    (flags.strategy !== undefined && flags.strategy !== "merge" && flags.strategy !== "pr")
  ) {
    fail(
      "Usage: aidlc-unit land <unit> [--step git|state|audit|all] [--target <branch>] " +
        "[--strategy merge|pr] [--refold] [--accept-released-attempt --user-input <human acknowledgment>]",
    );
  }
  const pd = resolveProjectDir(projectDir);
  const refold = flags.refold === "true";
  const existing = readUnitMergeTransaction(pd, unit);
  if (!existing || !["approved", "git-landed", "state-folded", "complete"].includes(existing.status)) {
    fail(`Unit "${unit}" merge is not approved.`);
  }
  let transaction: UnitMergeTransaction = existing;
  let claimCheck: PinnedClaimCheck | null = null;
  assertTransactionIdentity(pd, transaction);
  if (acceptReleasedAttempt && transaction.status !== "git-landed") {
    fail(
      `Unit "${unit}" --accept-released-attempt applies only after the git step landed and before state folding.`,
    );
  }
  if (
    transaction.status === "approved" ||
    transaction.status === "git-landed"
  ) {
    claimCheck = currentPinnedClaim(pd, transaction, {
      acceptReleasedAttempt,
    });
    if (
      claimCheck.releasedTombstone &&
      !transaction.released_after_git
    ) {
      const userInput = validateMergeRiskAcknowledgment(
        pd,
        unit,
        flags["user-input"],
      );
      transaction = recordReleasedAfterGitAcceptance(
        pd,
        transaction,
        claimCheck.releasedTombstone,
        userInput,
      );
    }
  }
  const gate = mergeGateRecord(pd, transaction);
  if (gate?.decision !== "approve") {
    fail(`Unit "${unit}" has no current approved merge-gate receipt.`);
  }
  if ((gate.strategy !== "merge" && gate.strategy !== "pr") || !gate.target) {
    fail(`Unit "${unit}" approved merge gate has invalid strategy or target evidence.`);
  }
  if (flags.strategy !== undefined && flags.strategy !== gate.strategy) {
    fail(`Unit "${unit}" merge gate approved strategy "${gate.strategy}", not "${flags.strategy}".`);
  }
  const strategy: "merge" | "pr" = gate.strategy;
  const target =
    flags.target ?? gate.target;
  if (
    target !== gate.target
  ) {
    fail(
      `Unit "${unit}" merge gate approved target "${gate.target}", not "${target}".`,
    );
  }
  transaction = {
    ...transaction,
    target_branch: gate.target,
    strategy,
  };
  // A local merge lands on the target branch of the main checkout; a
  // pull-request landing folds on the Unit's own branch, in whichever checkout
  // or worktree built it.
  if (strategy === "merge") assertMainCheckout(pd);
  if (refold) {
    // After a rebase of the open pull request: the fold is redone on the
    // rebased branch. Accepted for a completed landing, and for one whose
    // earlier refold was interrupted (its landing commit is no longer here).
    if (strategy !== "pr" || !["git-landed", "state-folded", "complete"].includes(transaction.status)) {
      fail(`Unit "${unit}" --refold re-runs the fold of a pull-request landing after a rebase.`);
    }
    const branch = currentBranch(pd);
    if (branch !== target) {
      fail(`Unit "${unit}" --refold expected branch "${target}", found "${branch || "(detached)"}".`);
    }
    const head = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve the rebased branch head");
    transaction = { ...transaction, status: "git-landed", git_commit_oid: head };
    writeUnitMergeTransaction(pd, transaction);
  }
  if (transaction.evidence.merge_held) {
    fail(
      `Unit "${unit}" merge is held. Resolve the existing HOLD-MERGE flow in the team checkout, publish, and re-pin.`,
    );
  }
  const runGitStep = step === "git" || step === "all";
  const runStateStep = step === "state" || step === "all";
  const runAuditStep = step === "audit" || step === "all";
  if (step === "state" && transaction.status === "approved") {
    fail(`Unit "${unit}" git step has not landed.`);
  }
  if (
    step === "audit" &&
    !["state-folded", "complete"].includes(transaction.status)
  ) {
    fail(`Unit "${unit}" state step has not folded.`);
  }
  if (runGitStep && transaction.status === "approved") {
    if (!claimCheck) {
      fail(`Unit "${unit}" git landing has no current pinned-claim evidence.`);
    }
    const liveIntegration = fetchIntegration(pd);
    const landingBranch = currentBranch(pd);
    if (landingBranch !== target) {
      fail(`Unit landing expected branch "${target}", found "${landingBranch}".`);
    }
    const landingHead = gitOutput(
      pd,
      ["rev-parse", "HEAD"],
      "Cannot resolve local landing target",
    );
    // A stray file in the landing checkout's audit directory would move the
    // run floor the evidence is read against; name it as what it is first.
    if (strategy === "merge") assertCleanSourceWorktree(pd);
    if (
      !git(
        pd,
        ["merge-base", "--is-ancestor", liveIntegration.oid, landingHead],
      ).ok
    ) {
      fail(
        `Unit "${unit}" local target "${target}" is stale: fetched ` +
          `${liveIntegration.ref} at ${liveIntegration.oid}, but local HEAD is ` +
          `${landingHead}. Fast-forward or rebase "${target}", then re-run landing.`,
      );
    }
    const liveEvidence = candidateEvidence(
      pd,
      claimCheck.claim,
      transaction.candidate_base_oid,
      landingHead,
    );
    if (JSON.stringify(liveEvidence) !== JSON.stringify(transaction.evidence)) {
      fail(
        `Unit "${unit}" live integration evidence changed after merge approval; ` +
          `run aidlc unit pin ${unit} again and obtain a new merge gate.`,
      );
    }
    transaction = strategy === "pr"
      ? landPr(pd, transaction, target, landingHead)
      : landGit(pd, transaction, target);
    writeUnitMergeTransaction(pd, transaction);
  }
  if (
    runStateStep &&
    ["git-landed", "state-folded"].includes(transaction.status)
  ) {
    if (!transaction.git_commit_oid) {
      fail(`Unit "${unit}" has no validated git landing commit.`);
    }
    (strategy === "pr" ? validateLandedPr : validateLandedMerge)(
      pd,
      transaction,
      transaction.git_commit_oid,
      target,
    );
    // A pull-request landing folds on the Unit's own branch, whose state file
    // holds the Unit's walk (its Current Stage, stage markers, revision count).
    // That state is main's to own, as a merge landing keeps it: the fold is made
    // on main's copy, so the workspace pull request carries the fold and nothing
    // else of the branch's state.
    if (strategy === "pr") restoreIntegrationState(pd);
    const liveState = readStateFile(pd);
    const liveScope = getField(liveState, "Scope") ?? "";
    const liveStageColumns = unitMajorConstructionStageSlugs(
      liveScope,
      liveState,
      true,
    );
    if (liveStageColumns.length === 0) {
      fail(`Unit "${unit}" live main state has no active per-unit Construction columns.`);
    }
    transaction = {
      ...transaction,
      live_stage_columns: liveStageColumns,
      state_fold_authorized:
        transaction.state_fold_authorized ??
          (
            claimCheck
              ? {
                  authorized_at: isoTimestamp(),
                  mode: claimCheck.releasedTombstone
                    ? "released-after-git"
                    : "live-claim",
                  observed_oid:
                    claimCheck.releasedTombstone?.oid ??
                    claimCheck.claim.oid,
                  owner: claimCheck.claim.owner,
                }
              : transaction.state_fold_authorized
          ),
    };
    if (!transaction.state_fold_authorized) {
      fail(
        `Unit "${unit}" state fold has no current land-bound claim authorization.`,
      );
    }
    writeUnitMergeTransaction(pd, transaction);
    runStateFold(pd, transaction);
    transaction = { ...transaction, status: "state-folded" };
    writeUnitMergeTransaction(pd, transaction);
  }
  if (runAuditStep && transaction.status !== "complete") {
    if (!unitMergedReceipts(pd).has(unit)) {
      fail(`Unit "${unit}" state fold has no current-generation UNIT_MERGED receipt.`);
    }
    if (!mainUnitRowMerged(pd, transaction)) {
      fail(`Unit "${unit}" state fold has not applied the authoritative merged row.`);
    }
    checkpointMainMetadata(
      pd,
      `Finalize Unit ${unit} merge metadata`,
    );
    transaction = {
      ...transaction,
      status: "complete",
      ...(strategy === "pr"
        ? { landed_head_oid: gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve the landed head") }
        : {}),
    };
    writeUnitMergeTransaction(pd, transaction);
  }
  console.log(JSON.stringify({
    landed: transaction.status === "complete",
    status: transaction.status,
    unit,
    pinned_oid: transaction.pinned_oid,
    git_commit_oid: transaction.git_commit_oid ?? null,
  }));
}

function assertMainCheckout(projectDir: string): void {
  const top = git(projectDir, ["rev-parse", "--show-toplevel"]);
  const common = git(projectDir, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !common.ok) fail("Cannot resolve the main git checkout.");
  const topReal = realpathSync(top.stdout.trim());
  const commonAbs = resolve(topReal, common.stdout.trim());
  const mainReal = realpathSync(dirname(commonAbs));
  if (topReal !== mainReal) {
    fail(`This command must run from the unscoped main checkout, not sibling worktree ${topReal}.`);
  }
}

function validateClaimRefUnit(intentId8: string, unit: string): void {
  const ref = claimRef(intentId8, unit);
  const checked = spawnSync("git", ["check-ref-format", ref], {
    encoding: "utf-8",
  });
  if (checked.status !== 0) {
    fail(
      `Unit "${unit}" is not claim-ref safe; avoid '..', '.lock' endings, ` +
        "leading dots, and other git-ref-reserved forms.",
    );
  }
}

function claimOwnerLabel(projectDir: string, supplied?: string): string {
  const owner =
    supplied?.trim() ||
    git(projectDir, ["config", "user.name"]).stdout.trim() ||
    "team";
  if (/[\r\n|]/.test(owner)) {
    fail("Team labels cannot contain pipes or newlines.");
  }
  return owner;
}

function finalizeClaimCheckout(
  projectDir: string,
  stamp: UnitScopeStamp,
  claim: UnitClaimView,
): void {
  stamp.claim_oid = claim.oid;
  stamp.audit_shard = claim.payload.audit_shard;
  writeUnitScopeStamp(projectDir, stamp);
  writeClaimGeneration(projectDir, stamp.unit, stamp.generation);
  ensureCloneId(projectDir);
  updateCachedClaim(projectDir, claim);
}

interface PendingRelease {
  version: 1;
  status: "pending" | "released";
  intent_uuid: string;
  unit: string;
  claim_generation: number;
  claim_nonce: string;
  release_nonce: string;
  released_generation?: number;
  released_oid?: string;
}

function readPendingRelease(
  projectDir: string,
  unit: string,
  identity: ReturnType<typeof activeIdentity>,
): PendingRelease | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        unitReleasePendingPath(
          projectDir,
          unit,
          identity.space,
          identity.intentUuid,
        ),
        "utf-8",
      ),
    ) as Partial<PendingRelease>;
    if (
      parsed.version !== 1 ||
      (parsed.status !== "pending" && parsed.status !== "released") ||
      typeof parsed.intent_uuid !== "string" ||
      typeof parsed.unit !== "string" ||
      !Number.isInteger(parsed.claim_generation) ||
      typeof parsed.claim_nonce !== "string" ||
      typeof parsed.release_nonce !== "string"
    ) {
      return null;
    }
    return parsed as PendingRelease;
  } catch {
    return null;
  }
}

function writePendingRelease(
  projectDir: string,
  identity: ReturnType<typeof activeIdentity>,
  pending: PendingRelease,
): void {
  const path = unitReleasePendingPath(
    projectDir,
    pending.unit,
    identity.space,
    identity.intentUuid,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(pending, null, 2)}\n`,
    "utf-8",
  );
}

function adoptUnit(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit adopt <unit>");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit adoption requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const ref = claimRef(identity.intentId8, unit);
  const branch = gitOutput(
    pd,
    ["symbolic-ref", "--quiet", "HEAD"],
    "Unit adoption requires the checked-out local claim branch",
  );
  if (branch !== ref) {
    fail(`Unit adoption requires checked-out branch "${ref}", found "${branch}".`);
  }
  const existing = readUnitScopeStamp(pd);
  if (existing && existing.unit !== unit) {
    fail(`This checkout is already scoped to Unit "${existing.unit}".`);
  }
  const claim = currentClaim(pd, repositoryRemote(pd), ref);
  if (
    claim?.status !== "claimed" ||
    claim.payload.space !== identity.space ||
    claim.payload.intent_uuid !== identity.intentUuid ||
    claim.payload.intent_id8 !== identity.intentId8 ||
    claim.payload.unit !== unit ||
    claim.payload.claim_ref !== ref ||
    !claim.payload.audit_shard ||
    !/^[A-Za-z0-9._-]+\.md$/.test(claim.payload.audit_shard)
  ) {
    fail(`Unit "${unit}" checked-out claim identity or audit shard is invalid.`);
  }
  const head = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve checked-out claim");
  if (head !== claim.oid) {
    fail(`Unit adoption requires HEAD at live claim OID ${claim.oid}.`);
  }
  const checkedOut = readPayload(pd, head, { localOnly: true });
  if (
    !checkedOut ||
    checkedOut.nonce !== claim.nonce ||
    checkedOut.generation !== claim.generation ||
    checkedOut.audit_shard !== claim.payload.audit_shard
  ) {
    fail(`Unit "${unit}" checked-out claim payload does not match the live claim ref.`);
  }
  const stamp: UnitScopeStamp = {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner: claim.owner,
    generation: claim.generation,
    nonce: claim.nonce,
    claim_ref: ref,
    claim_oid: claim.oid,
    claimed_from_oid: claim.payload.base_oid,
    integration_ref: claim.payload.integration_ref,
    gate_rhythm: claim.payload.gate_rhythm,
    audit_shard: claim.payload.audit_shard,
  };
  // Publish ships the claim shard projected onto what pin accepts; the owner's
  // own commit, the claim commit's second parent, keeps every row. The working
  // copy takes the owner's shard, so the person's answers stay answered here,
  // unless this checkout has already written to it.
  const ownerHead = claim.payload.candidate_head_oid;
  const recordPrefix = relativeRecordDir(pd);
  if (ownerHead && recordPrefix) {
    const shardPath = `${recordPrefix}/audit/${claim.payload.audit_shard}`;
    const blobAt = (oid: string) => git(pd, ["rev-parse", `${oid}:${shardPath}`]).stdout;
    if (
      blobAt(ownerHead) !== blobAt("HEAD") &&
      git(pd, ["diff", "--quiet", "HEAD", "--", shardPath]).ok
    ) {
      const owners = git(pd, ["show", `${ownerHead}:${shardPath}`, "--"]);
      if (owners.ok) writeFileSync(join(pd, shardPath), owners.stdout);
    }
  }
  finalizeClaimCheckout(pd, stamp, claim);
  console.log(JSON.stringify({ adopted: true, ...stamp }));
}

function claimUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) {
    fail("Usage: aidlc-unit claim <unit> [--team <label>] [--rhythm per-stage|unit-end] [--skip-stages <stage[,stage...]>]");
  }
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  if (
    flags.rhythm !== undefined &&
    flags.rhythm !== "per-stage" &&
    flags.rhythm !== "unit-end"
  ) {
    fail(`Invalid --rhythm "${flags.rhythm}"; expected per-stage or unit-end.`);
  }
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  const skipStages = claimSkipStages(state, flags["skip-stages"]);
  const identity = activeIdentity(pd);
  validateClaimRefUnit(identity.intentId8, unit);
  const existingStamp = readUnitScopeStamp(pd);
  if (existingStamp) {
    if (existingStamp.unit !== unit) {
      const live = fetchIntegration(pd);
      if (openingStatus(pd, live.oid).completed.has(existingStamp.unit)) {
        const where = live.remote ? `${live.remote}/${live.branch}` : live.branch;
        fail(
          `Unit "${existingStamp.unit}" is merged on ${where}; run \`aidlc unit finish ${existingStamp.unit}\` ` +
            `to close this checkout's scope, then claim "${unit}".`,
        );
      }
      fail(`This checkout is already scoped to Unit "${existingStamp.unit}".`);
    }
    const recovered = currentClaim(
      pd,
      repositoryRemote(pd),
      existingStamp.claim_ref,
    );
    if (
      recovered?.status === "claimed" &&
      recovered.payload.intent_uuid === identity.intentUuid &&
      recovered.unit === unit &&
      recovered.generation === existingStamp.generation &&
      recovered.nonce === existingStamp.nonce
    ) {
      finalizeClaimCheckout(pd, existingStamp, recovered);
      console.log(JSON.stringify({ claimed: true, recovered: true, ...existingStamp }));
      return;
    }
    clearUnitScopeStamp(pd);
  }
  const integration = fetchIntegration(pd);
  const opening = openingStatus(pd, integration.oid);
  if (!opening.units.includes(unit)) fail(`Unit "${unit}" is not in the authoritative Unit DAG.`);
  if (opening.completed.has(unit)) {
    fail(`Unit "${unit}" is already complete on the integration ref.`);
  }
  const blockers = opening.blockers.get(unit) ?? [];
  if (blockers.length > 0) {
    const where = integration.remote ? `${integration.remote}/${integration.branch}` : integration.branch;
    const named = blockers.map((dep) =>
      dep === "walking-skeleton"
        ? `the walking skeleton, Unit "${opening.skeleton}", is not complete on ${where} yet`
        : `${unit} waits on ${dep}`
    );
    fail(named.join("; "));
  }
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  if (current?.status === "claimed") {
    fail(`Unit "${unit}" is already claimed by "${current.owner}".`);
  }
  const generation =
    current?.status === "released"
      ? current.generation
      : (current?.generation ?? 0) + 1;
  const nonce = randomUUID();
  const owner = claimOwnerLabel(pd, flags.team);
  // In a clone that ran the earlier phases its own shard is already on main;
  // the claim starts on the team shard its rows will travel in.
  const cloneShard = auditShardName(pd);
  const claimRecordPrefix = relativeRecordDir(pd);
  const auditShard = claimRecordPrefix
    ? teamAuditShard(pd, integration.oid, claimRecordPrefix, cloneShard, unit, generation)
    : cloneShard;
  const rhythm =
    flags.rhythm === "unit-end" || flags.rhythm === "per-stage"
      ? flags.rhythm
      : readUnitGateRhythm(state);
  const payload: UnitClaimPayload = {
    version: 1,
    status: "claimed",
    owner,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    generation,
    nonce,
    base_oid: integration.oid,
    integration_ref: integration.ref,
    claim_ref: ref,
    predecessor_oid: current?.oid ?? null,
    gate_rhythm: rhythm,
    audit_shard: auditShard,
    ...(auditShard !== cloneShard ? { clone_audit_shard: cloneShard } : {}),
  };
  const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
  const stamp: UnitScopeStamp = {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner,
    generation,
    nonce,
    claim_ref: ref,
    claim_oid: commit,
    claimed_from_oid: integration.oid,
    integration_ref: integration.ref,
    gate_rhythm: rhythm,
    audit_shard: auditShard,
  };
  // Persist the intended claim before the CAS. A process killed after the push
  // can validate this nonce on retry and finish without creating a new attempt.
  writeUnitScopeStamp(pd, stamp);
  const pushed = updateClaimRef(pd, integration.remote, ref, commit, current?.oid ?? null);
  if (!pushed.ok) {
    clearUnitScopeStamp(pd);
    const winner = currentClaim(pd, integration.remote, ref);
    if (winner?.status === "claimed") fail(`Unit "${unit}" claim lost to "${winner.owner}".`);
    if (pushed.refused) {
      fail(`Unit "${unit}" claim was rejected by ${integration.remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" claim compare-and-swap failed.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const winner = currentClaim(pd, integration.remote, ref);
  if (!winner || winner.nonce !== nonce) {
    clearUnitScopeStamp(pd);
    fail(`Unit "${unit}" claim verification failed; current holder is "${winner?.owner ?? "unknown"}".`);
  }
  finalizeClaimCheckout(pd, stamp, winner);
  skipStagesAtClaim(pd, unit, skipStages);
  console.log(JSON.stringify({
    claimed: true,
    ...stamp,
    ...(skipStages.length > 0 ? { skipped_stages: skipStages } : {}),
  }));
}

// `claim --skip-stages`: the Unit's per-Unit Construction stages the person
// leaves out for this Unit, in plan order. Checked before anything is claimed:
// each must be one of the plan's per-Unit Construction stages, and Code
// Generation stays, since it is the work the Unit lands.
function claimSkipStages(state: string, raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const named = raw.split(",").map((slug) => slug.trim()).filter(Boolean);
  if (named.length === 0) fail("--skip-stages needs at least one stage, comma-separated.");
  const planned = unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true);
  for (const slug of named) {
    if (slug === "code-generation") {
      fail("--skip-stages cannot leave out code-generation: it is the work the Unit lands. Nothing was claimed.");
    }
    if (!planned.includes(slug)) {
      fail(
        `--skip-stages names "${slug}", which is not one of this plan's per-Unit Construction stages ` +
          `(${planned.filter((stage) => stage !== "code-generation").join(", ")}). Nothing was claimed.`,
      );
    }
  }
  return planned.filter((slug) => named.includes(slug));
}

// The stages left out at claim are skipped for this Unit only, through the
// engine's own per-Unit forward jump: one UNIT_SKIPPED per stage, the walk
// starts at the first stage left in, and the other Units still owe them all.
function skipStagesAtClaim(projectDir: string, unit: string, stages: string[]): void {
  if (stages.length === 0) return;
  const jumpArgs = [
    "execute",
    "--target",
    "code-generation",
    "--direction",
    "forward",
    "--units",
    unit,
    "--stages",
    stages.join(","),
  ];
  const [command, ...args] = aidlcEngineCommand(
    "jump",
    [...jumpArgs, "--project-dir", projectDir],
    join(dirname(fileURLToPath(import.meta.url)), "aidlc-jump.ts"),
    isCompiledExecutable() ? process.execPath : null,
  );
  const result = spawnSync(command, args, { cwd: projectDir, encoding: "utf-8" });
  if (result.status !== 0) {
    fail(
      `Unit "${unit}" is claimed, but skipping ${stages.join(", ")} for it failed: ` +
        `${(result.stderr || result.stdout).trim()}. Skip them with ` +
        `\`aidlc engine jump ${jumpArgs.join(" ")}\`.`,
    );
  }
}

function releaseUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit release <unit> [--expect-nonce <claim-nonce>]");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  if (readApplicableTeamUnitScopeStamp(pd)) {
    fail("release must run from an unscoped checkout.");
  }
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit release requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  if (current?.status === "released") {
    const pending = readPendingRelease(pd, unit, identity);
    if (
      pending &&
      (
        pending.intent_uuid !== identity.intentUuid ||
        pending.unit !== unit ||
        pending.release_nonce !== current.nonce ||
        pending.claim_generation + 1 !== current.generation ||
        (
          pending.status === "released" &&
          pending.released_generation !== current.generation
        )
      )
    ) {
      fail(
        `Unit "${unit}" release recovery does not match the recorded attempt; ` +
          "refusing to acknowledge a different tombstone.",
      );
    }
    clearClaimGeneration(pd, unit);
    updateCachedClaim(pd, current);
    clearUnitOwner(pd, unit);
    if (pending?.status === "pending") {
      writePendingRelease(pd, identity, {
        ...pending,
        status: "released",
        released_generation: current.generation,
        released_oid: current.oid,
      });
    }
    console.log(JSON.stringify({
      released: true,
      recovered: true,
      unit,
      generation: current.generation,
      claim_ref: ref,
      claim_oid: current.oid,
    }));
    return;
  }
  if (current?.status !== "claimed") fail(`Unit "${unit}" has no live claim.`);
  if (flags["expect-nonce"] && flags["expect-nonce"] !== current.nonce) {
    fail(
      `Unit "${unit}" current claim nonce does not match --expect-nonce; refusing release.`,
    );
  }
  const opening = openingStatus(pd, integration.oid);
  if (opening.completed.has(unit)) {
    fail(
      `Unit "${unit}" is already complete/merged on the integration ref; release is refused.`,
    );
  }
  const priorPending = readPendingRelease(pd, unit, identity);
  if (
    priorPending?.status === "released" &&
    !flags["expect-nonce"]
  ) {
    fail(
      `Unit "${unit}" was released previously and may now be a successor claim. ` +
        `Re-run with --expect-nonce ${current.nonce} to release this exact attempt.`,
    );
  }
  if (
    priorPending?.status === "pending" &&
    (
      priorPending.intent_uuid !== identity.intentUuid ||
      priorPending.unit !== unit ||
      priorPending.claim_generation !== current.generation ||
      priorPending.claim_nonce !== current.nonce
    )
  ) {
    fail(
      `Unit "${unit}" now belongs to a different claim attempt; refusing to ` +
        "tombstone the successor during release recovery.",
    );
  }
  const pending: PendingRelease = priorPending ?? {
    version: 1,
    status: "pending",
    intent_uuid: identity.intentUuid,
    unit,
    claim_generation: current.generation,
    claim_nonce: current.nonce,
    release_nonce: randomUUID(),
  };
  const activePending = pending.status === "pending"
    ? pending
    : {
        version: 1 as const,
        status: "pending" as const,
        intent_uuid: identity.intentUuid,
        unit,
        claim_generation: current.generation,
        claim_nonce: current.nonce,
        release_nonce: randomUUID(),
      };
  writePendingRelease(pd, identity, activePending);
  const payload: UnitClaimPayload = {
    ...current.payload,
    status: "released",
    owner: "released",
    generation: current.generation + 1,
    nonce: activePending.release_nonce,
    predecessor_oid: current.oid,
  };
  const commit = createClaimCommit(pd, current.oid, payload);
  const pushed = updateClaimRef(pd, integration.remote, ref, commit, current.oid);
  if (!pushed.ok) {
    if (pushed.refused) {
      fail(`Unit "${unit}" release was rejected by ${integration.remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" release compare-and-swap failed.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const released = currentClaim(pd, integration.remote, ref);
  if (released?.status !== "released" || released.nonce !== payload.nonce) {
    fail(`Unit "${unit}" release verification failed.`);
  }
  clearUnitScopeStamp(pd);
  clearClaimGeneration(pd, unit);
  updateCachedClaim(pd, released);
  clearUnitOwner(pd, unit);
  writePendingRelease(pd, identity, {
    ...activePending,
    status: "released",
    released_generation: released.generation,
    released_oid: released.oid,
  });
  console.log(JSON.stringify({
    released: true,
    unit,
    generation: released.generation,
    claim_ref: ref,
    claim_oid: released.oid,
  }));
}

function clearUnitOwner(projectDir: string, unit: string): void {
  withAuditLock(projectDir, () => {
    const stateContent = readStateFile(projectDir);
    const lines = stateContent.split("\n");
    let changed = false;
    const updated = lines.map((line) => {
      if (!line.startsWith("|")) return line;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (
        cells.length < 2 ||
        (cells[0].toLowerCase() === "unit" &&
          cells[1].toLowerCase() === "owner") ||
        cells.every((cell) => /^-+$/.test(cell)) ||
        cells[0] !== unit
      ) {
        return line;
      }
      cells[1] = "-";
      changed = true;
      return `| ${cells.join(" | ")} |`;
    }).join("\n");
    if (changed) writeStateFile(projectDir, updated);
  });
}

function participate(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  writeFileSync(unitParticipantPath(pd), "participant\n", "utf-8");
  console.log(JSON.stringify({ participant: true }));
}

// --- Pull requests a Unit opens under strategy pr ----------------------------
//
// Code pull requests are opened before pin creates the merge journal, so their
// references live in a sibling file of the journal: gate reads the code ones,
// finish reads the workspace one.
type UnitPullRequestRecord = {
  ref: string;
  url: string;
  repo: string;
  branch: string;
  head: string;
  opened_at: string;
};

type UnitPullRequests = {
  version: 1;
  space: string;
  intent_uuid: string;
  unit: string;
  code: UnitPullRequestRecord[];
  workspace?: UnitPullRequestRecord;
  follow_up?: UnitPullRequestRecord;
};

type OpenedPullRequest = UnitPullRequestRecord & { title: string };

const WORKSPACE_REPO = ".";

const PULL_REQUEST_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

// True once the Unit's checkout opened a pull request through `unit pr`: the
// one durable sign that this Unit lands through pull requests (strategy `pr`),
// which `next` reads to name the right closing path.
export function unitLandsThroughPullRequests(projectDir: string, unit: string): boolean {
  return existsSync(unitPullRequestsPath(projectDir, unit));
}

function unitPullRequestsPath(projectDir: string, unit: string): string {
  // A subdirectory of the journal's, so the journal listing never reads it.
  return join(dirname(unitMergeTransactionPath(projectDir, unit)), "pull-requests", `${unit}.json`);
}

function readUnitPullRequests(projectDir: string, unit: string): UnitPullRequests | null {
  try {
    const parsed = JSON.parse(
      readFileSync(unitPullRequestsPath(projectDir, unit), "utf-8"),
    ) as UnitPullRequests;
    const identity = activeIdentity(projectDir);
    if (
      parsed.version !== 1 ||
      parsed.unit !== unit ||
      parsed.space !== identity.space ||
      parsed.intent_uuid !== identity.intentUuid
    ) {
      return null;
    }
    return { ...parsed, code: Array.isArray(parsed.code) ? parsed.code : [] };
  } catch {
    return null;
  }
}

function writeUnitPullRequests(projectDir: string, record: UnitPullRequests): void {
  const path = unitPullRequestsPath(projectDir, record.unit);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

function emptyUnitPullRequests(projectDir: string, unit: string): UnitPullRequests {
  const identity = activeIdentity(projectDir);
  return { version: 1, space: identity.space, intent_uuid: identity.intentUuid, unit, code: [] };
}

function withoutTitle(opened: OpenedPullRequest): UnitPullRequestRecord {
  const { title: _title, ...record } = opened;
  return record;
}

// The Unit's title: the name or title cell of its row in the Units plan table;
// failing that, the directory name read as words.
function unitTitle(projectDir: string, unit: string): string {
  const strip = (text: string): string => text.replace(/`/g, "").trim();
  const fallback = strip(unit).replace(/[-_]+/g, " ").trim() || unit;
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) return fallback;
  const plan = join(projectDir, recordPrefix, "inception", "units-generation", "unit-of-work.md");
  if (!existsSync(plan)) return fallback;
  let headers: string[] = [];
  for (const line of readFileSync(plan, "utf-8").split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) {
      headers = [];
      continue;
    }
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (headers.length === 0) {
      headers = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
    if (!cells.some((cell) => cell.replace(/`/g, "").trim() === unit)) continue;
    const column = headers.findIndex((header) => /^(unit\s*)?(name|title)$/.test(header) || header === "unit");
    const candidate = column >= 0 ? strip(cells[column] ?? "") : "";
    return candidate && candidate.toLowerCase() !== unit.toLowerCase() ? candidate : fallback;
  }
  return fallback;
}

function pullRequestTemplate(repoCheckout: string): string | null {
  for (const relative of PULL_REQUEST_TEMPLATE_PATHS) {
    const path = join(repoCheckout, relative);
    if (existsSync(path)) return readFileSync(path, "utf-8");
  }
  return null;
}

// What the caller gives a pull request: `--title <text>` and `--body-file
// <path>`, each optional. The engine knows no project's conventions (a ticket
// key, a title prefix, the template's lines); a team's plugin fills them in
// and passes them here.
function pullRequestOverrides(
  flags: Record<string, string>,
  bareFlags: Set<string>,
): { title: string | null; body: string | null } {
  let title: string | null = null;
  if ("title" in flags) {
    title = bareFlags.has("title") ? "" : flags.title.trim();
    if (!title) fail("--title needs the pull request's title.");
  }
  let body: string | null = null;
  if ("body-file" in flags) {
    if (bareFlags.has("body-file") || !flags["body-file"].trim()) fail("--body-file needs a path.");
    const path = resolve(flags["body-file"]);
    if (!existsSync(path)) fail(`--body-file ${path} does not exist.`);
    body = readFileSync(path, "utf-8");
  }
  return { title, body };
}

// The body the caller gave, else the repository's own template as it stands,
// with what the engine knows appended; every heading stays for the person. A
// repository with no template, and no body given, gets the engine's section
// alone, with a notice that says so.
function pullRequestBody(
  repoCheckout: string,
  repoLabel: string,
  given: string | null,
  lines: string[],
): { body: string; notice?: string } {
  const section = `## AI-DLC Unit\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
  const base = given ?? pullRequestTemplate(repoCheckout);
  if (base === null) {
    const repository = repoLabel === WORKSPACE_REPO ? "The workspace repository" : `Repository "${repoLabel}"`;
    return {
      body: section,
      notice: `${repository} has no pull request template, so its pull request carries only the AI-DLC Unit section.`,
    };
  }
  const body = base.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return { body: body ? `${body}\n\n${section}` : section };
}

// Opens a pull request for the current branch of `repoCheckout` through `gh`;
// the branch must already be pushed, and `gh` prints the new URL.
function createPullRequest(
  repoCheckout: string,
  repoLabel: string,
  title: string,
  body: string,
  draft: boolean,
): OpenedPullRequest {
  const integration = fetchIntegration(repoCheckout);
  if (!integration.remote) fail(`${repoCheckout} has no remote to open a pull request on.`);
  const branch = git(repoCheckout, ["branch", "--show-current"]).stdout.trim();
  if (!branch || branch === integration.branch) {
    fail(`${repoCheckout} is on "${branch || "(detached)"}"; switch to the branch the pull request is for.`);
  }
  const head = gitOutput(repoCheckout, ["rev-parse", "HEAD"], `Cannot resolve HEAD in ${repoCheckout}`);
  const remoteHead = git(repoCheckout, ["ls-remote", "--heads", integration.remote, branch]).stdout.split(/\s+/)[0] ?? "";
  if (remoteHead !== head) {
    fail(`Branch "${branch}" of ${repoCheckout} is not pushed to ${integration.remote} at ${head}; push it first.`);
  }
  const bodyFile = join(tmpdir(), `aidlc-pr-${process.pid}-${Date.now()}.md`);
  writeFileSync(bodyFile, body, "utf-8");
  let created: SpawnSyncReturns<string>;
  try {
    created = spawnSync(
      ghBinary(),
      [
        "pr",
        "create",
        "--title",
        title,
        "--body-file",
        bodyFile,
        "--head",
        branch,
        "--base",
        integration.branch,
        ...(draft ? ["--draft"] : []),
      ],
      { cwd: repoCheckout, encoding: "utf-8", env: { ...process.env }, timeout: 60_000 },
    );
  } finally {
    try {
      unlinkSync(bodyFile);
    } catch {
      // Already gone.
    }
  }
  if (created.status !== 0) {
    fail(`gh pr create failed in ${repoCheckout}: ${(created.stderr ?? "").trim() || `exit ${created.status}`}.`);
  }
  const url = (created.stdout ?? "").split(/\s+/).reverse().find((token) => /\/pull\/\d+$/.test(token));
  const parsed = url ? parsePullRequestRef(url) : null;
  if (!url || !parsed) {
    fail(`gh pr create in ${repoCheckout} returned no pull request URL: ${(created.stdout ?? "").trim()}`);
  }
  return {
    ref: `${parsed.owner}/${parsed.repo}#${parsed.number}`,
    url,
    repo: repoLabel,
    branch,
    head,
    opened_at: isoTimestamp(),
    title,
  };
}

// `aidlc unit pr <unit>`: the workspace pull request after land, or with
// `--repo <name>` a code repository's pull request before gate. The title is
// `--title`, else the Unit's title; the body `--body-file`, else the
// repository's own template, or the engine's section alone when it has none.
function openPullRequest(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit pr <unit> [--repo <name>] [--draft] [--title <text>] [--body-file <path>]");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  const stamp = readApplicableTeamUnitScopeStamp(pd);
  if (!stamp || stamp.unit !== unit) {
    fail(`This checkout is not scoped to Unit "${unit}"; its pull requests are opened from the checkout that builds it.`);
  }
  const draft = flags.draft === "true";
  const repo = flags.repo;
  const transaction = readUnitMergeTransaction(pd, unit);
  const recorded = readUnitPullRequests(pd, unit) ?? emptyUnitPullRequests(pd, unit);
  const recordPrefix = relativeRecordDir(pd) ?? "";
  const overrides = pullRequestOverrides(flags, bareFlags);
  const title = overrides.title ?? unitTitle(pd, unit);
  if (repo !== undefined) {
    if (!intentRepos(pd).includes(repo)) fail(`--repo "${repo}" is not a repository this intent records.`);
    const checkout = repoDir(pd, repo);
    if (!existsSync(join(checkout, ".git"))) fail(`Code repository "${repo}" is not checked out at ${checkout}.`);
    if (transaction && ["approved", "git-landed", "state-folded", "complete", "finished"].includes(transaction.status)) {
      fail(`Unit "${unit}" merge gate already recorded its code pull requests; a later code change is a follow-up of its own.`);
    }
    const branch = git(checkout, ["branch", "--show-current"]).stdout.trim();
    const existing = recorded.code.find((entry) => entry.repo === repo && entry.branch === branch);
    if (existing) {
      console.log(JSON.stringify({ opened: true, recovered: true, unit, ...existing }));
      return;
    }
    const { body, notice } = pullRequestBody(checkout, repo, overrides.body, [
      `Unit \`${unit}\` of \`${basename(recordPrefix)}\`, code in \`${repo}\`.`,
      "The Unit's record follows in the workspace pull request once this one is merged.",
    ]);
    const opened = createPullRequest(checkout, repo, title, body, draft);
    writeUnitPullRequests(pd, { ...recorded, code: [...recorded.code, withoutTitle(opened)] });
    console.log(JSON.stringify({ opened: true, unit, ...opened, ...(notice ? { notice } : {}) }));
    return;
  }
  if (recorded.workspace) {
    console.log(JSON.stringify({ opened: true, recovered: true, unit, ...recorded.workspace }));
    return;
  }
  if (!transaction || !["complete", "finished"].includes(transaction.status)) {
    fail(`Unit "${unit}" has not landed in this checkout; run aidlc unit land ${unit} before opening the workspace pull request.`);
  }
  const { body, notice } = pullRequestBody(pd, WORKSPACE_REPO, overrides.body, [
    `Unit \`${unit}\` of \`${basename(recordPrefix)}\`: its record under \`${recordPrefix}/construction/${unit}/\`, this checkout's audit shard, and the Unit's merged row.`,
    `Code pull requests: ${recorded.code.map((entry) => entry.url).join(", ") || "none"}.`,
    `Once this merges, \`aidlc unit finish ${unit}\` closes the checkout that built it.`,
  ]);
  const opened = createPullRequest(pd, WORKSPACE_REPO, title, body, draft);
  writeUnitPullRequests(pd, { ...recorded, workspace: withoutTitle(opened) });
  console.log(JSON.stringify({ opened: true, unit, ...opened, ...(notice ? { notice } : {}) }));
}

function mainCheckoutInfo(dir: string): { isMain: boolean; top: string; mainDir: string } {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !common.ok) fail(`Cannot resolve the git checkout at ${dir}.`);
  const topReal = realpathSync(top.stdout.trim());
  const mainDir = realpathSync(dirname(resolve(topReal, common.stdout.trim())));
  return { isMain: topReal === mainDir, top: topReal, mainDir };
}

function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function ensureCommitPresent(dir: string, oid: string, remote: string | null, what: string): void {
  const present = (): boolean => git(dir, ["cat-file", "-e", `${oid}^{commit}`]).ok;
  if (present()) return;
  if (remote) git(dir, ["fetch", "--quiet", remote, oid]);
  if (present()) return;
  if (remote) git(dir, ["fetch", "--all", "--quiet"]);
  if (!present()) fail(`${what} ${oid} is not available in ${dir}; fetch it first.`);
}

function validateDriftAcknowledgment(unit: string, userInput: string | undefined): string {
  const answer = userInput?.trim();
  if (!answer) {
    fail(`Unit "${unit}" --accept-merged-drift requires --user-input <what was inspected and accepted>.`);
  }
  if (!humanPresenceGuardDisabled() && isNonAnswer(answer)) {
    fail(`Refusing Unit "${unit}" merge drift acceptance: --user-input "${answer}" is cancellation boilerplate.`);
  }
  return answer;
}

// The drift follow-up's branch: `--branch <name>` when the caller names one (a
// team's own branch convention), else `<unit>-merge-drift`.
function driftBranch(
  projectDir: string,
  unit: string,
  flags: Record<string, string>,
  bareFlags: Set<string>,
): string {
  if (!("branch" in flags)) return `${unit}-merge-drift`;
  const name = bareFlags.has("branch") ? "" : flags.branch.trim();
  if (!name) fail("--branch needs the follow-up branch's name.");
  if (!git(projectDir, ["check-ref-format", "--branch", name]).ok) fail(`--branch "${name}" is not a valid branch name.`);
  return name;
}

// `aidlc unit finish <unit>`: the Unit's pull request is merged and main
// carries exactly what land left behind; then this checkout's scope ends. A
// main checkout returns to the integration branch, a worktree is handed the
// one command that removes it.
function finishUnit(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) {
    fail(
      "Usage: aidlc-unit finish <unit> [--pr <owner>/<repo>#<n>] " +
        "[--accept-merged-drift --user-input <human acknowledgment> [--branch <name>]]",
    );
  }
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  const identity = activeIdentity(pd);
  const stamp = readUnitScopeStamp(pd);
  if (stamp && (stamp.unit !== unit || stamp.intent_uuid !== identity.intentUuid)) {
    fail(`This checkout is scoped to Unit "${stamp.unit}", not "${unit}".`);
  }
  const integration = fetchIntegration(pd);
  const existing = readUnitMergeTransaction(pd, unit);
  if (!existing || !["complete", "finished"].includes(existing.status)) {
    // Not landed from here. The scope still ends when the Unit is complete on
    // the integration ref (another checkout landed it) or this checkout's
    // claim was released or superseded; nothing is verified in that case.
    if (!stamp) {
      fail(`This checkout is not scoped to Unit "${unit}" and did not land it; nothing to finish.`);
    }
    const completed = openingStatus(pd, integration.oid).completed.has(unit);
    const live = currentClaim(pd, integration.remote, stamp.claim_ref);
    const superseded =
      live?.status !== "claimed" ||
      live.generation !== stamp.generation ||
      live.nonce !== stamp.nonce;
    if (!completed && !superseded) {
      fail(
        `Unit "${unit}" has not landed in this checkout; finish runs after aidlc unit land ${unit} ` +
          "and the merge of its pull request.",
      );
    }
    closeCheckoutScope(pd, git(pd, ["branch", "--show-current"]).stdout.trim(), {
      finished: true,
      unit,
      verified: false,
      reason: completed
        ? `Unit "${unit}" is complete on ${integration.ref}, landed from another checkout.`
        : `This checkout's claim of Unit "${unit}" was released or superseded.`,
    });
    return;
  }
  assertTransactionIdentity(pd, existing);
  let transaction = existing;
  const recorded = readUnitPullRequests(pd, unit);
  const ref = flags.pr ?? recorded?.workspace?.ref;
  if (!ref) {
    fail(
      `Unit "${unit}" has no workspace pull request on record; open it with aidlc unit pr ${unit}, ` +
        "or name it with --pr <owner>/<repo>#<n>.",
    );
  }
  const view = viewPullRequest(ref);
  if (view.state !== "MERGED" || !view.mergeCommit) {
    fail(`Pull request ${ref} is not merged (state ${view.state ?? "unknown"}).`);
  }
  const mergeCommit = view.mergeCommit;
  ensureCommitPresent(pd, mergeCommit, integration.remote, `Merge commit of ${ref}`);
  if (!git(pd, ["merge-base", "--is-ancestor", mergeCommit, integration.oid]).ok) {
    fail(`Merge commit ${mergeCommit} of ${ref} is not on ${integration.ref} at ${integration.oid}.`);
  }
  const landedHead = transaction.landed_head_oid ?? recorded?.workspace?.head ?? transaction.git_commit_oid;
  if (!landedHead) fail(`Unit "${unit}" journal records no landed head to compare with ${ref}.`);
  ensureCommitPresent(pd, landedHead, integration.remote, "Landed head");
  const base = gitOutput(
    pd,
    ["merge-base", landedHead, mergeCommit],
    `Cannot find the merge base of ${landedHead} and ${mergeCommit}`,
  );
  const drift = [...new Set([
    ...contentNotOnTip(pd, base, landedHead, mergeCommit),
    ...contentNotOnTip(pd, base, mergeCommit, landedHead),
  ])].sort();
  const accept = flags["accept-merged-drift"] === "true";
  if (drift.length > 0 && transaction.status !== "finished" && !accept) {
    fail(
      `Pull request ${ref} merged content that was not landed, at: ${drift.join(", ")}. ` +
        `Inspect it (git diff ${landedHead} ${mergeCommit} -- <path>); to accept it, run ` +
        `aidlc unit finish ${unit} --accept-merged-drift --user-input "<what you inspected and accept>".`,
    );
  }
  const unitBranch = git(pd, ["branch", "--show-current"]).stdout.trim();
  let followUp = recorded?.follow_up ?? null;
  let followUpNotice: string | null = null;
  if (drift.length > 0 && transaction.status !== "finished") {
    const userInput = validateDriftAcknowledgment(unit, flags["user-input"]);
    if (!integration.remote) fail("The drift acknowledgment needs a remote for its follow-up pull request.");
    if (git(pd, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) {
      fail(`Unit "${unit}" drift acknowledgment needs a clean tracked tree for its follow-up pull request; commit first.`);
    }
    const branch = driftBranch(pd, unit, flags, bareFlags);
    const switched = git(pd, ["switch", "-c", branch, integration.oid]);
    if (!switched.ok) fail(`Cannot create branch "${branch}" from ${integration.ref}: ${switched.stderr.trim()}`);
    appendAuditEntry(
      "UNIT_MERGE_DRIFT_ACCEPTED",
      {
        Unit: unit,
        "Pull request": view.url,
        "Merge commit OID": mergeCommit,
        "Landed head OID": landedHead,
        Paths: drift.join(", "),
        "User Input": userInput,
      },
      pd,
    );
    const recordPrefix = relativeRecordDir(pd) ?? "";
    const shard = stamp?.audit_shard ?? transaction.audit_shard;
    const shardPath = shard ? `${recordPrefix}/audit/${shard}` : `${recordPrefix}/audit`;
    git(pd, ["add", "--", shardPath]);
    const committed = git(pd, ["commit", "-m", `Acknowledge Unit ${unit} merge drift`, "--", shardPath]);
    if (!committed.ok) fail(`Cannot commit the drift acknowledgment: ${gitFailure(committed)}`);
    const pushed = git(pd, ["push", "-u", integration.remote, branch]);
    if (!pushed.ok) fail(`Cannot push "${branch}": ${pushed.stderr.trim()}`);
    const { body, notice } = pullRequestBody(pd, WORKSPACE_REPO, null, [
      `Unit \`${unit}\`: a person inspected and accepted content merged by ${view.url} that differs ` +
        `from the landed head at ${drift.map((path) => `\`${path}\``).join(", ")}.`,
      "Record-only: this pull request carries the audit row and nothing else.",
    ]);
    followUpNotice = notice ?? null;
    const opened = createPullRequest(
      pd,
      WORKSPACE_REPO,
      `${unitTitle(pd, unit)}: merge drift acknowledgment`,
      body,
      false,
    );
    followUp = withoutTitle(opened);
    writeUnitPullRequests(pd, { ...(recorded ?? emptyUnitPullRequests(pd, unit)), follow_up: followUp });
  }
  if (transaction.status !== "finished") {
    transaction = {
      ...transaction,
      status: "finished",
      finished_at: isoTimestamp(),
      merge_commit_oid: mergeCommit,
      ...(drift.length > 0 ? { merge_drift: drift } : {}),
    };
    writeUnitMergeTransaction(pd, transaction);
  }
  // The claim ref has nothing left to do once main carries the Unit: the
  // merged pull request, the audit rows and the journal are the record, and a
  // stale checkout still fails closed, with no live claim to publish or pin
  // against. Deleting it keeps the branch list to the work in flight.
  let claimRefDeleted = false;
  let claimRefNote: string | null = null;
  if (integration.remote) {
    const claimRefName = transaction.claim_ref;
    if (refTip(pd, integration.remote, claimRefName) === null) {
      claimRefDeleted = true;
    } else {
      const deleted = git(pd, ["push", integration.remote, "--delete", claimRefName]);
      claimRefDeleted = deleted.ok;
      if (!deleted.ok) {
        claimRefNote = `${claimRefName} was not deleted from ${integration.remote}: ${deleted.stderr.trim()}`;
      }
    }
    invalidateLiveClaimPayloadCache(pd, unit);
  }
  closeCheckoutScope(pd, unitBranch, {
    finished: true,
    unit,
    verified: true,
    pull_request: view.url,
    merge_commit: mergeCommit,
    drift,
    follow_up: followUp?.url ?? null,
    ...(followUpNotice ? { notice: followUpNotice } : {}),
    claim_ref_deleted: claimRefDeleted,
    ...(claimRefNote ? { claim_ref_note: claimRefNote } : {}),
  });
}

// The end of a checkout's Unit scope, however the Unit got to main. A main
// checkout returns to the integration branch, in the workspace and every
// recorded code repository; a worktree cannot delete the branches it has
// checked out, so it is handed one command that removes it, child
// repositories first.
function closeCheckoutScope(
  pd: string,
  unitBranch: string,
  result: Record<string, unknown>,
): void {
  clearUnitScopeStamp(pd);
  const checkout = mainCheckoutInfo(pd);
  const repos = intentRepos(pd).filter((repo) => existsSync(join(repoDir(pd, repo), ".git")));
  if (checkout.isMain) {
    const updated: string[] = [];
    const notes: string[] = [];
    const settle = (dir: string, label: string): void => {
      if (git(dir, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) {
        notes.push(`${label} has uncommitted changes; left as is.`);
        return;
      }
      const target = fetchIntegration(dir);
      if (git(dir, ["branch", "--show-current"]).stdout.trim() !== target.branch) {
        const switched = git(dir, ["switch", target.branch]);
        if (!switched.ok) {
          notes.push(`${label}: cannot switch to ${target.branch}: ${switched.stderr.trim()}`);
          return;
        }
      }
      const forwarded = git(dir, ["merge", "--ff-only", target.ref]);
      if (!forwarded.ok) {
        notes.push(`${label}: ${target.branch} does not fast-forward to ${target.ref}: ${forwarded.stderr.trim()}`);
        return;
      }
      updated.push(`${label} on ${target.branch} at ${gitOutput(dir, ["rev-parse", "--short", "HEAD"], "Cannot resolve HEAD")}`);
    };
    settle(pd, "workspace");
    for (const repo of repos) settle(repoDir(pd, repo), repo);
    console.log(JSON.stringify({
      ...result,
      checkout: "main",
      updated,
      notes,
      next_step: "Run `next` to pick the next Unit.",
    }));
    return;
  }
  const parts: string[] = [];
  for (const repo of repos) {
    const dir = repoDir(pd, repo);
    const info = mainCheckoutInfo(dir);
    if (info.isMain) continue; // a clone inside the worktree goes with it
    const branch = git(dir, ["branch", "--show-current"]).stdout.trim();
    parts.push(`git -C ${shellWord(info.mainDir)} worktree remove --force ${shellWord(info.top)}`);
    if (branch) parts.push(`git -C ${shellWord(info.mainDir)} branch -D ${shellWord(branch)}`);
  }
  const branches = [...new Set([unitBranch, git(pd, ["branch", "--show-current"]).stdout.trim()].filter(Boolean))];
  parts.push(`git -C ${shellWord(checkout.mainDir)} worktree remove --force ${shellWord(checkout.top)}`);
  for (const branch of branches) parts.push(`git -C ${shellWord(checkout.mainDir)} branch -D ${shellWord(branch)}`);
  console.log(JSON.stringify({ ...result, checkout: "worktree", cleanup_command: parts.join(" && ") }));
}

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const args = [...argv];
  const projectIdx = args.indexOf("--project-dir");
  if (projectIdx !== -1 && projectIdx + 1 < args.length) {
    projectDir = args[projectIdx + 1];
    args.splice(projectIdx, 2);
  }
  const command = args.shift();
  try {
    if (command === "adopt") adoptUnit(args, projectDir);
    else if (command === "claim") claimUnit(args, projectDir);
    else if (command === "release") releaseUnit(args, projectDir);
    else if (command === "participate") participate(projectDir);
    else if (command === "publish") publishUnit(args, projectDir);
    else if (command === "pin") pinUnit(args, projectDir);
    else if (command === "gate") gateUnitMerge(args, projectDir);
    else if (command === "land") landUnit(args, projectDir);
    else if (command === "pr") openPullRequest(args, projectDir);
    else if (command === "finish") finishUnit(args, projectDir);
    else if (command === "merge-status") {
      const unit = args[0];
      if (!unit) fail("Usage: aidlc-unit merge-status <unit>");
      console.log(JSON.stringify(
        readUnitMergeTransaction(resolveProjectDir(projectDir), unit),
        null,
        2,
      ));
    }
    else if (command === "status") {
      console.log(JSON.stringify(unitClaimOverview(resolveProjectDir(projectDir)), null, 2));
    } else {
      fail(
        "Usage: aidlc-unit <adopt|claim|release|participate|publish|pin|gate|land|pr|finish|merge-status|status> ...",
      );
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: errorMessage(error),
      ...(error instanceof CandidateExactPolicyError ? { candidate_exact: error.details } : {}),
    }));
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
