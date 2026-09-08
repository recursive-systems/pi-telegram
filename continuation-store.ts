import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { originKey, validOrigin, type JobOrigin } from "./job-origin.ts";
import { validContinuationId, validContinuationProducer, validSemanticFingerprint } from "./continuation-api.ts";

export type ContinuationPhase = "held" | "dispatching" | "active" | "uncertain" | "handled";
export interface ContinuationRecord {
	producer: string;
	completionId: string;
	semanticFingerprint: string;
	contentDigest: string;
	origin: JobOrigin;
	intent: "dispatch" | "inspection";
	marker: string;
	text: string;
	phase: ContinuationPhase;
	updatedAt: number;
	note?: string;
}
interface Snapshot { version: 1; scope: string; records: ContinuationRecord[] }
const LIMIT = 64, BYTES = 4 * 1024 * 1024, TEXT = 50_000;
const phases = new Set<ContinuationPhase>(["held", "dispatching", "active", "uncertain", "handled"]);
function fail(code: string): never { throw new Error(`Continuation journal: ${code}`); }
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function validRecord(value: unknown): value is ContinuationRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const r = value as ContinuationRecord;
	const keys = Object.keys(r);
	return keys.every(k => ["producer", "completionId", "semanticFingerprint", "contentDigest", "origin", "intent", "marker", "text", "phase", "updatedAt", "note"].includes(k)) &&
		["producer", "completionId", "semanticFingerprint", "contentDigest", "origin", "intent", "marker", "text", "phase", "updatedAt"].every(k => Object.hasOwn(r, k)) &&
		validContinuationProducer(r.producer) && validContinuationId(r.completionId) && validSemanticFingerprint(r.semanticFingerprint) &&
		/^[a-f0-9]{64}$/.test(r.contentDigest) && validOrigin(r.origin) && (r.intent === "dispatch" || r.intent === "inspection") &&
		typeof r.marker === "string" && /^\[turn:[0-9a-f-]{36}\]$/.test(r.marker) &&
		typeof r.text === "string" && r.text.length > 0 && r.text.length <= TEXT && phases.has(r.phase) &&
		Number.isSafeInteger(r.updatedAt) && r.updatedAt >= 0 && (r.note === undefined || typeof r.note === "string" && r.note.length <= 256);
}
function recordKey(record: Pick<ContinuationRecord, "producer" | "completionId">): string { return `${record.producer}\u0000${record.completionId}`; }
function validate(value: unknown, scope: string): asserts value is Snapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-schema");
	const s = value as Snapshot;
	if (Object.keys(s).length !== 3 || s.version !== 1 || s.scope !== scope || !Array.isArray(s.records) || s.records.length > LIMIT) fail("invalid-schema");
	const ids = new Set<string>();
	for (const record of s.records) { const key = recordKey(record); if (!validRecord(record) || ids.has(key)) fail("invalid-schema"); ids.add(key); }
}
function owned(stat: fs.Stats, directory: boolean): void {
	if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (!directory && stat.nlink !== 1)) fail("unsafe-path");
}
function readOwnedBytes(file: string): Buffer | null {
	let stat: fs.Stats;
	try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	owned(stat, false); if (stat.size > BYTES) fail("quota");
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const opened = fs.fstatSync(fd); owned(opened, false);
		if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail("concurrent-change");
		const bytes = Buffer.alloc(stat.size + 1), count = fs.readSync(fd, bytes, 0, stat.size, 0);
		if (count !== stat.size || fs.readSync(fd, bytes, stat.size, 1, stat.size) !== 0) fail("short-read");
		return bytes.subarray(0, count);
	} finally { fs.closeSync(fd); }
}

