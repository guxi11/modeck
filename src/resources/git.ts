import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { checkRelativePath, LIMITS, modeError } from "../contracts/index.js";
import type { Kind } from "../contracts/index.js";
import { childPath, commitPattern, requireValue, safePath, utf8 } from "./fs.js";
import { fromFiles } from "./tree.js";
import type { FileData, Snapshot } from "./tree.js";

const execute = promisify(execFile);
export type GitSource = { readonly url: string; readonly protocol: "file" | "https" | "ssh" };

export const gitSource = async (url: string, configRoot: string | null): Promise<GitSource> => {
  if (configRoot !== null && url.startsWith("./")) {
    const path = childPath(configRoot, url.slice(2));
    await safePath(path);
    return { url: path, protocol: "file" };
  }
  if (configRoot === null && isAbsolute(url)) return { url: await safePath(url), protocol: "file" };
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw modeError("E_GIT", "Expected https/ssh URL or an explicit local Git directory"); }
  requireValue(url.length <= LIMITS.urlLength && !/\p{Cc}/u.test(url) && parsed.hostname
    && !parsed.password && !parsed.hash && !parsed.search && ["https:", "ssh:"].includes(parsed.protocol),
  "E_GIT", "Unsupported Git source URL");
  return { url, protocol: parsed.protocol === "https:" ? "https" : "ssh" };
};

export const git = async (directory: string, args: readonly string[], protocol: GitSource["protocol"] = "file",
  maxBuffer: number = LIMITS.manifestBytes, input?: Uint8Array): Promise<Buffer> => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const env = { ...inherited, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: protocol, GIT_PROTOCOL_FROM_USER: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
  try {
    const operation = execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=",
      "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", `protocol.${protocol}.allow=always`,
      "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false", "-c", "core.fsmonitor=false",
      "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "fetch.writeCommitGraph=false",
      "-c", "core.attributesFile=/dev/null", "--literal-pathspecs", ...args], {
      cwd: directory, env, encoding: "buffer", maxBuffer, timeout: LIMITS.gitTimeoutMs,
      killSignal: "SIGKILL", windowsHide: true,
    });
    operation.child.stdin?.end(input);
    const { stdout } = await operation;
    return stdout;
  } catch (error) {
    // Remote output can include credentials or attacker-controlled content.
    const code = error instanceof Error && "code" in error ? error.code : null;
    throw modeError("E_GIT", "Git command failed", { command: args[0] ?? "", exitCode: code });
  }
};

export const initGit = async (directory: string): Promise<void> => {
  await git(directory, ["init", "--quiet", "--template=", "--initial-branch=main", "--object-format=sha1"]);
};

const checkRef = (ref: string): void => {
  requireValue(ref.length <= LIMITS.refLength && (ref === "HEAD" || commitPattern.test(ref)
    || /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) && !ref.includes("..") && !ref.includes("//")
      && !ref.endsWith("/") && !ref.endsWith(".")
      && ref.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"))),
  "E_GIT", "Invalid Git ref");
};

const advertisedRef = async (directory: string, source: GitSource, ref: string): Promise<string> => {
  checkRef(ref);
  if (commitPattern.test(ref)) return ref;
  const patterns = ref === "HEAD" || ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  const output = utf8(await git(directory, ["ls-remote", "--symref", "--", source.url, ...patterns], source.protocol));
  const matches = output.split("\n").flatMap(line => {
    const match = /^([0-9a-f]{40})\t(.+)$/.exec(line);
    return match && patterns.includes(match[2]!) ? [match[2]!] : [];
  });
  const refs = [...new Set(matches)];
  requireValue(refs.length === 1, "E_GIT", refs.length ? "Ambiguous branch/tag name; use a full ref" : "Git ref is unavailable");
  return refs[0]!;
};

