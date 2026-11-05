// A slice of upstream draft #2783's aidlc-workspace-repos.ts (awslabs/aidlc-workflows,
// commit a346dea3a): gitAddressKey, copied byte for byte, which the merge check
// in aidlc-unit-teams.ts uses to read a recorded checkout's repo. #2783's file
// replaces this one when it lands.

import { resolve as resolvePath } from "node:path";

// One repo however a clone spells its address: scheme, user, token, the
// default port, host case, a trailing slash and `.git` aside, so `git@host:o/r`,
// `ssh://git@host/o/r` and `https://host/o/r.git` are one. A local path or
// file:// URL is its absolute path.
export function gitAddressKey(address: string): string {
  const value = address.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  if (!/^file:\/\//i.test(value)) {
    const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(value);
    if (url) {
      const scheme = url[1].toLowerCase();
      const port = url[3] && !(url[3] === "22" && scheme.includes("ssh")) && !(url[3] === "443" && scheme === "https") &&
          !(url[3] === "80" && scheme === "http")
        ? `:${url[3]}`
        : "";
      return `${url[2].toLowerCase()}${port}${url[4] ?? ""}`;
    }
    // scp-style host:path; a one-letter "host" is a Windows drive.
    const scp = /^(?:[^@/\\]+@)?([^/\\:]{2,}):(?!\/\/)(.+)$/.exec(value);
    if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  }
  const path = /^file:\/\//i.test(value) ? decodeURIComponent(value.slice("file://".length)).replace(/^\/([a-z]:)/i, "$1") : value;
  const absolute = resolvePath(path).replace(/\\/g, "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
