import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';

// Synchronous, local filesystem only. The caller must provide exclusive cross-process
// ownership of this private root. This is not a replay engine or a filesystem sandbox.
export const ADMISSION_LIMITS = Object.freeze({
  records: 256, snapshotBytes: 4 * 1024 * 1024, textBytes: 65536,
  media: 16, fileIdBytes: 1024, nameBytes: 255, mimeBytes: 127,
  identityBytes: 128, markerBytes: 256, noteBytes: 1024, tombstones: 32,
  transitionHeadroomBytes: 8192,
  pathComponents: 64, pathBytes: 4096,
});
export type AdmissionPhase = 'received' | 'queued' | 'dispatching' | 'active' | 'held' | 'uncertain' | 'handled' | 'acknowledged';
export interface TelegramMediaReference {
  retention: 'telegram-reference-only';
  type: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'animation' | 'sticker' | 'video_note';
  fileId: string;
  name?: string;
  mime?: string;
}
export interface AdmissionInput {
  sessionId: string;
  epoch: string;
  updateId: number;
  chatId: number;
  userId: number;
  messageId: number;
  receivedAt: number;
  text?: string;
  caption?: string;
  media: TelegramMediaReference[];
}
export interface LocalDisposition { at: number; note: string }
export interface AdmissionRecord {
  updateId: number;
  fingerprint: string;
  input: AdmissionInput | null;
  phase: AdmissionPhase;
  turnMarker?: string;
  disposition?: LocalDisposition;
}
export interface AdmissionSnapshot {
  version: 1;
  scope: string;
  generation: number;
  stopLatched: boolean;
  records: AdmissionRecord[];
}
export interface AdmissionTransition {
  updateId: number;
  phase: AdmissionPhase;
  turnMarker?: string;
  disposition?: LocalDisposition;
}
export type AdmissionWriteStage = 'write' | 'file-fsync' | 'rename' | 'directory-fsync';
export interface AdmissionStoreOptions {
  // Test-only interruption point, immediately before the named syscall. A throw
  // after rename (directory-fsync) models an ambiguous commit, not rollback.
  beforeIO?: (stage: AdmissionWriteStage) => void;
}
export class AdmissionStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Admission storage: ${code}`); this.name = 'AdmissionStoreError'; this.code = code; }
}
function fail(code: string): never { throw new AdmissionStoreError(code); }
function check(ok: unknown, code = 'invalid-schema'): asserts ok { if (!ok) fail(code); }
const phases = ['received', 'queued', 'dispatching', 'active', 'held', 'uncertain', 'handled', 'acknowledged'];
const terminal = (p: AdmissionPhase) => p === 'handled' || p === 'acknowledged';
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function object(x: unknown, required: string[], optional: string[] = []): asserts x is Record<string, any> {
  check(x !== null && typeof x === 'object' && !Array.isArray(x));
  const proto = Object.getPrototypeOf(x);
  check(proto === Object.prototype || proto === null);
  const keys = Reflect.ownKeys(x);
  check(keys.every(k => typeof k === 'string' && (required.includes(k) || optional.includes(k))));
  check(required.every(k => own(x, k)));
  check(keys.every(k => { const d = Object.getOwnPropertyDescriptor(x, k)!; return d.enumerable && own(d, 'value'); }));
}
function array(x: unknown, max: number): asserts x is any[] {
  check(Array.isArray(x) && x.length <= max);
  check(Reflect.ownKeys(x).length === x.length + 1);
  for (let i = 0; i < x.length; i++) check(own(x, String(i)) && own(Object.getOwnPropertyDescriptor(x, String(i))!, 'value'));
}
function integer(x: unknown, min = 0) { check(typeof x === 'number' && Number.isSafeInteger(x) && !Object.is(x, -0) && x >= min); }
function string(x: unknown, max: number, empty = false) {
  check(typeof x === 'string' && (empty || x.length > 0) && x.length <= max);
  check(!x.includes('\0') && Buffer.byteLength(x, 'utf8') <= max);
  // Reject unpaired UTF-16 surrogates (JSON.stringify would otherwise hide them).
  check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(x));
}
function hex(x: unknown) { check(typeof x === 'string' && x.length === 64 && /^[a-f0-9]{64}$/.test(x)); }
function validateInput(x: unknown): asserts x is AdmissionInput {
  object(x, ['sessionId', 'epoch', 'updateId', 'chatId', 'userId', 'messageId', 'receivedAt', 'media'], ['text', 'caption']);
  string(x.sessionId, 128); string(x.epoch, 128);
  integer(x.updateId); integer(x.chatId, -Number.MAX_SAFE_INTEGER); check(x.chatId !== 0);
  integer(x.userId, 1); integer(x.messageId, 1); integer(x.receivedAt);
  for (const k of ['text', 'caption']) if (own(x, k)) string(x[k], 65536, true);
  array(x.media, 16);
  for (const m of x.media) {
    object(m, ['retention', 'type', 'fileId'], ['name', 'mime']);
    check(m.retention === 'telegram-reference-only');
    check(['photo', 'document', 'audio', 'voice', 'video', 'animation', 'sticker', 'video_note'].includes(m.type));
    string(m.fileId, 1024); check(!/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(m.fileId));
    if (own(m, 'name')) { string(m.name, 255); check(!/[\\/\x00-\x1f\x7f]/.test(m.name) && m.name !== '.' && m.name !== '..'); }
    if (own(m, 'mime')) { string(m.mime, 127); check(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(m.mime)); }
  }
}
function disposition(x: unknown) { object(x, ['at', 'note']); integer(x.at); string(x.note, 1024); }
function phaseFields(x: Record<string, any>) {
  check(phases.includes(x.phase));
  if (own(x, 'turnMarker')) string(x.turnMarker, 256);
  if (terminal(x.phase)) { check(own(x, 'disposition')); disposition(x.disposition); }
  else check(!own(x, 'disposition'));
}
// Fixed encoding: recursive sorted object keys, UTF-8, no whitespace/newline.
function canonical(x: any): string {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x !== null && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
function clone<T>(x: T): T { return JSON.parse(canonical(x)); }
function fingerprint(x: AdmissionInput) { return createHash('sha256').update(canonical(x)).digest('hex'); }
function validateSnapshot(x: unknown, scope: string): asserts x is AdmissionSnapshot {
  object(x, ['version', 'scope', 'generation', 'stopLatched', 'records']);
  check(x.version === 1); hex(x.scope); check(x.scope === scope, 'wrong-scope');
  integer(x.generation); check(typeof x.stopLatched === 'boolean'); array(x.records, 256);
  let last = -1;
  for (const r of x.records) {
    object(r, ['updateId', 'fingerprint', 'input', 'phase'], ['turnMarker', 'disposition']);
    integer(r.updateId); check(r.updateId > last); last = r.updateId; hex(r.fingerprint); phaseFields(r);
    if (r.input === null) check(terminal(r.phase));
    else { validateInput(r.input); check(r.input.updateId === r.updateId && fingerprint(r.input) === r.fingerprint); }
  }
}
function osCode(e: unknown) { return (e as NodeJS.ErrnoException)?.code; }
function ownedStat(s: fs.Stats, directory: boolean) {
  check(directory ? s.isDirectory() : s.isFile(), 'unsafe-path');
  check(s.uid === process.getuid?.() && (s.mode & 0o7777) === (directory ? 0o700 : 0o600), 'unsafe-permissions');
  if (!directory) check(s.nlink === 1, 'unsafe-path');
}
const openStores = new Set<string>();

export class AdmissionStore {
  private state: AdmissionSnapshot;
  private bytes: Buffer | null;
  private poisoned = false;
  private closed = false;
  private readonly dir: string;
  private readonly file: string;
  private readonly options: AdmissionStoreOptions;

  private constructor(root: string, scope: string, options: AdmissionStoreOptions) {
    this.options = options;
    this.dir = path.join(root, scope);
    this.file = path.join(this.dir, 'snapshot.json');
    check(!openStores.has(this.dir), 'already-open');
    this.verifyRoot(root);
    let made = false;
    try { fs.mkdirSync(this.dir, { mode: 0o700 }); made = true; }
    catch (e) { if (osCode(e) !== 'EEXIST') throw e; }
    ownedStat(fs.lstatSync(this.dir), true);
    // Also retry the parent flush when reopening after an interrupted mkdir flush.
    this.flushDir(root);
    this.bytes = this.readBytes();
    if (this.bytes === null) {
      // Only a freshly created scope can be initialized. Missing canonical state
      // in an existing scope is ambiguous and must never silently reset history.
      check(made, 'missing-snapshot');
      this.state = { version: 1, scope, generation: 0, stopLatched: false, records: [] };
      this.persist(this.state);
    } else {
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes);
        const data: unknown = JSON.parse(text);
        validateSnapshot(data, scope);
        check(canonical(data) === text, 'noncanonical-snapshot');
        this.state = data;
      } catch (e) { if (e instanceof AdmissionStoreError) throw e; fail('corrupt-snapshot'); }
      // Reopen reconciles a visible late rename with a new successful flush.
      const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { ownedStat(fs.fstatSync(fd), false); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.flushDir(this.dir);
    }
    openStores.add(this.dir);
  }

  static open(root: string, scope: string, options: AdmissionStoreOptions = {}): AdmissionStore {
    try {
      string(root, ADMISSION_LIMITS.pathBytes); hex(scope);
      check(path.isAbsolute(root) && path.normalize(root) === root && !root.endsWith(path.sep), 'unsafe-root');
      object(options, [], ['beforeIO']);
      if (own(options, 'beforeIO')) check(typeof options.beforeIO === 'function');
      return new AdmissionStore(root, scope, options);
    } catch (e) { if (e instanceof AdmissionStoreError) throw e; fail('io-open'); }
  }

  private verifyRoot(root: string) {
    const parts = root.split(path.sep).filter(Boolean);
    check(parts.length <= ADMISSION_LIMITS.pathComponents, 'unsafe-root');
    let current = path.parse(root).root;
    for (const part of parts) {
      current = path.join(current, part);
      const s = fs.lstatSync(current);
      check(s.isDirectory() && !s.isSymbolicLink(), 'unsafe-path');
    }
    ownedStat(fs.lstatSync(root), true);
  }
  private verifyPaths() { this.verifyRoot(path.dirname(this.dir)); ownedStat(fs.lstatSync(this.dir), true); }
  private flushDir(dir: string) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { ownedStat(fs.fstatSync(fd), true); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private readBytes(): Buffer | null {
    this.verifyPaths();
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); } catch (e) { if (osCode(e) === 'ENOENT') return null; throw e; }
    ownedStat(stat, false);
    check(stat.size <= ADMISSION_LIMITS.snapshotBytes, 'snapshot-quota');
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd); ownedStat(opened, false);
      check(opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size, 'concurrent-change');
      const buf = Buffer.alloc(stat.size + 1);
      let offset = 0;
      // At most two reads: partial metadata I/O fails closed rather than looping.
      const n = fs.readSync(fd, buf, 0, stat.size, 0); offset += n;
      check(n === stat.size, 'short-read');
      const extra = fs.readSync(fd, buf, offset, 1, offset); check(extra === 0, 'concurrent-change');
      return buf.subarray(0, offset);
    } finally { fs.closeSync(fd); }
  }
  private usable(mutation = false) { check(!this.closed, 'closed'); if (mutation) check(!this.poisoned, 'reopen-required'); }
  inspect(): AdmissionSnapshot { this.usable(); return clone(this.state); }
  get needsReopen(): boolean { return this.poisoned; }
  close(): void { if (!this.closed) { this.closed = true; openStores.delete(this.dir); } }

  private persist(next: AdmissionSnapshot) {
    validateSnapshot(next, next.scope);
    const encoded = Buffer.from(canonical(next), 'utf8');
    check(encoded.length <= ADMISSION_LIMITS.snapshotBytes, 'snapshot-quota');
    let temp: string | undefined;
    let fd: number | undefined;
    let renamed = false;
    try {
      const current = this.readBytes();
      check(this.bytes === null ? current === null : current !== null && current.equals(this.bytes), 'concurrent-change');
      const candidate = path.join(this.dir, `.snapshot-${randomBytes(16).toString('hex')}.tmp`);
      fd = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temp = candidate;
      fs.fchmodSync(fd, 0o600); ownedStat(fs.fstatSync(fd), false);
      this.options.beforeIO?.('write');
      check(fs.writeSync(fd, encoded, 0, encoded.length, 0) === encoded.length, 'short-write');
      this.options.beforeIO?.('file-fsync'); fs.fsyncSync(fd);
      // A throwing close may already have freed (and recycled) this integer.
      // Retire it before attempting close; never retry ambiguous ownership.
      const closing = fd; fd = undefined; fs.closeSync(closing);
      this.verifyPaths();
      this.options.beforeIO?.('rename'); fs.renameSync(temp, this.file); renamed = true;
      this.options.beforeIO?.('directory-fsync'); this.flushDir(this.dir);
      this.state = next; this.bytes = encoded;
    } catch (e) {
      // Conservatively poison even pre-rename failures: retries must reload and
      // reconcile, and inspection remains only the last confirmed in-memory view.
      this.poisoned = true;
      if (e instanceof AdmissionStoreError) throw e;
      fail('io-write');
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { this.poisoned = true; } }
      // Clean only the exact exclusive temp created by this attempt. Never scan.
      if (temp && !renamed) { try { fs.unlinkSync(temp); } catch { /* ignored, never accepted on open */ } }
    }
  }
  private commit(next: AdmissionSnapshot) {
    check(next.generation < Number.MAX_SAFE_INTEGER, 'generation-exhausted');
    next.generation++;
    this.persist(next);
  }

  admit(input: AdmissionInput): { admitted: boolean; record: AdmissionRecord } {
    this.usable(true); validateInput(input);
    const digest = fingerprint(input);
    const existing = this.state.records.find(r => r.updateId === input.updateId);
    if (existing) { check(existing.fingerprint === digest, 'duplicate-mismatch'); return { admitted: false, record: clone(existing) }; }
    check(this.state.records.length < ADMISSION_LIMITS.records, 'record-quota');
    const next = clone(this.state);
    const record: AdmissionRecord = { updateId: input.updateId, fingerprint: digest, input: clone(input), phase: 'received' };
    next.records.push(record); next.records.sort((a, b) => a.updateId - b.updateId);
    // Reserve worst-case escaped marker + disposition growth for every unresolved
    // record, plus generation digits. Saturation must not prevent local resolution.
    const reserve = next.records.filter(r => !terminal(r.phase)).length * ADMISSION_LIMITS.transitionHeadroomBytes + 64;
    check(Buffer.byteLength(canonical(next), 'utf8') + reserve <= ADMISSION_LIMITS.snapshotBytes, 'snapshot-quota');
    this.commit(next);
    return { admitted: true, record: clone(record) };
  }

  // No lifecycle/authority policy is inferred. Nonterminal transitions (including
  // uncertain -> queued) require the caller's separate ownership/recovery decision.
  transition(changes: AdmissionTransition[]): void {
    this.usable(true); array(changes, 256); check(changes.length > 0);
    const next = clone(this.state); this.apply(next, changes); this.commit(next);
  }
  private apply(next: AdmissionSnapshot, changes: AdmissionTransition[]) {
    const seen = new Set<number>();
    for (const c of changes) {
      object(c, ['updateId', 'phase'], ['turnMarker', 'disposition']); integer(c.updateId); phaseFields(c);
      check(!seen.has(c.updateId), 'duplicate-transition'); seen.add(c.updateId);
      const r = next.records.find(r => r.updateId === c.updateId);
      check(r, 'unknown-record'); check(!terminal(r.phase), 'terminal-record');
      r.phase = c.phase;
      if (own(c, 'turnMarker')) r.turnMarker = c.turnMarker;
      if (own(c, 'disposition')) r.disposition = clone(c.disposition!);
    }
  }
  // The explicit set can exclude the stop-control record itself. No automatic
  // submission/abort, no implicit hold-all, and clearing the latch releases nothing.
  stop(updateIds: number[]): void {
    this.usable(true); array(updateIds, 256);
    const next = clone(this.state);
    this.apply(next, updateIds.map(updateId => ({ updateId, phase: 'held' })));
    next.stopLatched = true; this.commit(next);
  }
  clearStopLatch(): void {
    this.usable(true); const next = clone(this.state); next.stopLatched = false; this.commit(next);
  }
  acknowledge(updateId: number, resolution: LocalDisposition): void {
    this.transition([{ updateId, phase: 'acknowledged', disposition: resolution }]);
  }

  // confirmedDurableCursor is inclusive, supplied ONLY after external durable
  // cursor persistence. No cross-file transaction or automatic pruning is implied.
  prune(confirmedDurableCursor: number, keepRecent: number = ADMISSION_LIMITS.tombstones): { compacted: number; removed: number } {
    this.usable(true); integer(confirmedDurableCursor); integer(keepRecent, 1); check(keepRecent <= 256);
    const next = clone(this.state);
    const eligible = next.records.filter(r => terminal(r.phase) && r.updateId <= confirmedDurableCursor);
    const retained = new Set(eligible.slice(-keepRecent).map(r => r.updateId));
    let compacted = 0, removed = 0;
    next.records = next.records.filter(r => {
      if (!terminal(r.phase) || r.updateId > confirmedDurableCursor) return true;
      if (!retained.has(r.updateId)) { removed++; return false; }
      if (r.input !== null) { r.input = null; compacted++; }
      return true;
    });
    if (compacted || removed) this.commit(next);
    return { compacted, removed };
  }
}
