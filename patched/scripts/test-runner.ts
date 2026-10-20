#!/usr/bin/env bun
// The fork's parallel local test runner, called by test-local.sh. It runs upstream's own runner
// (tests/run-tests.ts) once per test file, in N worker checkouts of the one commit, so files run side
// by side: upstream keeps smoke and unit serial within one checkout because packaging tests regenerate
// dist/, and its CI gets parallelism the same way, from separate checkouts (docs/reference/09-testing.md,
// "What stays serial"). Each job keeps upstream's tier semantics: the file is picked with --exclude, not
// --filter, because a --filter makes a file an explicit selection (an optional skip becomes a failure).
//
// The queue runs the smoke files and the Claude preflight (t19) first, then the tests tied to the
// series' patches, then the rest. Every failure that stays a failure after its retry is appended to
// events.jsonl in the run directory as it happens; `watch` turns that file into one line per event for
// an agent's Monitor. patched/RUNBOOK.md section 1b says how an agent drives a run.
//
//   bun test-runner.ts plan  --repo <checkout> [selection]           print the queue and patch mapping
//   bun test-runner.ts run   --repo <checkout> --run-dir <dir> [selection] [run options]
//   bun test-runner.ts watch <run-dir>                               follow a run's events, exit at its end
//
// selection: --patches 07,12  --patch-tests-only  --only <regex>  --tiers smoke,unit,integration
// run options: --workers N  --stop-on-first  --max-failures N  --known <file>  --timings <file>  --real-home
//              --check (run `bun run check` in --repo beside the tests; the workers are all fresh checkouts)
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

type Tier = "smoke" | "unit" | "integration";
type Group = "gate" | "own" | "near" | "wide" | "rest";
type Status = "PASS" | "FAIL" | "SKIP";

interface TestFile {
  path: string; // repository-relative
  tier: Tier;
  legacy: string; // upstream's name for it inside a one-tier run
  qualified: string; // <tier>-<legacy>, as upstream's matcher knows it
  name: string; // upstream's summary name in a whole --ci run (qualified only on a cross-tier collision)
}
interface Patch { id: string; sha: string; subject: string; own: string[]; sources: string[] }
interface Link { patch: string; group: "own" | "near" | "wide" }
interface Job { files: TestFile[]; tier: Tier; group: Group; score: number; seconds: number }
interface FileResult {
  name: string; path: string; tier: Tier; status: Status; assertions: number; failed: number;
  seconds: number; retried: boolean; flaky: boolean; known: boolean; log?: string;
}

const GROUP_ORDER: Group[] = ["gate", "own", "near", "wide", "rest"];
// A source named by more test files than this is a hub (aidlc-lib, aidlc-orchestrate): a test naming
// it is queued after the patch's own and near tests, ranked by how specific its links are.
const NEAR_MAX = 40;
// upstream's runner leaves these out of a run with no --filter (SELECTED_ONLY in tests/run-tests.ts).
const SELECTED_ONLY = /^t-(scope-run|scope-host|guard-matrix)-/;
// Stems too common to tie a test to a change; such a file is matched by its path alone.
const GENERIC_STEMS = new Set(["index", "readme", "skill", "manifest", "plugin", "package", "emit", "types", "utils", "fills", "agents", "claude", "settings", "hooks", "tools"]);
const TAIL_LINES = 40;

// ---------- arguments ----------

const [command, ...rest] = process.argv.slice(2);
const opts: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const key = a.slice(2);
  if (["stop-on-first", "patch-tests-only", "real-home", "json", "keep-workers", "check"].includes(key)) opts[key] = true;
  else opts[key] = rest[++i] ?? die(`--${key} needs a value`);
}
function die(message: string): never { process.stderr.write(`test-runner: ${message}\n`); process.exit(2); }
const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);

if (command === "watch") process.exit(await watch(positional[0] ?? die("watch needs a run directory")));
if (command !== "plan" && command !== "run") die("usage: test-runner.ts plan|run|watch ...");

const REPO = str("repo") ?? die("--repo <checkout> is required");
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) die(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};
const COMMIT = git("rev-parse", "HEAD").trim();
const COMMON = git("rev-parse", "--path-format=absolute", "--git-common-dir").trim();
const tiers = (str("tiers") ?? "smoke,unit,integration").split(",") as Tier[];

// ---------- the test inventory, named as upstream's summary names it ----------

function inventory(): TestFile[] {
  const out: Omit<TestFile, "name">[] = [];
  for (const tier of ["smoke", "unit", "integration"] as Tier[]) {
    const dir = join(REPO, "tests", tier);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort()) {
      if (tier === "integration" && SELECTED_ONLY.test(f)) continue;
      const legacy = f.replace(/\.test\.ts$/, "");
      out.push({ path: `tests/${tier}/${f}`, tier, legacy, qualified: `${tier}-${legacy}` });
    }
    if (tier !== "integration" || !existsSync(join(REPO, "plugins"))) continue;
    for (const p of readdirSync(join(REPO, "plugins")).sort()) {
      const dir2 = join(REPO, "plugins", p, "tests");
      if (!existsSync(dir2)) continue;
      for (const f of readdirSync(dir2).filter((f) => f.endsWith(".test.ts")).sort()) {
        const legacy = `plugin-${p}-${f.replace(/\.test\.ts$/, "")}`;
        out.push({ path: `plugins/${p}/tests/${f}`, tier, legacy, qualified: `plugins-${legacy}` });
      }
    }
  }
  const count = new Map<string, number>();
  for (const f of out) count.set(f.legacy, (count.get(f.legacy) ?? 0) + 1);
  return out.map((f) => ({ ...f, name: count.get(f.legacy)! > 1 ? f.qualified : f.legacy }));
}