/** Read-only cold inspection. It never creates state or grants dispatch ownership. */
export function inspectContinuationRecords(scopeDir: string, scope: string): ContinuationRecord[] {
	if (!path.isAbsolute(scopeDir) || !/^[a-f0-9]{64}$/.test(scope)) fail("invalid-root");
	try { owned(fs.lstatSync(scopeDir), true); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const bytes = readOwnedBytes(path.join(scopeDir, "continuations.json")); if (bytes === null) return [];
	const text = bytes.toString("utf8"), parsed: unknown = JSON.parse(text); validate(parsed, scope);
	if (canonical(parsed) !== text) fail("noncanonical"); return structuredClone(parsed.records);
}

/** Single-writer journal protected by the caller's existing Telegram profile lease. */
export class ContinuationStore {
	private state: Snapshot;
	private bytes: Buffer | null;
	private poisoned = false;
	private readonly dir: string;
	private readonly file: string;
	private readonly scope: string;
	private constructor(dir: string, file: string, scope: string) {
		this.dir = dir; this.file = file; this.scope = scope;
		owned(fs.lstatSync(dir), true);
		try {
			this.bytes = this.readBytes(); if (this.bytes === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
			const text = this.bytes.toString("utf8"); const parsed: unknown = JSON.parse(text);
			validate(parsed, scope); if (canonical(parsed) !== text) fail("noncanonical"); this.state = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.bytes = null; this.state = { version: 1, scope, records: [] }; this.persist(this.state);
		}
	}
	static open(scopeDir: string, scope: string): ContinuationStore {
		if (!path.isAbsolute(scopeDir) || !/^[a-f0-9]{64}$/.test(scope)) fail("invalid-root");
		return new ContinuationStore(scopeDir, path.join(scopeDir, "continuations.json"), scope);
	}
	inspect(): Snapshot { return structuredClone(this.state); }
	find(producer: string, completionId: string): ContinuationRecord | undefined {
		const record = this.state.records.find(candidate => candidate.producer === producer && candidate.completionId === completionId);
		return record && structuredClone(record);
	}
	private readBytes(): Buffer | null { return readOwnedBytes(this.file); }
	private persist(next: Snapshot): void {
		if (this.poisoned) fail("reopen-required"); validate(next, this.scope);
		const encoded = Buffer.from(canonical(next)); if (encoded.length > BYTES) fail("quota");
		let temp: string | undefined, fd: number | undefined, renamed = false;
		try {
			const current = this.readBytes();
			if (!(this.bytes === null ? current === null : current?.equals(this.bytes))) fail("concurrent-change");
			temp = path.join(this.dir, `.continuation-${randomBytes(16).toString("hex")}.tmp`);
			fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			fs.fchmodSync(fd, 0o600); if (fs.writeSync(fd, encoded) !== encoded.length) fail("short-write"); fs.fsyncSync(fd);
			const closing = fd; fd = undefined; fs.closeSync(closing); owned(fs.lstatSync(this.dir), true); fs.renameSync(temp, this.file); renamed = true;
			const dfd = fs.openSync(this.dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
			try { owned(fs.fstatSync(dfd), true); fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
			this.state = next; this.bytes = encoded;
		} catch (error) { this.poisoned = true; throw error; }
		finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} if (temp && !renamed) try { fs.unlinkSync(temp); } catch {} }
	}
	accept(record: ContinuationRecord): "new" | "same" {
		if (!validRecord(record) || (record.intent === "dispatch" ? record.phase !== "held" : record.phase !== "uncertain")) fail("invalid-record");
		const existing = this.state.records.find(r => recordKey(r) === recordKey(record));
		if (existing) {
			if (existing.semanticFingerprint !== record.semanticFingerprint || existing.contentDigest !== record.contentDigest ||
				originKey(existing.origin) !== originKey(record.origin) || existing.intent !== record.intent) fail("changed-completion");
			return "same";
		}
		const next = structuredClone(this.state);
		while (next.records.length >= LIMIT) {
			const handled = next.records.findIndex(candidate => candidate.phase === "handled");
			if (handled < 0) fail("quota");
			next.records.splice(handled, 1);
		}
		next.records.push(structuredClone(record)); this.persist(next); return "new";
	}
	transition(producer: string, completionId: string, semanticFingerprint: string, phase: ContinuationPhase, updatedAt: number, note?: string): void {
		const next = structuredClone(this.state), record = next.records.find(r => r.producer === producer && r.completionId === completionId);
		if (!record || record.semanticFingerprint !== semanticFingerprint || !phases.has(phase)) fail("unknown-record");
		record.phase = phase; record.updatedAt = updatedAt; if (note === undefined) delete record.note; else record.note = note;
		this.persist(next);
	}
}
