import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { modeError, sha256 } from "../contracts/index.js";
import { missing, safeAbsolute } from "../integration/fs.js";

const busy = (error: unknown): boolean => error instanceof Error && "code" in error
  && ["EAGAIN", "EWOULDBLOCK"].includes(String(error.code));
const unavailable = (): Error => modeError("E_CONFIG", "MCP requires working nonblocking kernel file locks; this platform or filesystem is unsupported. No unlocked fallback is used");
const canonicalPath = async (path: string): Promise<string> => {
  let ancestor = await safeAbsolute(path);
  const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...suffix.reverse()); }
    catch (error) {
      if (!missing(error) || dirname(ancestor) === ancestor) throw error;
      suffix.push(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
};
const flock = (handle: FileHandle): void => {
  // The child inherits the same open file description. Its exit leaves the parent's FD locked.
  const result = spawnSync("/usr/bin/flock", ["--nonblock", "--exclusive", "3"], {
    stdio: ["ignore", "ignore", "ignore", handle.fd], timeout: 5_000,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  if (!result.error && result.status === 0) return;
  if (!result.error && result.status === 1) throw modeError("E_BUSY", "Another MCP command holds a kernel transaction lock; wait for it to finish");
  throw unavailable();
};
const acquireFile = async (path: string): Promise<FileHandle> => {
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (process.platform === "darwin" ? 0x20 /* O_EXLOCK, omitted by Node's Darwin constants */ : 0);
  let handle: FileHandle;
  try { handle = await open(path, flags, 0o600); }
  catch (error) {
    if (busy(error)) throw modeError("E_BUSY", "Another MCP command holds a kernel transaction lock; wait for it to finish");
    throw modeError("E_INSTALL_CONFLICT", "Cannot safely open the permanent MCP kernel lock; inspect its ownership and filesystem support");
  }
  try {
    const stat = await handle.stat();
    const entry = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size !== 0
      || (stat.mode & 0o7777) !== 0o600 || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.isSymbolicLink()) {
      throw modeError("E_INSTALL_CONFLICT", "MCP kernel locks must be empty, private, singly linked regular files owned by this user");
    }
    if (process.platform === "linux") flock(handle);
    // Prove that an independent open description cannot acquire the lock, including on unsupported filesystems.
    let probe: FileHandle | undefined;
    let excluded = false;
    try {
      probe = await open(path, flags, 0o600);
      if (process.platform === "linux") {
        try { flock(probe); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "E_BUSY") excluded = true;
          else throw error;
        }
      }
    } catch (error) { if (busy(error)) excluded = true; else throw error; }
    finally { await probe?.close(); }
    if (!excluded) throw unavailable();
    const current = await lstat(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) {
      throw modeError("E_INSTALL_CONFLICT", "MCP kernel lock identity changed; refusing the transaction");
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
};
export const withMcpMutex = async <T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> => {
  if (!["darwin", "linux"].includes(process.platform) || process.getuid === undefined) throw unavailable();
  // A fixed system path shares the lock domain across HOME, TMPDIR, agents and recovery invocations.
  const directory = join(await realpath("/tmp"), `modeck-static-mcp-mutex-${process.getuid()}`);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  await safeAbsolute(directory);
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const held: FileHandle[] = [];
  try {
    const identity = await root.stat();
    if (!identity.isDirectory() || identity.uid !== process.getuid() || (identity.mode & 0o7777) !== 0o700) {
      throw modeError("E_INSTALL_CONFLICT", "The global MCP kernel lock directory must be owned by this user with mode 0700");
    }
    const keys = [...new Set(await Promise.all(paths.map(canonicalPath)))].sort();
    const verifyDirectory = async (): Promise<void> => {
      const current = await lstat(directory);
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) {
        throw modeError("E_INSTALL_CONFLICT", "The global MCP kernel lock directory changed; refusing the transaction");
      }
    };
    for (const key of keys) {
      await verifyDirectory();
      // Never unlink these files: their stable inodes are the lock identity, including after crashes.
      held.push(await acquireFile(join(directory, `${sha256(Buffer.from(key))}.lock`)));
    }
    await verifyDirectory();
    return await operation();
  } finally {
    const closed = await Promise.allSettled([...held.reverse(), root].map(handle => handle.close()));
    const failure = closed.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
};