// ---------- the series and the tests tied to each patch ----------

function series(): Patch[] {
  const upstream = spawnSync("git", ["rev-parse", "--verify", "-q", "refs/remotes/upstream/main"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  if (!upstream) return [];
  const ids = new Map<string, string>();
  const notes = spawnSync("git", ["show", `${COMMIT}:patched/PATCHES.md`], { cwd: REPO, encoding: "utf8" }).stdout ?? "";
  for (const m of notes.matchAll(/^\| (\d{2}) \| ([^|]+?) \|/gm)) if (!ids.has(m[2])) ids.set(m[2], m[1]);
  const commits = git("log", "--reverse", "--format=%H%x09%s", COMMIT, "--not", upstream).trim().split("\n").filter(Boolean);
  const patches: Patch[] = [];
  commits.forEach((line, i) => {
    const [sha, subject] = line.split("\t");
    if (/^(patched|fork):/.test(subject)) return;
    const changed = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).trim().split("\n").filter(Boolean);
    patches.push({
      id: ids.get(subject) ?? `s${String(i + 1).padStart(2, "0")}`, sha, subject,
      own: changed.filter((p) => /\.test\.ts$/.test(p)),
      sources: changed.filter((p) => !/\.test\.ts$/.test(p) && !/^(docs|patched)\//.test(p) && !/^(CHANGELOG|README)/.test(p)),
    });
  });
  return patches;
}

function needles(path: string): string[] {
  const out = [path];
  const harness = path.match(/^tests\/(harness|lib)\/(.+)\.ts$/);
  if (harness) return [...out, `${harness[1]}/${harness[2]}`];
  const fixture = path.match(/^tests\/fixtures\/([^/]+)/);
  if (fixture) return [...out, `fixtures/${fixture[1]}`];
  const stem = basename(path).replace(/\.[^.]+$/, "");
  if (!GENERIC_STEMS.has(stem.toLowerCase()) && (stem.includes("-") || stem.length >= 10)) out.push(stem);
  return out;
}

function links(files: TestFile[], patches: Patch[]): Map<string, { links: Link[]; score: number }> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const text = new Map(files.map((f) => [f.path, readFileSync(join(REPO, f.path), "utf8")]));
  const refCache = new Map<string, string[]>();
  const refs = (source: string) => {
    if (refCache.has(source)) return refCache.get(source)!;
    const res = needles(source).map((n) => new RegExp(`(?<![A-Za-z0-9_-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`));
    const hit = files.filter((f) => f.path !== source && res.some((re) => re.test(text.get(f.path)!))).map((f) => f.path);
    refCache.set(source, hit);
    return hit;
  };
  const out = new Map<string, { links: Link[]; score: number }>();
  const add = (path: string, link: Link, score: number) => {
    const e = out.get(path) ?? { links: [], score: 0 };
    const prior = e.links.find((l) => l.patch === link.patch);
    if (!prior) e.links.push(link);
    else if (GROUP_ORDER.indexOf(link.group) < GROUP_ORDER.indexOf(prior.group)) prior.group = link.group;
    e.score += score;
    out.set(path, e);
  };
  for (const p of patches) {
    for (const t of p.own) if (byPath.has(t)) add(t, { patch: p.id, group: "own" }, 10);
    for (const s of p.sources) {
      const hit = refs(s);
      for (const t of hit) add(t, { patch: p.id, group: hit.length <= NEAR_MAX ? "near" : "wide" }, 1 / hit.length);
    }
  }
  return out;
}

// ---------- timings: this machine's parallel runs, then its last serial run, then upstream's CI weights ----------

function timings(): Map<string, number> {
  const t = new Map<string, number>();
  const file = str("timings") ?? join(COMMON, "aidlc-test-timings.json");
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) t.set(k, Number(v));
  } catch { /* first run on this machine */ }
  try {
    const summary = readFileSync(join(COMMON, "aidlc-last-full-run", "summary.txt"), "utf8");
    for (const row of summaryRows(summary)) if (!t.has(row.name)) t.set(row.name, row.seconds);
  } catch { /* none */ }
  for (const [rel, platform] of [["tests/unit-shard-weights.json", true], ["tests/integration-weights.json", false]] as const) {
    try {
      const w = JSON.parse(readFileSync(join(REPO, rel), "utf8"));
      const table = { ...w.weights, ...(platform ? w.platformWeights?.[process.platform] ?? {} : {}) };
      for (const [k, v] of Object.entries(table)) {
        const name = k.replace(/\.test\.ts$/, "");
        if (!t.has(name)) t.set(name, Number(v));
      }
    } catch { /* none */ }
  }
  return t;
}