export const fetchCommit = async (directory: string, source: GitSource, ref: string): Promise<string> => {
  const target = await advertisedRef(directory, source, ref);
  await git(directory, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", source.url, target], source.protocol);
  const commit = utf8(await git(directory, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
  requireValue(commitPattern.test(commit), "E_GIT_COMMIT_UNAVAILABLE", "Invalid fetched Git commit");
  return commit;
};

type GitEntry = { readonly path: string; readonly mode: string; readonly oid: string; readonly bytes: number };

const entriesFrom = (bytes: Buffer): readonly GitEntry[] => utf8(bytes).split("\0").filter(Boolean).map(record => {
  const match = /^([0-9]{6}) (blob|tree|commit) ([0-9a-f]{40})\s+(-|[0-9]+)\t([\s\S]+)$/.exec(record);
  requireValue(match, "E_GIT", "Malformed Git tree output");
  const [, mode, type, oid, size, path] = match!;
  checkRelativePath(path!, false);
  requireValue(mode === "040000" && type === "tree" || ["100644", "100755"].includes(mode!) && type === "blob",
    "E_PATH", "Git resources cannot contain symlinks, gitlinks, or special entries", { path });
  const count = size === "-" ? 0 : Number(size);
  requireValue(Number.isSafeInteger(count) && count <= LIMITS.fileBytes, "E_LIMIT", "Git blob exceeds byte limit", { path });
  return { path: path!, mode: mode!, oid: oid!, bytes: count };
});

const readBlobs = async (directory: string, entries: readonly GitEntry[], maxBytes: number): Promise<readonly FileData[]> => {
  const files = entries.filter(entry => entry.mode !== "040000");
  if (!files.length) return [];
  requireValue(files.reduce((sum, file) => sum + file.bytes, 0) <= maxBytes, "E_LIMIT", "Git tree exceeds byte limit");
  const output = await git(directory, ["cat-file", "--batch"], "file", maxBytes + files.length * 128,
    Buffer.from(files.map(file => file.oid).join("\n") + "\n"));
  // Binary framing has a local cursor; blob bytes are never decoded or executed.
  let offset = 0;
  const data = files.map(file => {
    const end = output.indexOf(10, offset);
    requireValue(end >= offset, "E_GIT", "Truncated Git batch header");
    const header = output.subarray(offset, end).toString("ascii");
    requireValue(header === `${file.oid} blob ${file.bytes}`, "E_GIT", "Unexpected Git blob header");
    const start = end + 1;
    const stop = start + file.bytes;
    requireValue(stop < output.length && output[stop] === 10, "E_GIT", "Truncated Git blob");
    offset = stop + 1;
    return { path: file.path, executable: file.mode === "100755", bytes: output.subarray(start, stop) };
  });
  requireValue(offset === output.length, "E_GIT", "Trailing Git batch output");
  return data;
};

export const extractTree = async (directory: string, commit: string, path: string, kind: Kind): Promise<Snapshot> => {
  requireValue(commitPattern.test(commit), "E_GIT", "Invalid extraction commit");
  checkRelativePath(path, kind !== "rule");
  const root = path === "." ? null : entriesFrom(await git(directory, ["ls-tree", "-lz", commit, "--", path]));
  requireValue(root === null || root.length === 1 && root[0]!.path === path, "E_RESOURCE_MISSING", "Git resource path does not exist", { path });
  const entry = root?.[0];
  if (kind === "rule") {
    requireValue(entry?.mode === "100644" || entry?.mode === "100755", "E_PATH", "Rule must be a Git file");
    requireValue(entry!.bytes <= LIMITS.textFileBytes, "E_LIMIT", "Rule exceeds byte limit");
    const files = await readBlobs(directory, [{ ...entry!, path: "content.md" }], LIMITS.textFileBytes);
    return fromFiles([], files);
  }
  requireValue(!entry || entry.mode === "040000", "E_PATH", "Skill source must be a Git tree");
  const tree = entry?.oid ?? `${commit}^{tree}`;
  const entries = entriesFrom(await git(directory, ["ls-tree", "-rlzt", tree]));
  const maxEntries = LIMITS.treeEntries;
  const maxBytes = LIMITS.treeBytes;
  requireValue(entries.length <= maxEntries, "E_LIMIT", "Git tree entry limit exceeded");
  const files = await readBlobs(directory, entries, maxBytes);
  return fromFiles(entries.filter(item => item.mode === "040000").map(item => item.path), files, maxEntries, maxBytes);
};
