import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// No shell, PATH lookup, input data, credentials, or path arguments. flock is
// associated with the inherited open file description, not the helper PID.
export const ADMISSION_LEASE_HELPER = Object.freeze({
  executable: '/usr/bin/python3',
  args: Object.freeze(['-I', '-S', '-c',
    'import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)\n']),
});
export class AdmissionLeaseError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Admission lease: ${code}`); this.name = 'AdmissionLeaseError'; this.code = code; }
}
function fail(code: string): never { throw new AdmissionLeaseError(code); }
function check(value: unknown, code: string): asserts value { if (!value) fail(code); }
const owners = new Set<string>();
function owned(stat: fs.Stats, directory: boolean): void {
  check(directory ? stat.isDirectory() : stat.isFile(), 'unsafe-path');
  check(stat.uid === process.getuid?.() && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600), 'unsafe-permissions');
  if (!directory) check(stat.nlink === 1 && stat.size === 0, 'unsafe-path');
}
function rootStat(root: string): fs.Stats {
  check(typeof root === 'string' && Buffer.byteLength(root) <= 4096 && !root.includes('\0') &&
    path.isAbsolute(root) && path.normalize(root) === root && !root.endsWith(path.sep), 'unsafe-root');
  const parts = root.split(path.sep).filter(Boolean);
  check(parts.length <= 64, 'unsafe-root');
  let current = path.parse(root).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe-path');
  }
  const stat = fs.lstatSync(root); owned(stat, true); return stat;
}
function same(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** POSIX-only exclusive writer prerequisite; does not open a store or authorize intake.
 * Caller must close the store and quiesce ALL associated work before release().
 * Stable root-level lock files are deliberately NEVER unlinked, including on failure.
 * Like the store, this is not protection from hostile same-UID path replacement.
 */
export class AdmissionLease {
  private fd: number | undefined;
  private readonly file: string;
  private constructor(file: string, fd: number) { this.file = file; this.fd = fd; }

  static acquire(root: string, scope: string): AdmissionLease {
    let fd: number | undefined;
    let file: string | undefined;
    try {
      check(process.platform !== 'win32' && typeof process.getuid === 'function' &&
        typeof fs.constants.O_NOFOLLOW === 'number' && typeof fs.constants.O_DIRECTORY === 'number', 'unsupported-runtime');
      check(typeof scope === 'string' && scope.length === 64 && /^[a-f0-9]{64}$/.test(scope), 'invalid-scope');
      const initialRoot = rootStat(root);
      file = path.join(root, `${scope}.lock`);
      check(!owners.has(file), 'already-owned');
      let made = false;
      try {
        fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
        made = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        owned(fs.lstatSync(file), false);
        fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      }
      if (made) fs.fchmodSync(fd, 0o600);
      const initialFile = fs.fstatSync(fd); owned(initialFile, false);
      const namedFile = fs.lstatSync(file); owned(namedFile, false);
      check(same(initialFile, namedFile) && same(initialRoot, rootStat(root)), 'identity-changed');
      try {
        execFileSync(ADMISSION_LEASE_HELPER.executable, [...ADMISSION_LEASE_HELPER.args], {
          stdio: ['ignore', 'ignore', 'ignore', fd],
          env: { LANG: 'C', LC_ALL: 'C' }, cwd: '/', timeout: 3000,
        });
      } catch (error) {
        fail((error as { status?: number })?.status === 3 ? 'contended' : 'helper-unavailable');
      }
      // Confirm we locked the same named inode. Never delete/recreate a stale file.
      const afterFile = fs.lstatSync(file); owned(afterFile, false);
      check(same(initialFile, afterFile) && same(initialRoot, rootStat(root)), 'identity-changed');
      fs.fsyncSync(fd);
      const rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(rootFd); owned(stat, true);
        check(same(initialRoot, stat), 'identity-changed'); fs.fsyncSync(rootFd);
      } finally { try { fs.closeSync(rootFd); } catch { owners.add(file); fail('cleanup-uncertain'); } }
      const lease = new AdmissionLease(file, fd);
      owners.add(file); fd = undefined; return lease;
    } catch (error) {
      if (error instanceof AdmissionLeaseError) throw error;
      return fail('io-acquire');
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { if (file) owners.add(file); fail('cleanup-uncertain'); } }
    }
  }

  private releaseConfirmed = false;
  get retired(): boolean { return this.fd === undefined; }
  get released(): boolean { return this.releaseConfirmed; }
  get uncertain(): boolean { return this.retired && !this.releaseConfirmed; }
  release(): void {
    if (this.fd === undefined) return;
    // Do not retry an ambiguous close: the OS may already have recycled the fd.
    const fd = this.fd; this.fd = undefined;
    try { fs.closeSync(fd); this.releaseConfirmed = true; owners.delete(this.file); }
    catch { fail('io-release'); } // Retain process guard if descriptor closure is uncertain.
  }
}