function summaryRows(text: string): { name: string; status: Status; assertions: number; failed: number; seconds: number }[] {
  const rows = [];
  let inRows = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Per-file results:")) { inRows = true; continue; }
    if (line.startsWith("Totals:") || (inRows && line === "")) { if (rows.length) break; continue; }
    const m = inRows && line.match(/^\s+(\S+)\s+(PASS|FAIL|SKIP)\s+(\d+)\s+(\d+)\s+([\d.]+)s/);
    if (m) rows.push({ name: m[1], status: m[2] as Status, assertions: +m[3], failed: +m[4], seconds: +m[5] });
  }
  return rows;
}

// ---------- the queue ----------

const workersOpt = Number(str("workers") ?? Math.max(1, Math.min(8, availableParallelism() - 4)));
// How much slower a file runs beside N-1 others on this Mac (RUNBOOK section 1b): 8 was measured on the
// patch tests (heavy CLI files: 1.9; light files measured 1.17); 4 and 12 assume the CPU is the limit.
const SLOWDOWN: Record<number, number> = { 1: 1, 4: 1.4, 8: 1.9, 12: 2.7 };
const slowdownFor = (n: number) => {
  const keys = Object.keys(SLOWDOWN).map(Number).sort((a, b) => a - b);
  const k = keys.filter((x) => x <= n).pop() ?? 1;
  return SLOWDOWN[k];
};


function plan() {
  const all = inventory().filter((f) => tiers.includes(f.tier));
  const only = str("only") ? new RegExp(str("only")!) : null;
  const files = only ? all.filter((f) => only.test(f.name) || only.test(basename(f.path))) : all;
  // Integration files need t19's verdict on the Claude gate (see runJob), so it comes with them.
  const t19 = all.find((f) => f.path === "tests/integration/t19.test.ts");
  if (t19 && !files.includes(t19) && files.some((f) => f.tier === "integration")) files.unshift(t19);
  let patches = series();
  const wanted = str("patches")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted) {
    const unknown = wanted.filter((w) => !patches.some((p) => p.id === w || p.sha.startsWith(w)));
    if (unknown.length) die(`no patch ${unknown.join(", ")} in the series of ${COMMIT.slice(0, 9)} (ids: ${patches.map((p) => p.id).join(" ")})`);
    patches = patches.filter((p) => wanted.some((w) => p.id === w || p.sha.startsWith(w)));
  }
  const linked = links(inventory(), patches);
  const time = timings();
  const seconds = (f: TestFile) => time.get(f.name) ?? time.get(f.legacy) ?? 5;
  const groupOf = (f: TestFile): Group => {
    if (f.tier === "smoke" || f.path === "tests/integration/t19.test.ts") return "gate";
    const l = linked.get(f.path);
    if (!l) return "rest";
    return l.links.map((x) => x.group).sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))[0];
  };
  // Upstream's own affinity: t238 hands its compiled binary to t249 within one runner invocation.
  const affinity: string[][] = (() => {
    try { return JSON.parse(readFileSync(join(REPO, "tests/unit-shard-weights.json"), "utf8")).affinityGroups ?? []; } catch { return []; }
  })();
  const jobs: Job[] = [];
  const taken = new Set<string>();
  for (const f of files) {
    if (taken.has(f.path)) continue;
    const group = affinity.find((g) => f.tier === "unit" && g.includes(basename(f.path)));
    const members = group
      ? files.filter((x) => x.tier === "unit" && group.includes(basename(x.path)))
      : [f];
    for (const m of members) taken.add(m.path);
    const g = members.map(groupOf).sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))[0];
    jobs.push({
      files: members, tier: f.tier, group: g,
      score: Math.max(...members.map((m) => linked.get(m.path)?.score ?? 0)),
      seconds: members.reduce((s, m) => s + seconds(m), 0),
    });
  }
  // Gate first (smoke, then t19). Then own and near shortest first, so most of the patch verdicts are in
  // within minutes, except a file longer than half the group's share per worker, which starts at once
  // so it does not end the group. Then wide by how tightly a test is tied to the change, and the rest
  // longest first.
  const patchSeconds = jobs.filter((j) => j.group === "own" || j.group === "near").reduce((n, j) => n + j.seconds, 0);
  const LONG_SECONDS = Math.max(120, patchSeconds / workersOpt / 2);
  jobs.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g) return g;
    if (a.group === "gate") return a.tier === b.tier ? b.seconds - a.seconds : a.tier === "smoke" ? -1 : 1;
    if (a.group === "own" || a.group === "near") {
      const la = a.seconds > LONG_SECONDS, lb = b.seconds > LONG_SECONDS;
      if (la !== lb) return la ? -1 : 1;
      return la ? b.seconds - a.seconds : a.seconds - b.seconds;
    }
    if (a.group === "wide" && a.score !== b.score) return b.score - a.score;
    return b.seconds - a.seconds;
  });
  const queue = opts["patch-tests-only"] ? jobs.filter((j) => j.group === "gate" || j.group === "own" || j.group === "near") : jobs;
  return { patches, linked, jobs: queue, complete: !only && !wanted && !opts["patch-tests-only"] && tiers.length === 3 };
}

