// Git's own metadata files, read without a git process: a checkout's git
// directory, the repository's common one, and the main checkout of a linked
// worktree. aidlc-lib.ts and aidlc-locks.ts load this module at start: nothing
// here may import either.
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

export function canonicalPathKey(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function boundedGitMetadataText(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || pathStat.size > maxBytes) return null;
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) return null;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return null;
    }
    return bytes.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The metadata read already fails closed on any earlier error.
      }
    }
  }
}

export function singleGitMetadataLine(raw: string): string | null {
  const line = raw.replace(/\r?\n$/, "");
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    return null;
  }
  return line;
}

export function gitMetadataDirectory(worktreeDir: string): string | null {
  const marker = join(worktreeDir, ".git");
  try {
    const markerStat = lstatSync(marker);
    if (markerStat.isDirectory()) return realpathSync(marker);
    if (!markerStat.isFile()) return null;
  } catch {
    return null;
  }
  const pointerRaw = boundedGitMetadataText(marker, 8192);
  const pointerLine =
    pointerRaw === null ? null : singleGitMetadataLine(pointerRaw);
  if (pointerLine === null || !pointerLine.startsWith("gitdir: ")) {
    return null;
  }
  const pointer = pointerLine.slice("gitdir: ".length);
  if (pointer.length === 0 || pointer.includes("\0")) return null;
  const target = isAbsolute(pointer)
    ? pointer
    : resolvePath(worktreeDir, pointer);
  try {
    if (!lstatSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

export function gitCommonDirectory(gitDir: string): string | null {
  const marker = join(gitDir, "commondir");
  try {
    if (!lstatSync(marker).isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return gitDir;
    return null;
  }
  const pointerRaw = boundedGitMetadataText(marker, 8192);
  const pointerLine =
    pointerRaw === null ? null : singleGitMetadataLine(pointerRaw);
  if (
    pointerLine === null ||
    pointerLine.length === 0 ||
    pointerLine.includes("\0")
  ) {
    return null;
  }
  const target = isAbsolute(pointerLine)
    ? pointerLine
    : resolvePath(gitDir, pointerLine);
  try {
    if (!lstatSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

// The main checkout of a linked git worktree (`git worktree add`, a host's
// per-session worktree), or null for a main checkout, a separate clone, or no
// git. A worktree starts without the git-ignored per-user cursors, and until
// its own first switch it reads the ones its main checkout holds on this
// machine, so it finds the project's space and intent as the main checkout
// does. Git's own metadata files only: no git process on this hot path.
export function mainCheckoutOfWorktree(projectDir: string): string | null {
  const gitDir = gitMetadataDirectory(projectDir);
  if (gitDir === null) return null;
  const common = gitCommonDirectory(gitDir);
  if (common === null || common === gitDir || basename(common) !== ".git") return null;
  const main = dirname(common);
  return canonicalPathKey(main) === canonicalPathKey(projectDir) ? null : main;
}
