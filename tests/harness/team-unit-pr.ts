// Fixture for strategy `pr` (tests/integration/t329-team-unit-pr-strategy.test.ts):
// a workspace whose intent records a code repository checked out as a child
// of the workspace, a stand-in for `gh`, and GitHub's squash merge.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { intentsDirOf, seededRecordDir, seededStateFile } from "./fixtures.ts";
import {
  AUTOMATIC_GIT_MAINTENANCE_OFF,
  clone,
  git,
  makeSeed,
  tempDirs,
} from "./team-unit-merge.ts";

export const WORKSPACE_GITHUB_REPO = "acme/workspace";
export const CODE_GITHUB_REPO = "acme/svc";
export const CODE_REPO = "svc";

export const WORKSPACE_TEMPLATE = "Ticket: DEMO-0\n\n## What\n\n## Context updates\n";
export const CODE_TEMPLATE = "Ticket: DEMO-0\n\n## What\n\n## Tests\n";

export type FakeGitHub = { env: Record<string, string>; db: string };

export type PullRequestRecord = {
  url: string;
  state: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
  isDraft: boolean;
  reviewDecision: string | null;
  latestReviews: Array<{ state: string; author: { login: string } }>;
};

// The script that stands in for `gh`: `pr view` answers from a JSON file, `pr
// create` registers an open pull request for the repository the working
// directory's git config names (`fakegh.repo`) and prints its URL, as gh does.
const FAKE_GH_SCRIPT = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const dbPath = process.env.FAKE_GH_DB;
const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf-8")) : {};
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const gitOut = (gitArgs) => (spawnSync("git", gitArgs, { encoding: "utf-8" }).stdout ?? "").trim();
if (args[0] === "pr" && args[1] === "view") {
  const ref = args[2];
  const key = ref in db ? ref : \`\${flag("--repo")}#\${ref}\`;
  if (!(key in db)) { console.error(\`fake gh: no such pull request \${ref}\`); process.exit(1); }
  const fields = flag("--json");
  const record = db[key];
  console.log(JSON.stringify(fields ? Object.fromEntries(fields.split(",").map((f) => [f, record[f] ?? null])) : record));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const repo = gitOut(["config", "--get", "fakegh.repo"]);
  if (!repo) { console.error("fake gh: set git config fakegh.repo in this checkout"); process.exit(1); }
  const number = 1 + Object.keys(db).filter((k) => k.startsWith(repo + "#")).length;
  const url = \`https://github.com/\${repo}/pull/\${number}\`;
  db[\`\${repo}#\${number}\`] = {
    url, state: "OPEN", mergedAt: null, mergeCommit: null,
    headRefOid: gitOut(["rev-parse", "HEAD"]), headRefName: flag("--head") ?? "", baseRefName: flag("--base") ?? "",
    title: flag("--title") ?? "", body: readFileSync(flag("--body-file"), "utf-8"),
    isDraft: args.includes("--draft"), reviewDecision: null, latestReviews: [],
  };
  writeFileSync(dbPath, JSON.stringify(db, null, 1));
  console.log(url);
  process.exit(0);
}
console.error("fake gh: only pr view and pr create");
process.exit(1);
`;

export function fakeGitHub(): FakeGitHub {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-fake-gh-"));
  tempDirs.push(dir);
  const db = join(dir, "pulls.json");
  writeFileSync(db, "{}\n");
  const script = join(dir, "gh.ts");
  writeFileSync(script, FAKE_GH_SCRIPT);
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(bin, 0o755);
  return { env: { AIDLC_GH_BIN: bin, FAKE_GH_DB: db }, db };
}

export function pullRequest(gh: FakeGitHub, ref: string): PullRequestRecord {
  const db = JSON.parse(readFileSync(gh.db, "utf-8")) as Record<string, PullRequestRecord>;
  if (!(ref in db)) throw new Error(`fake gh has no ${ref}; known: ${Object.keys(db).join(", ")}`);
  return db[ref];
}

// GitHub's squash merge of a pull request into the remote's main, with the
// review the ruleset demands when a reviewer is named: the fake record turns
// MERGED, and APPROVED by that reviewer; without one it merged unreviewed.
export function mergePullRequest(
  gh: FakeGitHub,
  remote: string,
  branch: string,
  ref: string,
  reviewer?: string,
): string {
  const merger = clone(remote, "github");
  git(merger, ["merge", "--squash", `origin/${branch}`]);
  git(merger, ["commit", "-m", `${branch} (${ref.split("#")[1]})`]);
  git(merger, ["push", "origin", "main"]);
  const mergeCommit = git(merger, ["rev-parse", "HEAD"]);
  const db = JSON.parse(readFileSync(gh.db, "utf-8")) as Record<string, PullRequestRecord>;
  db[ref] = {
    ...db[ref],
    state: "MERGED",
    mergedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mergeCommit: { oid: mergeCommit },
    reviewDecision: reviewer ? "APPROVED" : null,
    latestReviews: reviewer ? [{ state: "APPROVED", author: { login: reviewer } }] : [],
  };
  writeFileSync(gh.db, JSON.stringify(db, null, 1));
  return mergeCommit;
}

function bareRemote(prefix: string): string {
  const remote = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(remote);
  git(remote, ["init", "--bare", "-b", "main"]);
  for (const [key, value] of Object.entries(AUTOMATIC_GIT_MAINTENANCE_OFF)) git(remote, ["config", key, value]);
  return remote;
}

// The t326 seed, plus: the intent records the code repository `svc`, checked
// out as a child of the workspace; the Unit `alpha` is renamed after a ticket
// when asked; a Units plan names the Units; pull request templates in both
// repositories unless told otherwise.
export function makePrSeed(
  options: { unit?: string; codeTemplate?: boolean; workspaceTemplate?: boolean } = {},
): { seed: string; remote: string; codeRemote: string; unit: string } {
  const unit = options.unit ?? "alpha";
  const { seed, remote } = makeSeed();
  const registryPath = join(intentsDirOf(seed), "intents.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
  registry[0].repos = [CODE_REPO];
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  writeFileSync(join(seed, ".gitignore"), `${readFileSync(join(seed, ".gitignore"), "utf-8")}/${CODE_REPO}/\n`);
  if (unit !== "alpha") {
    for (const path of [
      seededStateFile(seed),
      join(seededRecordDir(seed), "inception", "units-generation", "unit-of-work-dependency.md"),
    ]) {
      writeFileSync(path, readFileSync(path, "utf-8").replaceAll("alpha", unit));
    }
  }
  writeFileSync(
    join(seededRecordDir(seed), "inception", "units-generation", "unit-of-work.md"),
    "# Units of work\n\n| Unit ID | Name | Directory | Kind |\n| --- | --- | --- | --- |\n" +
      "| U0 | Walking skeleton | skeleton | service |\n" +
      `| U1 | Alpha service | ${unit} | service |\n` +
      "| U2 | Beta service | beta | service |\n",
  );
  if (options.workspaceTemplate !== false) {
    mkdirSync(join(seed, ".github"), { recursive: true });
    writeFileSync(join(seed, ".github", "pull_request_template.md"), WORKSPACE_TEMPLATE);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "code repository, Units plan, pull request template"]);
  git(seed, ["push", "origin", "main"]);

  const codeRemote = bareRemote("aidlc-pr-code-remote-");
  const codeSeed = mkdtempSync(join(tmpdir(), "aidlc-pr-code-seed-"));
  tempDirs.push(codeSeed);
  git(codeSeed, ["init", "-b", "main"]);
  git(codeSeed, ["config", "user.name", "main"]);
  git(codeSeed, ["config", "user.email", "main@example.test"]);
  mkdirSync(join(codeSeed, "src"));
  writeFileSync(join(codeSeed, "src", "service.ts"), 'export const service = "base";\n');
  if (options.codeTemplate !== false) {
    mkdirSync(join(codeSeed, ".github"));
    writeFileSync(join(codeSeed, ".github", "pull_request_template.md"), CODE_TEMPLATE);
  }
  git(codeSeed, ["add", "-A"]);
  git(codeSeed, ["commit", "-m", "service"]);
  git(codeSeed, ["remote", "add", "origin", codeRemote]);
  git(codeSeed, ["push", "-u", "origin", "main"]);
  git(codeRemote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { seed, remote, codeRemote, unit };
}

// The code repository checked out inside a workspace checkout, named for the
// fake gh and on a branch when asked.
export function checkoutCodeRepo(
  workspaceCheckout: string,
  codeRemote: string,
  label: string,
  branch?: string,
): string {
  const dir = join(workspaceCheckout, CODE_REPO);
  git(workspaceCheckout, ["clone", "--no-local", "--quiet", codeRemote, dir]);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  git(dir, ["config", "fakegh.repo", CODE_GITHUB_REPO]);
  if (branch) git(dir, ["switch", "-c", branch]);
  return dir;
}

// A change in the code repository, committed on its current branch and pushed.
export function pushCodeChange(codeDir: string, unit: string): string {
  writeFileSync(join(codeDir, "src", `${unit}.ts`), `export const ${unit.replace(/[^A-Za-z0-9_]/g, "_")} = "team";\n`);
  git(codeDir, ["add", "-A"]);
  git(codeDir, ["commit", "-m", `${unit}: code`]);
  const branch = git(codeDir, ["branch", "--show-current"]);
  git(codeDir, ["push", "-u", "origin", branch]);
  return git(codeDir, ["rev-parse", "HEAD"]);
}