function simulate(jobs: Job[], workers: number, slowdown: number) {
  const free = Array(workers).fill(0);
  const ends: Record<string, number> = {};
  let gateEnd = 0;
  for (const j of jobs) {
    if (j.group === "gate" && j.tier === "smoke") {
      const i = free.indexOf(Math.min(...free));
      free[i] += j.seconds * slowdown;
      gateEnd = Math.max(gateEnd, free[i]);
      ends.gate = gateEnd;
      continue;
    }
    for (let i = 0; i < free.length; i++) free[i] = Math.max(free[i], gateEnd);
    const i = free.indexOf(Math.min(...free));
    free[i] += j.seconds * slowdown;
    ends[j.group] = Math.max(ends[j.group] ?? 0, free[i]);
  }
  return { total: Math.max(...free), ends };
}

const mins = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);
const planned = plan();
const label = (f: TestFile) => {
  const l = planned.linked.get(f.path);
  return l ? l.links.slice(0, 6).map((x) => `${x.patch}${x.group === "own" ? "*" : x.group === "near" ? "" : "~"}`).join(",") : "";
};

if (command === "plan") {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(planned.jobs.map((j) => ({ group: j.group, tier: j.tier, seconds: j.seconds, files: j.files.map((f) => f.name) })), null, 2)}\n`);
    process.exit(0);
  }
  process.stdout.write(`Series of ${COMMIT.slice(0, 9)}: ${planned.patches.length} patches.\n`);
  for (const p of planned.patches) {
    const tied = [...planned.linked.entries()].filter(([, v]) => v.links.some((l) => l.patch === p.id));
    const n = (g: string) => tied.filter(([, v]) => v.links.some((l) => l.patch === p.id && l.group === g)).length;
    process.stdout.write(`  ${p.id} ${p.sha.slice(0, 9)} own ${String(n("own")).padStart(2)}  near ${String(n("near")).padStart(3)}  wide ${String(n("wide")).padStart(3)}  ${p.subject.slice(0, 70)}\n`);
  }
  const by = (g: Group) => planned.jobs.filter((j) => j.group === g);
  process.stdout.write(`\nQueue: ${planned.jobs.length} jobs: ${GROUP_ORDER.map((g) => `${g} ${by(g).length}`).join(", ")}.\n`);
  for (const n of [1, 4, 8, 12, workersOpt].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)) {
    const s = simulate(planned.jobs, n, slowdownFor(n));
    process.stdout.write(`  ${String(n).padStart(2)} workers: own tests done after ${mins(s.ends.own ?? 0)}, near after ${mins(Math.max(s.ends.own ?? 0, s.ends.near ?? 0))}, all done after ${mins(s.total)}\n`);
  }
  process.stdout.write(`\nQueue order (group tier seconds name [patches: * own, ~ wide]):\n`);
  for (const j of planned.jobs) for (const f of j.files) {
    process.stdout.write(`  ${j.group.padEnd(5)} ${j.tier.padEnd(11)} ${String(Math.round(j.seconds)).padStart(5)}  ${f.name}  ${label(f)}\n`);
  }
  process.exit(0);
}

// ---------- run ----------

const RUN_DIR = str("run-dir") ?? die("--run-dir is required");
mkdirSync(join(RUN_DIR, "logs"), { recursive: true });
const EVENTS = join(RUN_DIR, "events.jsonl");
const STOP_FILE = join(RUN_DIR, "STOP");
const known = new Set(
  (() => { try { return readFileSync(str("known") ?? "/dev/null", "utf8"); } catch { return ""; } })()
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]),
);
const maxFailures = Number(str("max-failures") ?? 25);
const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);
const emit = (event: Record<string, unknown>) =>
  appendFileSync(EVENTS, `${JSON.stringify({ event: event.event, at: new Date().toISOString(), elapsed: elapsed(), ...event })}\n`);
const say = (line: string) => process.stdout.write(`[${mins(elapsed()).padStart(6)}] ${line}\n`);

const workers = Math.max(1, workersOpt);
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-par."));
interface Worker { id: number; src: string; tmp: string; home: string; busy?: ChildProcess }
const pool: Worker[] = [];
const results: FileResult[] = [];
let stopping: string | null = null;
let newFailures = 0;
let checkChild: ChildProcess | undefined;

const baseEnv: NodeJS.ProcessEnv = { ...process.env, AIDLC_TEST_PACKAGE_READY: "1" };
for (const k of Object.keys(baseEnv)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete baseEnv[k];
baseEnv.BUN_INSTALL_CACHE_DIR ??= join(homedir(), ".bun", "install", "cache");

function cleanup() {
  if (checkChild?.pid) { try { process.kill(-checkChild.pid, "SIGKILL"); } catch { /* gone */ } }
  for (const w of pool) {
    if (w.busy?.pid) { try { process.kill(-w.busy.pid, "SIGKILL"); } catch { /* gone */ } }
    if (w.id > 0 && !opts["keep-workers"]) spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", w.src]);
  }
  if (!opts["keep-workers"]) rmSync(scratch, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    emit({ event: "stopped", reason: `the runner got ${sig}`, ...totals() });
    cleanup();
    process.exit(130);
  });
}

async function sh(cmd: string, args: string[], cwd: string, env = baseEnv) {
  return await new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function makeWorker(id: number): Promise<Worker> {
  const base = join(scratch, `w${id}`);
  const w: Worker = { id, src: id === 0 ? REPO : join(base, "src"), tmp: join(base, "tmp"), home: join(base, "home") };
  mkdirSync(w.tmp, { recursive: true });
  mkdirSync(w.home, { recursive: true });
  if (id > 0) {
    const add = await sh("git", ["-C", REPO, "worktree", "add", "--quiet", "--detach", w.src, COMMIT], REPO);
    if (add.code) throw new Error(`worker ${id}: git worktree add failed: ${add.out}`);
    const install = await sh("bun", ["install", "--frozen-lockfile"], w.src);
    if (install.code) throw new Error(`worker ${id}: bun install failed: ${install.out.slice(-2000)}`);
  }
  // --repo has its projections when test-local.sh built them; a fresh worker builds its own.
  if (id > 0 || !existsSync(join(REPO, "dist"))) {
    const pkg = await sh("bun", ["scripts/package.ts"], w.src);
    if (pkg.code) throw new Error(`worker ${id}: bun scripts/package.ts failed: ${pkg.out.slice(-2000)}`);
  }
  return w;
}

function excludeFor(job: Job): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = job.files.flatMap((f) => [basename(f.path), f.legacy, f.qualified]).map(esc);
  return `^(?!(?:${names.join("|")})$)`;
}

function tail(file: string): string {
  try {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes
    const lines = readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n");
    return lines.slice(-TAIL_LINES).join("\n");
  } catch { return ""; }
}

// The first failing case and what it expected, as bun prints them: "(fail) <case>" and "error: ...".
function firstError(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const fail = lines.find((l) => l.startsWith("(fail)"))?.replace(/^\(fail\)\s*/, "").replace(/\s*\[[\d.]+m?s\]$/, "");
  const at = lines.findIndex((l) => /^error:|timed out|Error:/.test(l));
  const err = at < 0 ? "" : [lines[at], ...lines.slice(at + 1, at + 4).filter((l) => /^(Expected|Received)/.test(l))].join(" ");
  return ([fail, err].filter(Boolean).join(": ") || lines.filter(Boolean).pop() || "").slice(0, 300);
}

// The patches a failing file is tied to, strongest tie first: its own test, then a test that names a
// file the patch changes, then one that names a hub file the patch changes.
function suspects(path: string) {
  const all = planned.linked.get(path)?.links ?? [];
  const pick = (g: Link["group"]) => all.filter((l) => l.group === g).map((l) => l.patch);
  const subject = new Map(planned.patches.map((p) => [p.id, p.subject]));
  const named = [...pick("own"), ...pick("near")];
  return {
    own: pick("own"), near: pick("near"), wide: pick("wide"),
    likely: named.slice(0, 5).map((id) => `${id} ${subject.get(id) ?? ""}`.trim()),
    short: named.length ? named.join(",") : all.length ? `hub files only: ${pick("wide").slice(0, 6).join(",")}${all.length > 6 ? ",..." : ""}` : "none",
  };
}

let claudeGateOpen: boolean | null = null;

async function runJob(w: Worker, job: Job): Promise<void> {
  const jobTmp = mkdtempSync(join(w.tmp, "job."));
  const args = ["tests/run-tests.ts", `--${job.tier}`, "--verbose", "--file-retries", "1", "--exclude", excludeFor(job)];
  // t19 is upstream's Claude preflight. A whole run closes the Claude gate once when it does not pass;
  // a job of its own would run it again before every integration file, so the gate is passed on.
  if (job.tier === "integration" && claudeGateOpen === false) args.push("--no-llm");
  const env: NodeJS.ProcessEnv = { ...baseEnv, TMPDIR: jobTmp, TMP: jobTmp, TEMP: jobTmp };
  if (!opts["real-home"]) env.HOME = w.home;
  const out = join(jobTmp, "..", `${basename(jobTmp)}.out`);
  const fd = openSync(out, "w");
  const t0 = Date.now();
  const child = spawn("bun", args, { cwd: w.src, env, stdio: ["ignore", fd, fd], detached: true });
  w.busy = child;
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  w.busy = undefined;
  closeSync(fd);
  const stdout = readFileSync(out, "utf8");
  const logRel = stdout.match(/^Verbose mode: logging to (.+)$/m)?.[1]?.trim()
    ?? stdout.match(/^Log directory: (.+)$/m)?.[1]?.trim();
  const logDir = logRel ? (logRel.startsWith("/") ? logRel : join(w.src, "tests", logRel.replace(/^tests\//, ""))) : "";
  const keep = join(RUN_DIR, "logs", job.files[0].name);
  if (logDir && existsSync(logDir)) {
    rmSync(keep, { recursive: true, force: true });
    try { renameSync(logDir, keep); } catch { cpSync(logDir, keep, { recursive: true }); rmSync(logDir, { recursive: true, force: true }); }
  } else mkdirSync(keep, { recursive: true });
  renameSync(out, join(keep, "runner.out"));
  rmSync(jobTmp, { recursive: true, force: true });
  if (stopping && code !== 0 && !existsSync(join(keep, "summary.txt"))) return; // killed by the stop

  const rows = existsSync(join(keep, "summary.txt")) ? summaryRows(readFileSync(join(keep, "summary.txt"), "utf8")) : [];
  let retries: { name: string; passedOnRetry: boolean }[] = [];
  try { retries = JSON.parse(readFileSync(join(keep, "retries.json"), "utf8")).retries ?? []; } catch { /* none */ }
  for (const f of job.files) {
    const row = rows.find((r) => r.name === f.legacy || r.name === f.name || r.name === f.qualified);
    const retry = retries.find((r) => r.name === f.legacy || r.name === f.name || r.name === f.qualified);
    const fileLog = [join(keep, `${f.legacy}.log`), join(keep, `${f.name}.log`), join(keep, `${f.qualified}.log`)].find(existsSync);
    const r: FileResult = {
      name: f.name, path: f.path, tier: f.tier,
      status: row?.status ?? "FAIL", assertions: row?.assertions ?? 0, failed: row?.failed ?? 0,
      seconds: row?.seconds ?? (Date.now() - t0) / 1000,
      retried: !!retry, flaky: !!retry?.passedOnRetry, known: known.has(f.name),
      log: fileLog ?? join(keep, "runner.out"),
    };
    if (!row) r.failed = Math.max(1, r.failed);
    results.push(r);
    if (f.path === "tests/integration/t19.test.ts") claudeGateOpen = r.status === "PASS";
    const tied = suspects(f.path);
    const text = tail(r.log!) || tail(join(keep, "runner.out"));
    if (r.status === "FAIL") {
      const kind = r.known ? "known-fail" : "fail";
      if (!r.known) newFailures++;
      emit({
        event: kind, file: f.path, name: f.name, tier: f.tier, group: job.group,
        patches: { own: tied.own, near: tied.near, wide: tied.wide }, likely: tied.likely,
        retried: r.retried, failed: r.failed, seconds: Math.round(r.seconds), error: firstError(text),
        log: r.log, runner: row ? undefined : `upstream's runner wrote no row for it (exit ${code})`, tail: text,
      });
      say(`${kind === "fail" ? "FAIL" : "fail (known)"} ${f.name} [${f.tier}; patches ${tied.short}] ${firstError(text)}`);
    } else if (r.flaky) {
      emit({ event: "flaky", file: f.path, name: f.name, tier: f.tier, log: r.log });
      say(`flaky (passed on retry) ${f.name}`);
    }
  }
}

function totals() {
  const files = results.filter((r) => r.name !== "bun-run-check");
  const by = (s: Status) => files.filter((r) => r.status === s).length;
  const check = results.find((r) => r.name === "bun-run-check")?.status;
  return {
    ...(check ? { check } : {}), files: files.length, planned: planned.jobs.reduce((n, j) => n + j.files.length, 0),
    passed: by("PASS"), skipped: by("SKIP"), failed: by("FAIL"),
    newFailures: results.filter((r) => r.status === "FAIL" && !r.known).map((r) => r.name),
    knownFailures: results.filter((r) => r.status === "FAIL" && r.known).map((r) => r.name),
    flaky: results.filter((r) => r.flaky).map((r) => r.name),
  };
}

function writeSummary(complete: boolean) {
  const t = totals();
  const lines = [
    "AI-DLC Test Run Summary (fork parallel runner)", "======================",
    `Commit: ${COMMIT}`, `Workers: ${workers}`, `Wall: ${mins(elapsed())}`, `Complete: ${complete ? "yes" : `no${stopping ? ` (${stopping})` : ""}`}`,
    "", "Per-file results:",
    `  ${"File".padEnd(40)} Status Assertions     Failed   Duration`,
    `  ${"----".padEnd(40)} ------ ----------     ------   --------`,
    ...results.map((r) => `  ${r.name.padEnd(40)} ${r.status.padEnd(6)} ${String(r.assertions).padStart(10)} ${String(r.failed).padStart(10)}  ${r.seconds}s`),
    "",
    ...(t.flaky.length ? ["Passed on retry (flaky: fix these):", ...t.flaky.map((n) => `  ${n}`), ""] : []),
    "Totals:", `  Test files: ${t.files} of ${t.planned}`, `  Failed files: ${t.failed}`, `  New failures: ${t.newFailures.length}`,
    `  Skipped files: ${t.skipped}`, ...(t.check ? [`  bun run check: ${t.check}`] : []),
    `  Result: ${t.newFailures.length === 0 && !stopping ? "PASS" : "FAIL"}`, "",
  ];
  writeFileSync(join(RUN_DIR, "summary.txt"), lines.join("\n"));
  // Keep this machine's timings for the next run's order and estimate, as one file alone would take
  // (the estimate applies the slowdown itself).
  const file = join(COMMON, "aidlc-test-timings.json");
  const alone = slowdownFor(workers);
  let table: Record<string, number> = {};
  try { table = JSON.parse(readFileSync(file, "utf8")); } catch { /* new */ }
  for (const r of results) if (r.status !== "SKIP" || r.seconds > 0) table[r.name] = Math.round((r.seconds / alone) * 10) / 10;
  try { writeFileSync(file, `${JSON.stringify(table, null, 1)}\n`); } catch { /* not essential */ }
}

function writeStatus(running: Map<number, Job>, remaining: number) {
  writeFileSync(join(RUN_DIR, "status.json"), `${JSON.stringify({
    commit: COMMIT, workers, elapsed: elapsed(), remainingJobs: remaining,
    running: [...running.values()].map((j) => j.files[0].name), ...totals(), stopping,
  }, null, 1)}\n`);
}

// ---- main loop ----
writeFileSync(join(RUN_DIR, "plan.txt"), planned.jobs.map((j) => `${j.group}\t${j.tier}\t${Math.round(j.seconds)}\t${j.files.map((f) => f.name).join(" ")}`).join("\n"));
const est = simulate(planned.jobs, workers, slowdownFor(workers));
emit({
  event: "start", commit: COMMIT, workers, jobs: planned.jobs.length,
  patchTests: planned.jobs.filter((j) => j.group === "own" || j.group === "near").length,
  estimate: { patchTestsDone: mins(Math.max(est.ends.own ?? 0, est.ends.near ?? 0)), allDone: mins(est.total) },
  runDir: RUN_DIR,
});
say(`${planned.jobs.length} jobs on ${workers} workers; estimate ${mins(est.total)}; events: ${EVENTS}`);
try {
  // With --check, --repo runs `bun run check` (about 7 min, and it rewrites dist/) and is no worker.
  const first = opts.check ? 1 : 0;
  const made = await Promise.all(Array.from({ length: workers }, (_, i) => makeWorker(i + first)));
  pool.push(...made);
} catch (error) {
  emit({ event: "stopped", reason: String(error), ...totals() });
  say(String(error));
  cleanup();
  process.exit(1);
}
say(`workers ready (${pool.length})`);

const checkDone: Promise<void> = !opts.check ? Promise.resolve() : (async () => {
  const log = join(RUN_DIR, "check.log");
  const fd = openSync(log, "w");
  const t0 = Date.now();
  checkChild = spawn("bun", ["run", "check"], { cwd: REPO, env: baseEnv, stdio: ["ignore", fd, fd], detached: true });
  const code = await new Promise<number>((resolve) => checkChild!.on("close", (c) => resolve(c ?? 1)));
  closeSync(fd);
  checkChild = undefined;
  if (stopping && code !== 0) return;
  const r: FileResult = {
    name: "bun-run-check", path: "package.json", tier: "smoke", status: code === 0 ? "PASS" : "FAIL",
    assertions: 0, failed: code === 0 ? 0 : 1, seconds: (Date.now() - t0) / 1000, retried: false, flaky: false, known: false, log,
  };
  results.push(r);
  if (code === 0) { say(`bun run check passed (${mins(r.seconds)})`); return; }
  newFailures++;
  const text = tail(log);
  emit({ event: "fail", file: "package.json", name: r.name, tier: "check", group: "gate", patches: { own: [], near: [], wide: [] }, likely: [], retried: false, failed: 1, seconds: Math.round(r.seconds), error: `bun run check (package, determinism, typecheck, lint) failed: ${text.split("\n").filter(Boolean).pop() ?? ""}`.slice(0, 300), log, tail: text });
  say(`FAIL bun run check: see ${log}`);
  if (opts["stop-on-first"]) stop("--stop-on-first: bun run check failed");
})();

const queue = [...planned.jobs];
const running = new Map<number, Job>();
const groupLeft = new Map<Group, number>();
for (const j of queue) groupLeft.set(j.group, (groupLeft.get(j.group) ?? 0) + 1);
let lastStatus = 0;

function nextJob(): Job | undefined {
  // Nothing past the gate starts before the smoke files and t19 are done: upstream stops after a
  // smoke failure, and integration jobs need t19's verdict on the Claude gate.
  const gateRunning = [...running.values()].some((j) => j.group === "gate");
  const head = queue[0];
  if (!head) return undefined;
  if (head.group !== "gate" && gateRunning) return undefined;
  return queue.shift();
}

function stop(reason: string) {
  if (stopping) return;
  stopping = reason;
  queue.length = 0;
  for (const c of [...pool.map((w) => w.busy), checkChild]) if (c?.pid) { try { process.kill(-c.pid, "SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => { for (const w of pool) if (w.busy?.pid) { try { process.kill(-w.busy.pid, "SIGKILL"); } catch { /* gone */ } } }, 5000).unref();
  say(`stopping: ${reason}`);
}

await new Promise<void>((resolveAll) => {
  const tick = () => {
    if (existsSync(STOP_FILE)) stop(`stopped by ${STOP_FILE}`);
    for (const w of pool) {
      if (w.busy || running.has(w.id)) continue;
      const job = nextJob();
      if (!job) break;
      running.set(w.id, job);
      runJob(w, job).catch((e) => say(`runner error on ${job.files[0].name}: ${e}`)).finally(() => {
        running.delete(w.id);
        groupLeft.set(job.group, groupLeft.get(job.group)! - 1);
        if (job.group === "gate" && groupLeft.get("gate") === 0 && newFailures > 0 && results.some((r) => r.tier === "smoke" && r.status === "FAIL" && !r.known)) {
          stop("a smoke file failed (upstream's runner stops there too)");
        }
        if ((job.group === "own" || job.group === "near") && (groupLeft.get("own") ?? 0) === 0 && (groupLeft.get("near") ?? 0) === 0 && !stopping) {
          const tied = results.filter((r) => planned.linked.get(r.path)?.links.some((l) => l.group !== "wide"));
          emit({ event: "phase", phase: "patch-tests-done", files: tied.length, failed: tied.filter((r) => r.status === "FAIL" && !r.known).map((r) => r.name) });
          say(`patch tests done: ${tied.length} files, ${tied.filter((r) => r.status === "FAIL" && !r.known).length} new failures`);
          groupLeft.set("near", -1);
        }
        if (opts["stop-on-first"] && newFailures > 0) stop("--stop-on-first: a file failed");
        if (newFailures >= maxFailures) stop(`${newFailures} new failures (--max-failures ${maxFailures}); something broader is wrong`);
        const done = results.length;
        if (Date.now() - lastStatus > 30_000) {
          lastStatus = Date.now();
          say(`progress ${done}/${planned.jobs.reduce((n, j) => n + j.files.length, 0)} files, ${newFailures} new failures`);
        }
        writeStatus(running, queue.length);
        if (queue.length === 0 && running.size === 0) resolveAll();
        else tick();
      });
    }
    if (queue.length === 0 && running.size === 0) resolveAll();
  };
  tick();
  setInterval(() => { if (existsSync(STOP_FILE) && !stopping) { stop(`stopped by ${STOP_FILE}`); } }, 2000).unref();
});

await checkDone;
const complete = planned.complete && !stopping && (!opts.check || results.some((r) => r.name === "bun-run-check" && r.status === "PASS"));
writeSummary(complete);
const t = totals();
emit({ event: stopping ? "stopped" : "done", reason: stopping ?? undefined, complete, wall: mins(elapsed()), ...t, summary: join(RUN_DIR, "summary.txt") });
say(`${stopping ? "stopped" : "done"} in ${mins(elapsed())}: ${t.files} files, ${t.passed} passed, ${t.skipped} skipped, ${t.newFailures.length} new failures${t.knownFailures.length ? `, ${t.knownFailures.length} known` : ""}${t.flaky.length ? `, ${t.flaky.length} flaky` : ""}`);
cleanup();
process.exit(t.newFailures.length === 0 && !stopping ? 0 : 1);

// ---------- watch: one line per event that needs an agent, for Claude Code's Monitor ----------

async function watch(runDir: string): Promise<number> {
  const events = join(runDir, "events.jsonl");
  const cursorFile = join(runDir, ".watch-cursor");
  let offset = 0;
  try { offset = Number(readFileSync(cursorFile, "utf8")) || 0; } catch { /* from the start */ }
  for (;;) {
    let size = 0;
    try { size = statSync(events).size; } catch { /* not yet */ }
    if (size > offset) {
      const fd = openSync(events, "r");
      const buf = Buffer.alloc(size - offset);
      const { readSync } = await import("node:fs");
      readSync(fd, buf, 0, buf.length, offset);
      closeSync(fd);
      const text = buf.toString("utf8");
      const end = text.lastIndexOf("\n") + 1;
      for (const line of text.slice(0, end).split("\n").filter(Boolean)) {
        const e = JSON.parse(line);
        if (e.event === "fail") {
          const named = [...e.patches.own, ...e.patches.near];
          const tie = named.length ? `patches ${named.join(",")}` : e.patches.wide.length ? `only hub files of patches ${e.patches.wide.slice(0, 6).join(",")}` : "no patch names it";
          process.stdout.write(`FAIL ${e.name} [${e.tier}; ${tie}${e.retried ? "; failed its retry too" : ""}] ${e.error} | log: ${e.log}\n`);
        }
        else if (e.event === "start") process.stdout.write(`START ${e.jobs} jobs on ${e.workers} workers, ${e.patchTests} patch-test jobs first; estimate ${e.estimate.allDone} (patch tests ${e.estimate.patchTestsDone})\n`);
        else if (e.event === "phase") process.stdout.write(`PATCH TESTS DONE ${e.files} files, new failures: ${e.failed.join(", ") || "none"}\n`);
        else if (e.event === "done" || e.event === "stopped") {
          process.stdout.write(`${e.event.toUpperCase()} after ${e.wall ?? `${e.elapsed}s`}${e.reason ? ` (${e.reason})` : ""}: ${e.files} files, ${e.passed} passed, new failures: ${e.newFailures?.join(", ") || "none"}; known: ${e.knownFailures?.length ?? 0}; flaky: ${e.flaky?.join(", ") || "none"} | ${e.summary ?? ""}\n`);
          writeFileSync(cursorFile, String(offset + Buffer.byteLength(text.slice(0, end))));
          return 0;
        }
      }
      offset += Buffer.byteLength(text.slice(0, end));
      writeFileSync(cursorFile, String(offset));
    }
    await Bun.sleep(1000);
  }
}
