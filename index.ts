import { existsSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { AdmissionStore, type AdmissionInput, type AdmissionPhase, type TelegramMediaReference } from "./admission-store.ts";
import { AdmissionLease } from "./admission-lease.ts";
import { ContinuationStore, inspectContinuationRecords } from "./continuation-store.ts";
import { persistTelegramConfig } from "./admission-config.ts";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { telegramCommands, parseTelegramCommand, telegramHelp } from "./telegram-commands.ts";

import { markdownToTelegramHtml } from "./markdown-to-telegram.ts";

import { ORIGIN_CAPTURE, ORIGIN_CLAIM, ORIGIN_READY, validOrigin, validEpoch, type JobOrigin, type OriginCapture, type OriginClaim } from "./job-origin.ts";
import { TELEGRAM_CONTINUATION_API_VERSION, TELEGRAM_CONTINUATION_CAPTURE, TELEGRAM_CONTINUATION_OFFER,
	validContinuationContext, validContinuationId, validContinuationProducer, validSemanticFingerprint,
	type TelegramContinuationCaptureRequest, type TelegramContinuationOfferRequest, type TelegramContinuationResponse } from "./continuation-api.ts";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	business_connection_id?: string;
	guest_query_id?: string;
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	video_note?: { file_id: string };
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	incomingIds?: number[];
	origin?: JobOrigin;
	continuation?: { producer: string; completionId: string; semanticFingerprint: string };
	marker: string;
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	replyToMessageId?: number;
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushing?: Promise<void>;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	ready: () => void;
	flushTimer?: ReturnType<typeof setTimeout>;
}

// Only a live, one-shot capability can authorize restoration. Session entries alone
// (including copied/forked entries) never authorize a connection. No credentials here.
interface ReloadCheckpoint {
	admission?: { scope: string; generation: number; stopLatched: boolean };
	bridgeEpoch?: string;
	version: 1;
	reason: "telegram-reload";
	nonce: string;
	sessionId: string;
	sessionFile: string;
	configDigest: string;
	connected: boolean;
	cursor?: number;
	held: boolean;
	stopGeneration: number;
	turns: PendingTelegramTurn[];
}
interface ReloadPermit { digest: string; armed: boolean; expires: number }
const reloadKey = Symbol.for("pi-telegram.explicit-reload.v1");
const processState = globalThis as typeof globalThis & { [reloadKey]?: { key: string; permits: Map<string, ReloadPermit> } };
const reloadState = processState[reloadKey] ??= { key: randomUUID(), permits: new Map() };
const CHECKPOINT_TYPE = "telegram-reload-checkpoint-v1";
const CLAIM_TYPE = "telegram-reload-claim-v1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const configDigest = (config: TelegramConfig) => createHmac("sha256", reloadState.key)
	.update(JSON.stringify([config.botToken, config.botId, config.botUsername, config.allowedUserId])).digest("hex");

const PROFILE_HOME = homedir();
const CONFIG_PATH = join(PROFILE_HOME, ".pi", "agent", "telegram.json");
const TEMP_DIR = join(PROFILE_HOME, ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

const execFileAsync = promisify(execFile);
let cachedExtensionVersion: string | null = null;

/**
 * Lazy, cached checkout metadata only. This is NOT loaded-code provenance.
 */
async function getExtensionVersion(): Promise<string> {
	if (cachedExtensionVersion !== null) return cachedExtensionVersion;
	try {
		const { stdout: shaOut } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: EXTENSION_DIR });
		const sha = shaOut.trim();
		let dirty = false;
		try {
			const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], { cwd: EXTENSION_DIR });
			dirty = statusOut.trim().length > 0;
		} catch {
			// dirty check is best-effort
		}
		cachedExtensionVersion = `${sha}${dirty ? " (dirty)" : ""}`;
	} catch {
		cachedExtensionVersion = "unknown (no git metadata)";
	}
	return cachedExtensionVersion;
}
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some(key => !["botToken", "botUsername", "botId", "allowedUserId", "lastUpdateId"].includes(key))) throw new Error("invalid config");
		for (const key of ["botToken", "botUsername"] as const) if (parsed[key] !== undefined && (typeof parsed[key] !== "string" || parsed[key]!.length > 4096 || !parsed[key]!.length)) throw new Error("invalid config");
		for (const key of ["botId", "allowedUserId", "lastUpdateId"] as const) if (parsed[key] !== undefined && (!Number.isSafeInteger(parsed[key]) || parsed[key]! < (key === "lastUpdateId" ? 0 : 1))) throw new Error("invalid config");
		return parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error("Telegram configuration invalid; operator repair required");
	}
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let bridgeEpoch: string = randomUUID();
	let originCtx: ExtensionContext | undefined;
	let originSubscriptions: Array<() => void> = [];
	const continuationSubmissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const continuationTimerKey = (value: { producer: string; completionId: string }) => `${value.producer}\u0000${value.completionId}`;
	let reloadPending = false;
	let connectionIntent = 0;
	let reservation: symbol | undefined;
	let verifiedUsername: string | undefined;
	let verifiedToken: string | undefined;
	let identityController: AbortController | undefined;
	let reloadRunning = false;
	let checkpoint: ReloadCheckpoint | undefined;
	let restoreStarted = false;
	let recoveryRequired = false;
	let restoredDisconnected = false;
	let uncertainReply: ActiveTelegramTurn | undefined;
	const failedPreparations: TelegramMessage[][] = [];
	const failedIngress: Array<{ updateId?: number }> = [];
	const replyWaiters: Array<() => void> = [];
	let menuAttempted = false;
	let menuState = "not-attempted";
	let menuController: AbortController | undefined;
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	// Reserve before calling Pi: sendUserMessage is void and can reenter lifecycle hooks.
	let submittedTelegramTurn: PendingTelegramTurn | undefined;
	let routingTelegram = false;
	let awaitingTelegramStart = false;
	// before_agent_start is emitted while the host can still report idle.
	// No failure/finished-preflight event exists; do not guess that it ended.
	let preflightPending = false;
	let drainTimer: ReturnType<typeof setImmediate> | undefined;
	let compactionWakeTimer: ReturnType<typeof setTimeout> | undefined;
	let finalizingReply = false;
	// A real settled event was observed, but its finalization gate may have been
	// busy (e.g. manual compaction started in an earlier awaited listener).
	// Only existing lifecycle drains can retry this debt; agent_start supersedes it.
	let settlementOwed = false;
	let lastTelegramAssistant: ReturnType<typeof extractAssistantText> = {};
	let closed = false;
	const sessionController = new AbortController();
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let stopGeneration = 0;
	let setupInProgress = false;
	let preparingTurns: Promise<void> = Promise.resolve();
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	let profileLease: AdmissionLease | undefined;
	let inbox: AdmissionStore | undefined;
	let continuations: ContinuationStore | undefined;
	let coldContinuations = 0;
	let continuationColdInspection = false;
	let inboxRoot: string | undefined;
	let inboxFault = false;
	let leaseUncertain = false;
	const retainedIncoming = new Set<number>();
	let apiCalls = 0;
	const liveIncoming = new Set<number>();
	const coldIncoming = new Set<number>();
	const messageIds = new WeakMap<TelegramMessage, number>();
	const terminalPhase = (phase: AdmissionPhase) => phase === "handled" || phase === "acknowledged";
	function ensureLease(): void {
		if (closed) throw new Error("Telegram session closed");
		if (leaseUncertain || profileLease?.retired) throw new Error("Telegram lease ownership uncertain; operator repair required");
		if (profileLease) return;
		// Canonicalize only the trusted HOME alias; lease validates every ancestor.
		const root = join(realpathSync(PROFILE_HOME), ".pi", "agent", "telegram-inbox");
		try { mkdirSync(root, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Telegram inbox unavailable"); }
		try { profileLease = AdmissionLease.acquire(root, digest(["pi-telegram/profile-writer/v1"])); }
		catch (error) { leaseUncertain = true; throw error; }
		inboxRoot = root;
	}
	function scopeFor(principal: number): string {
		return digest(["pi-telegram/admission-records/v1", config.botToken, principal]);
	}
	function inspectColdContinuations(): void {
		if (!config.botToken || config.allowedUserId === undefined) return;
		try {
			const intendedRoot = join(realpathSync(PROFILE_HOME), ".pi", "agent", "telegram-inbox");
			if (!existsSync(intendedRoot)) return;
			const root = realpathSync(intendedRoot), scope = scopeFor(config.allowedUserId);
			coldContinuations = inspectContinuationRecords(join(root, scope), scope).filter(record => record.phase !== "handled").length;
			continuationColdInspection = coldContinuations > 0;
		} catch { inboxFault = true; continuationColdInspection = true; }
	}
	function continuationStore(): ContinuationStore | undefined {
		if (continuations) return continuations;
		if (!inbox || !inboxRoot || !profileLease || profileLease.retired || config.allowedUserId === undefined) return undefined;
		const scope = scopeFor(config.allowedUserId);
		continuations = ContinuationStore.open(join(inboxRoot, scope), scope);
		coldContinuations = continuations.inspect().records.filter(record => record.phase !== "handled").length;
		continuationColdInspection = coldContinuations > 0;
		return continuations;
	}
	function openInbox(principal = config.allowedUserId): void {
		if (inboxFault) throw new Error("Telegram inbox requires operator repair");
		ensureLease();
		if (principal === undefined) return;
		const scope = scopeFor(principal);
		if (inbox?.inspect().scope === scope) {
			if (config.lastUpdateId === undefined && inbox.inspect().records.length) {
				inboxFault = true; throw new Error("Telegram cursor missing; operator repair required");
			}
			return;
		}
		if (liveIncoming.size || coldContinuations || preparationCount || queuedTelegramTurns.length || submittedTelegramTurn || activeTelegramTurn || finalizingReply || uncertainReply)
			throw new Error("Telegram identity change refused: live ownership");
		inbox?.close(); inbox = undefined; continuations = undefined; coldIncoming.clear();
		inbox = AdmissionStore.open(inboxRoot!, scope);
		// The optional producer must not create a journal merely because Telegram connected.
		try {
			coldContinuations = inspectContinuationRecords(join(inboxRoot!, scope), scope).filter(record => record.phase !== "handled").length;
			continuationColdInspection = coldContinuations > 0;
		} catch (error) { inboxFault = true; throw error; }
		const snapshot = inbox.inspect();
		retainedIncoming.clear();
		for (const record of snapshot.records) retainedIncoming.add(record.updateId);
		for (const record of snapshot.records) if (!terminalPhase(record.phase)) coldIncoming.add(record.updateId);
		preserveQueuedTurnsAsHistory = snapshot.stopLatched;
		if (config.lastUpdateId === undefined && snapshot.records.length) { inboxFault = true; throw new Error("Telegram cursor missing; operator repair required"); }
	}
	function maybeReleaseLease(): void {
		// Disconnect alone cannot abandon volatile ownership. Closed callbacks can
		// no longer dispatch; wait for every transport/preparation/finalizer first.
		if (!profileLease || pollingPromise || setupInProgress || apiCalls || preparationCount || finalizingReply) return;
		if (!closed && (liveIncoming.size || queuedTelegramTurns.length || submittedTelegramTurn || activeTelegramTurn || uncertainReply || failedIngress.length || failedPreparations.length)) return;
		if (!closed && !restoredDisconnected) return;
		inbox?.close(); inbox = undefined; continuations = undefined;
		const lease = profileLease; profileLease = undefined;
		try { lease.release(); } catch { leaseUncertain = true; inboxFault = true; }
	}
	function journalTurn(turn: PendingTelegramTurn, phase: AdmissionPhase): void {
		const ids = turn.incomingIds ?? [];
		if (!ids.length) return; // Synthetic continuations and permitted legacy turns.
		if (closed || !inbox || inboxFault) throw new Error("Telegram admission unavailable");
		try {
			inbox.transition(ids.map(updateId => ({ updateId, phase, turnMarker: turn.marker,
				...(terminalPhase(phase) ? { disposition: { at: Date.now(), note: "Successful local handling only; not goal completion or exactly-once delivery." } } : {}) })));
			if (terminalPhase(phase)) for (const id of ids) liveIncoming.delete(id);
		} catch { inboxFault = true; throw new Error("Telegram admission transition failed; operator repair required"); }
	}
	function messageIncomingIds(messages: TelegramMessage[]): number[] {
		return messages.flatMap(message => { const id = messageIds.get(message); return id === undefined ? [] : [id]; });
	}
	function telegramControl(message: TelegramMessage) {
		const standalone = typeof message.text === "string" && !message.caption && !message.media_group_id && !message.photo && !message.document &&
			!message.video_note && !message.video && !message.audio && !message.voice && !message.animation && !message.sticker;
		return standalone ? parseTelegramCommand(message.text!, verifiedToken === config.botToken ? verifiedUsername : undefined) : undefined;
	}
	function admissionDTO(update: TelegramUpdate, message: TelegramMessage, ctx: ExtensionContext): AdmissionInput {
		const media: TelegramMediaReference[] = [];
		const add = (type: TelegramMediaReference["type"], file: { file_id: string; file_name?: string; mime_type?: string } | undefined) => {
			if (!file) return;
			const name = file.file_name ? sanitizeFileName(basename(file.file_name)).slice(0, 255) : undefined;
			const mime = file.mime_type && file.mime_type.length <= 127 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mime_type) ? file.mime_type : undefined;
			media.push({ retention: "telegram-reference-only", type, fileId: file.file_id,
				...(name && name !== "." && name !== ".." ? { name } : {}), ...(mime ? { mime } : {}) });
		};
		add("photo", message.photo?.at(-1));
		for (const type of ["document", "audio", "voice", "video", "video_note", "animation", "sticker"] as const) add(type, message[type]);
		const control = telegramControl(message);
		// Unsupported setup/login-like commands may contain credentials. Retain
		// only their bounded non-execution classification, never arbitrary fields.
		const retainedText = control?.foreign ? "[telegram-control:foreign]" : control && !telegramCommands.some(route => route.command === control.name)
			? "[telegram-control:unsupported]" : message.text;
		return { sessionId: ctx.sessionManager.getSessionId(), epoch: bridgeEpoch, updateId: update.update_id,
			chatId: message.chat.id, userId: message.from!.id, messageId: message.message_id, receivedAt: Date.now(),
			...(retainedText !== undefined ? { text: retainedText } : {}), ...(message.caption !== undefined ? { caption: message.caption } : {}), media };
	}
	async function loadConfig(): Promise<TelegramConfig> {
		if (leaseUncertain || profileLease?.retired) throw new Error("Telegram lease ownership uncertain; operator repair required");
		try { return await readConfig(); }
		catch { inboxFault = true; throw new Error("Telegram configuration invalid; operator repair required"); }
	}
	async function commitConfig(next: TelegramConfig): Promise<void> {
		ensureLease();
		try { await persistTelegramConfig(CONFIG_PATH, next); }
		catch { inboxFault = true; throw new Error("Telegram configuration persistence failed; operator repair required"); }
		config = next; // ONLY after file and directory flush.
	}


	// Diagnostics contain only fixed labels, counts, booleans and times. No content
	// or external error strings; never persisted or used to make routing decisions.
	const loadedAt = new Date().toISOString();
	const instance = randomUUID();
	const queuedAt = new WeakMap<PendingTelegramTurn, number>();
	const phaseSince = new Map<string, number>();
	const lifecycle: { event: string; at: number; hostIdle?: boolean; hostPending?: boolean }[] = [];
	let preparationCount = 0;
	let finalizationStage = "none";
	function phases() {
		return { submitted: !!submittedTelegramTurn, preflight: preflightPending,
			active: !!activeTelegramTurn, finalizing: finalizingReply,
			held: preserveQueuedTurnsAsHistory, preparing: preparationCount > 0 };
	}
	function transition(event: string, ctx?: ExtensionContext): void {
		const now = Date.now();
		for (const [phase, present] of Object.entries(phases())) {
			if (!present) phaseSince.delete(phase);
			else if (!phaseSince.has(phase)) phaseSince.set(phase, now);
		}
		lifecycle.push({ event, at: now, ...(ctx ? { hostIdle: ctx.isIdle(), hostPending: ctx.hasPendingMessages() } : {}) });
		if (lifecycle.length > 16) lifecycle.shift();
	}
	function diagnostics(ctx: ExtensionContext) {
		const now = Date.now();
		const hostIdle = ctx.isIdle(), hostPending = ctx.hasPendingMessages();
		const state = phases();
		const blocker = closed ? "closed" : inboxFault ? "admission-repair-required" : coldIncoming.size ? "interrupted-inbox" : continuationColdInspection ? "continuation-inspection" : recoveryRequired ? "recovery-required" : reloadPending ? "reload-pending" :
			restoredDisconnected ? "restored-disconnected" : failedPreparations.length || failedIngress.length ? "failed-ingress-or-preparation" : state.preflight ? "preflight" : state.held ? "held" :
			state.submitted ? "submitted" : state.active ? "active-awaiting-settlement" :
			state.finalizing ? "finalizing" : !hostIdle ? "host-busy" : hostPending ? "host-pending" :
			queuedTelegramTurns.length ? "awaiting-drain" : state.preparing ? "preparing" : "none";
		return { admission: { open: !!inbox, fault: inboxFault, live: liveIncoming.size, interrupted: coldIncoming.size, continuationHeld: coldContinuations, lease: !!profileLease && !profileLease.retired, leaseUncertain }, instance, loadedAt, closed, menuState, configured: !!config.botToken, paired: config.allowedUserId !== undefined, polling: !!pollingPromise,
			queued: queuedTelegramTurns.length, ...state, preparationCount,
			reloadPending, recoveryRequired, restoredDisconnected, uncertainReply: !!uncertainReply,
			failedPreparations: failedPreparations.length, failedIngress: failedIngress.length,
			routingTelegram, awaitingTelegramStart, settlementOwed, finalizationStage,
			previewFlushing: !!previewState?.flushing, previewScheduled: !!previewState?.flushTimer,
			drainScheduled: !!drainTimer, compactionWakeScheduled: !!compactionWakeTimer,
			hostIdle, hostPending, blocker,
			agesMs: { ...Object.fromEntries([...phaseSince].filter(([key]) => state[key as keyof typeof state]).map(([key, at]) => [key, Math.max(0, now - at)])),
				queued: queuedTelegramTurns.length ? Math.max(0, now - (queuedAt.get(queuedTelegramTurns[0]) ?? now)) : null },
			lifecycle: lifecycle.map(({ at, ...metadata }) => ({ ...metadata, ageMs: Math.max(0, now - at) })) };
	}
	pi.registerFlag("telegram-diagnostics", {
		description: "Expose the read-only, content-free telegram_diagnostics tool", type: "boolean", default: false,
	});
	let diagnosticsRegistered = false;
	function registerDiagnosticsTool(): void {
		if (closed || diagnosticsRegistered || pi.getFlag("telegram-diagnostics") !== true) return;
		pi.registerTool({
			name: "telegram_diagnostics", label: "Telegram Diagnostics",
			description: "Read bounded Telegram bridge lifecycle metadata. Does not connect, reset, replay or send messages. Host state is sampled during this tool call, not before the calling turn.",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const details = diagnostics(ctx);
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			},
		});

		diagnosticsRegistered = true;
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		if (closed) return;
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (inboxFault || coldIncoming.size) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", inboxFault ? "operator repair required" : "interrupted inbox; local reconciliation required")}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || submittedTelegramTurn || finalizingReply || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", activeTelegramTurn && routingTelegram && !awaitingTelegramStart ? "processing" : finalizingReply ? "sending reply" : preserveQueuedTurnsAsHistory ? "held" : "waiting")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		ensureLease();
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		apiCalls++;
		try {
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal ? AbortSignal.any([options.signal, sessionController.signal]) : sessionController.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error("Telegram API request failed");
		}
		return data.result;
		} catch { throw new Error("Telegram API request unavailable"); }
		finally { apiCalls--; maybeReleaseLease(); }
	}

	// Optional UI operations never join ingress/preparation/finalization barriers.
	// Race cancellation as well as passing a signal: even an uncooperative transport
	// cannot strand polling or retain a live-context callback indefinitely.
	async function boundedUiCall(method: string, body: Record<string, unknown>, signal = sessionController.signal, accept?: (result: unknown) => void): Promise<boolean> {
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, sessionController.signal, controller.signal]);
		let cancelled!: () => void;
		const cancellation = new Promise<never>((_resolve, reject) => {
			cancelled = () => reject(new Error("UI cancelled"));
			combined.addEventListener("abort", cancelled, { once: true });
			if (combined.aborted) cancelled();
		});
		const timer = setTimeout(() => controller.abort(), 2000);
		timer.unref();
		try {
			const result = await Promise.race([callTelegram(method, body, { signal: combined }), cancellation]);
			if (!combined.aborted) accept?.(result);
			return !combined.aborted;
		} catch { return false; }
		finally { clearTimeout(timer); combined.removeEventListener("abort", cancelled); }
	}

	function syncCommandMenu(chatId: number, intent: number, signal: AbortSignal): void {
		if (closed || reloadPending || signal.aborted || intent !== connectionIntent || menuAttempted || !pollingPromise || !Number.isSafeInteger(chatId)) return;
		menuAttempted = true;
		menuState = "pending";
		const controller = menuController = new AbortController();
		void boundedUiCall("setMyCommands", {
			scope: { type: "chat", chat_id: chatId }, language_code: "",
			commands: telegramCommands.map(({ command, description }) => ({ command, description })),
		}, controller.signal).then(ok => {
			if (closed || menuController !== controller || controller.signal.aborted) return;
			menuState = ok ? "sent-best-effort" : "unavailable";
			menuController = undefined;
		});
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (closed) throw new Error("Telegram session shut down");
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		ensureLease();
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		sessionController.signal.throwIfAborted();
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal ? AbortSignal.any([options.signal, sessionController.signal]) : sessionController.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error("Telegram API request failed");
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (closed) throw new Error("Telegram session shut down");
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		sessionController.signal.throwIfAborted();
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`, { signal: sessionController.signal });
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		sessionController.signal.throwIfAborted();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		if (closed) return;
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				updateStatus(ctx, "Telegram typing unavailable");
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		if (typeof value.content === "string") return value.content.trim();
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		await state.flushing?.catch(() => undefined);
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state || closed) return;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		const previous = state.flushing;
		const flushing = (async () => {
			await previous;
			if (!closed && previewState === state) await sendPreview(chatId, state);
		})();
		state.flushing = flushing;
		try { await flushing; } finally {
			if (state.flushing === flushing) state.flushing = undefined;
		}
	}

	async function sendPreview(chatId: number, state: TelegramPreviewState): Promise<void> {
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (closed || previewState !== state) return;
		if (state.messageId === undefined) {
			const html = markdownToTelegramHtml(truncated);
			try {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...replyParameters(state.replyToMessageId) });
				state.messageId = sent.message_id;
			} catch {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated, ...replyParameters(state.replyToMessageId) });
				state.messageId = sent.message_id;
			}
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		try {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: markdownToTelegramHtml(truncated), parse_mode: "HTML" });
		} catch {
			await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		}
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (closed || !previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId).catch(() => undefined);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await sendFormattedText(chatId, finalText, state.replyToMessageId);
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	/** Send `text` preferring formatted HTML, falling back to plain text on rejection. */
	async function sendFormattedText(chatId: number, text: string, replyToMessageId?: number): Promise<number | undefined> {
		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: markdownToTelegramHtml(text), parse_mode: "HTML", ...replyParameters(replyToMessageId) });
			return sent.message_id;
		} catch {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text, ...replyParameters(replyToMessageId) });
			return sent.message_id;
		}
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string, threaded = false): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			lastMessageId = await sendFormattedText(chatId, chunk, threaded ? _replyToMessageId : undefined);
		}
		return lastMessageId;
	}

	function continuationReplyTo(turn: PendingTelegramTurn | undefined): number | undefined {
		return turn?.origin && turn.origin.requestMarker !== turn.marker ? turn.replyToMessageId : undefined;
	}
	function replyParameters(messageId?: number) {
		return messageId === undefined ? {} : { reply_parameters: { message_id: messageId } };
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<boolean> {
		let success = true;
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
						...(continuationReplyTo(turn) === undefined ? {} : { reply_parameters: JSON.stringify({ message_id: turn.replyToMessageId }) }),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				success = false;
				uncertainReply = turn;
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`, continuationReplyTo(turn) !== undefined);
			}
		}
		return success;
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video_note) files.push({ file_id: message.video_note.file_id, fileName: `video-note-${message.message_id}.mp4`, mimeType: "video/mp4", isImage: false });
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (closed || inboxFault || recoveryRequired || !ctx.hasUI || setupInProgress || reloadPending) return;
		ensureLease();
		if (liveIncoming.size || coldContinuations || preparationCount || queuedTelegramTurns.length || submittedTelegramTurn || activeTelegramTurn || finalizingReply || uncertainReply || failedIngress.length || failedPreparations.length) {
			ctx.ui.notify("Telegram setup refused: live ownership must quiesce first.", "error"); return;
		}
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token || closed) return;
			await stopPolling();
			if (closed || liveIncoming.size || coldContinuations || preparationCount || queuedTelegramTurns.length) throw new Error("Telegram setup refused: ingress ownership changed");

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify("Invalid or unavailable Telegram bot identity", "error");
				return;
			}

			if (closed) return;
			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			identityController?.abort();
			identityController = undefined;
			verifiedUsername = undefined;
			verifiedToken = undefined;
			await commitConfig(nextConfig);
			openInbox();
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
			maybeReleaseLease();
			drainTelegramQueue(ctx);
		}
	}

	async function stopPolling(preserveAcceptedAddressing = false): Promise<void> {
		identityController?.abort();
		identityController = undefined;
		// Internal handoff drains accepted ingress, including addressed /stop.
		// Explicit disconnect/token changes still invalidate verified addressing.
		if (!preserveAcceptedAddressing) {
			verifiedUsername = undefined;
			verifiedToken = undefined;
		}
		stopTypingLoop();
		if (menuController) menuState = "cancelled";
		menuController?.abort();
		menuController = undefined;
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		const marker = `[turn:${randomUUID()}]`;
		let prompt = `${TELEGRAM_PREFIX} ${marker}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			incomingIds: [...historyTurns.flatMap(turn => turn.incomingIds ?? []), ...messageIncomingIds(messages)],
			marker,
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: [...historyTurns.map((turn) => turn.historyText), formatTelegramHistoryText(rawText, files)].join("\n\n"),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext, intent: number): Promise<void> {
		const firstMessage = messages[0];
		if (closed || !firstMessage) return;
		const command = messages.length === 1 ? telegramControl(firstMessage) : undefined;
		// Cursor acceptance survives disconnect for ordinary input, not controls.
		// Handoff's internal poll abort does NOT change this explicit intent.
		if (command && intent !== connectionIntent) return;
		const reply = (text: string) => sendTextReply(firstMessage.chat.id, firstMessage.message_id, text);
		if (command?.foreign) { await reply("Command addressed to another or unknown bot; not executed."); return; }
		const route = command && telegramCommands.find(c => c.command === command.name);
		if (command && !route) {
			await reply(command.name === "reload" ? "Ordinary /reload is not supported remotely. Use /telegram_reload for a safe handoff."
				: "Unknown or unavailable Telegram command; not executed or sent to pi. Use /commands.");
			return;
		}
		if (route && command && ((route.args === "" && command.args) ||
			(route.command === "bridge_status" && command.args !== "" && command.args !== "detail"))) {
			await reply(`Usage: /${route.command}${route.args ? ` ${route.args}` : ""}`); return;
		}
		const lower = route ? `/${route.command}` : "";
		if (lower === "/bridge_status") {
			const snapshot = diagnostics(ctx);
			const { lifecycle, ...summary } = snapshot;
			await reply(`Bridge state (not model usage; sampled without a model turn):\n${JSON.stringify(command?.args === "detail" ? snapshot : summary, null, 2)}`);
			return;
		}
		if (lower === "/telegram_reload") {
			const request = reserveReload();
			await boundedUiCall("sendMessage", { chat_id: firstMessage.chat.id, text: requestText(request.outcome) });
			if (request.owner) {
				const outcome = submitReload(ctx, request.owner);
				if (outcome === "refused" && !closed) await boundedUiCall("sendMessage", {
					chat_id: firstMessage.chat.id, text: requestText(outcome),
				});
			}
			return; // NEVER await command completion: it awaits this polling ingress.
		}

		if (lower === "/stop") {
			// Stop intent and local safety effects already precede cursor persistence.
			if (currentAbort) {
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (lower === "/version") {
			const version = await getExtensionVersion();
			if (closed || intent !== connectionIntent) return;
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `pi-telegram extension @ ${version}`);
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				customInstructions: command?.args || undefined,
				onComplete: () => {
					if (closed) return;
					drainTelegramQueue(ctx);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.").catch(() => { if (!closed) updateStatus(ctx, "Telegram compaction notification unavailable"); });
				},
				onError: () => {
					if (closed) return;
					drainTelegramQueue(ctx);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction failed; inspect Pi locally.").catch(() => { if (!closed) updateStatus(ctx, "Telegram compaction notification unavailable"); });
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			return;
		}

		if (lower === "/help" || lower === "/start" || lower === "/commands") {
			let discovered: unknown;
			try { discovered = pi.getCommands(); } catch { /* optional catalog */ }
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				telegramHelp(discovered),
			);
			return;
		}

		enqueueTelegramMessages(messages, ctx);
	}

	function enqueueTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext, ready = Promise.resolve()): void {
		// Reserve FIFO at arrival, before album debounce or any download. Commands
		// remain outside this chain so /stop can interrupt preparation.
		const arrivalGeneration = stopGeneration;
		preparationCount++;
		transition("preparation-start");
		const preparing = preparingTurns.then(async () => {
			await ready;
			if (closed) return;
			const historyTurns = preserveQueuedTurnsAsHistory && arrivalGeneration === stopGeneration
				? queuedTelegramTurns.filter((turn) => turn !== submittedTelegramTurn) : [];
			const turn = await createTelegramTurn(messages, historyTurns);
			if (closed) return;
			journalTurn(turn, arrivalGeneration === stopGeneration && !coldIncoming.size ? "queued" : "held");
			if (arrivalGeneration === stopGeneration) inbox?.clearStopLatch();
			queuedTelegramTurns = queuedTelegramTurns.filter((queued) => !historyTurns.includes(queued));
			// A download begun before /stop must never release its hold.
			if (arrivalGeneration === stopGeneration) preserveQueuedTurnsAsHistory = false;
			queuedTelegramTurns.push(turn);
			queuedAt.set(turn, Date.now());
			transition("enqueued");
			updateStatus(ctx);
			drainTelegramQueue(ctx);
		});
		preparingTurns = preparing.catch(() => {
			if (closed) return;
			transition("preparation-failed");
			failedPreparations.push(structuredClone(messages));
			updateStatus(ctx, "attachment preparation failed; work retained, dispatch blocked");
		}).finally(() => { preparationCount--; transition("preparation-finished"); maybeReleaseLease(); });
	}

	function drainTelegramQueue(ctx: ExtensionContext): void {
		if (closed || drainTimer) return;
		// Let the host finish the current lifecycle emission (including compaction
		// cleanup and other extensions' hooks), then recheck admission once.
		drainTimer = setImmediate(() => {
			drainTimer = undefined;
			if (settlementOwed) {
				// Recheck host/preflight gates in the same deferred callback as admission.
				if (!ctx.hasPendingMessages()) void finalizeSettledTelegramTurn(ctx);
			} else submitNextTelegramTurn(ctx);
		});
	}

	function wakeAfterManualCompaction(ctx: ExtensionContext): void {
		if (closed) return;
		drainTelegramQueue(ctx);
		// Success hooks precede host cleanup, and later hooks can await I/O. Keep
		// this completion wake alive until idle instead of consuming it too early.
		// A new agent run takes over via agent_settled; this is not an idle poller.
		if (ctx.isIdle() || compactionWakeTimer) return;
		compactionWakeTimer = setTimeout(() => {
			compactionWakeTimer = undefined;
			wakeAfterManualCompaction(ctx);
		}, 100);
		compactionWakeTimer.unref();
	}

	function canSubmitTelegramTurn(ctx: ExtensionContext): boolean {
		return !(closed || inboxFault || coldIncoming.size || recoveryRequired || reloadPending || restoredDisconnected || failedPreparations.length || failedIngress.length || preflightPending || preserveQueuedTurnsAsHistory || submittedTelegramTurn || activeTelegramTurn || finalizingReply ||
			!ctx.isIdle() || ctx.hasPendingMessages());
	}

	function originReady(ctx: ExtensionContext): boolean {
		return canSubmitTelegramTurn(ctx) && !recoveryRequired && !setupInProgress && !uncertainReply &&
			!!pollingPromise && !pollingController?.signal.aborted && !preparationCount && !mediaGroups.size &&
			!settlementOwed && !queuedTelegramTurns.length;
	}

	// Bind reply fields against edited records using the existing process-local key.
	// This is integrity checking, not isolation from another same-process extension.
	function originSignature(origin: Omit<JobOrigin, "signature">): string {
		return createHmac("sha256", reloadState.key).update(JSON.stringify([origin.provider, origin.version,
			origin.sessionId, origin.requestMarker, origin.chatId, origin.replyToMessageId,
			origin.configDigest, origin.bridgeEpoch, origin.stopGeneration])).digest("hex");
	}

	function admitOriginContinuation(origin: JobOrigin, text: string): boolean {
		const ctx = originCtx;
		if (!ctx || !originReady(ctx) || !currentContinuationOrigin(origin)) return false;
		const marker = `[turn:${randomUUID()}]`;
		const continuation = `${TELEGRAM_PREFIX} ${marker} Background completion continuation for original request ${origin.requestMarker}.\n` +
			"This is a background job result, not a fresh human instruction. Assess the result and continue/report to the original requester as appropriate.\n\n" + text;
		const turn: PendingTelegramTurn = { marker, origin: { ...origin }, chatId: origin.chatId,
			replyToMessageId: origin.replyToMessageId, queuedAttachments: [], content: [{ type: "text", text: continuation }], historyText: continuation };
		queuedTelegramTurns.push(turn);
		queuedAt.set(turn, Date.now());
		submitNextTelegramTurn(ctx);
		if (submittedTelegramTurn === turn || activeTelegramTurn === turn) return true;
		queuedTelegramTurns = queuedTelegramTurns.filter(candidate => candidate !== turn);
		return false;
	}

	function continuationContext(origin: JobOrigin): string {
		const encoded = [origin.provider, origin.version, origin.sessionId, origin.requestMarker, origin.chatId,
			origin.replyToMessageId, origin.configDigest, origin.bridgeEpoch, origin.stopGeneration, origin.signature];
		return Buffer.from(JSON.stringify(encoded)).toString("base64url");
	}
	function parseContinuationContext(value: unknown): JobOrigin | undefined {
		if (!validContinuationContext(value)) return undefined;
		try {
			const decoded = Buffer.from(value, "base64url").toString("utf8"), fields: unknown = JSON.parse(decoded);
			if (!Array.isArray(fields) || fields.length !== 10) return undefined;
			const parsed: unknown = { provider: fields[0], version: fields[1], sessionId: fields[2], requestMarker: fields[3],
				chatId: fields[4], replyToMessageId: fields[5], configDigest: fields[6], bridgeEpoch: fields[7],
				stopGeneration: fields[8], signature: fields[9] };
			if (!validOrigin(parsed) || continuationContext(parsed) !== value) return undefined;
			return parsed;
		} catch { return undefined; }
	}
	function currentContinuationOrigin(origin: JobOrigin): boolean {
		const ctx = originCtx;
		return !!ctx && validOrigin(origin) && origin.sessionId === ctx.sessionManager.getSessionId() &&
			origin.configDigest === configDigest(config) && origin.bridgeEpoch === bridgeEpoch &&
			origin.stopGeneration === stopGeneration && origin.signature === originSignature(origin);
	}
	function retainedContinuationStore(): ContinuationStore | undefined {
		if (continuations) return continuations;
		if (!inbox || !inboxRoot || !profileLease || profileLease.retired || config.allowedUserId === undefined) return undefined;
		const scope = scopeFor(config.allowedUserId), file = join(inboxRoot, scope, "continuations.json");
		if (!existsSync(file)) return undefined;
		return continuationStore();
	}
	function replyContinuation(request: TelegramContinuationOfferRequest, disposition: TelegramContinuationResponse["disposition"]): void {
		try { request.reply({ version: TELEGRAM_CONTINUATION_API_VERSION, disposition }); } catch { /* Producer callbacks cannot alter ownership. */ }
	}
	function acceptContinuationOffer(data: unknown): void {
		// This handler MUST remain synchronous: event emission is void, not acceptance.
		const request = data as TelegramContinuationOfferRequest | undefined;
		if (!request || request.version !== TELEGRAM_CONTINUATION_API_VERSION || typeof request.reply !== "function" ||
			!validContinuationProducer(request.producer) || !validContinuationId(request.completionId) ||
			!validSemanticFingerprint(request.semanticFingerprint) || typeof request.content !== "string" ||
			request.content.length < 1 || request.content.length > 45_000 ||
			!(request.mode === "dispatch" || request.mode === "existing-only" || request.mode === "inspection-only")) return;
		if (closed) { replyContinuation(request, "declined"); return; }
		const suppliedOrigin = request.context === undefined ? undefined : parseContinuationContext(request.context);
		if (request.context !== undefined && !suppliedOrigin) { replyContinuation(request, "declined"); return; }
		// A supplied receipt context is an additional authority fence, not permission
		// to treat revoked authority as a contradiction of a current retained identity.
		if ((suppliedOrigin && !currentContinuationOrigin(suppliedOrigin)) ||
			(request.mode !== "existing-only" && !suppliedOrigin)) {
			replyContinuation(request, "declined"); return;
		}
		let store: ContinuationStore | undefined;
		try { store = request.mode === "existing-only" ? retainedContinuationStore() : continuationStore(); }
		catch { inboxFault = true; updateStatus(originCtx!, "continuation journal requires operator inspection"); replyContinuation(request, "declined"); return; }
		if (!store) { replyContinuation(request, "declined"); return; }
		const retained = store.find(request.producer, request.completionId);
		if (retained && !currentContinuationOrigin(retained.origin)) { replyContinuation(request, "declined"); return; }
		if (retained && suppliedOrigin && continuationContext(retained.origin) !== continuationContext(suppliedOrigin)) {
			inboxFault = true; updateStatus(originCtx!, "continuation identity changed; operator inspection required");
			replyContinuation(request, "declined"); return;
		}
		const contentDigest = createHash("sha256").update(request.content).digest("hex");
		if (request.mode === "existing-only") {
			if (retained && retained.intent === "dispatch" && retained.semanticFingerprint === request.semanticFingerprint && retained.contentDigest === contentDigest) replyContinuation(request, "duplicate");
			else {
				if (retained?.intent === "dispatch") { inboxFault = true; updateStatus(originCtx!, "continuation identity changed; operator inspection required"); }
				replyContinuation(request, "declined");
			}
			return;
		}
		const origin = suppliedOrigin!;
		const marker = `[turn:${randomUUID()}]`;
		const inspection = request.mode === "inspection-only";
		const text = inspection ? `${TELEGRAM_PREFIX} ${marker} Completion retained after delivery ownership was ambiguous.\n\n${request.content}` :
			`${TELEGRAM_PREFIX} ${marker} Background completion continuation for original request ${origin.requestMarker}.\n` +
			`This is a ${request.producer} completion result, not a fresh human instruction. Assess the result and continue/report to the original requester as appropriate.\n\n${request.content}`;
		try {
			const accepted = store.accept({ producer: request.producer, completionId: request.completionId,
				semanticFingerprint: request.semanticFingerprint, contentDigest, origin: { ...origin },
				intent: inspection ? "inspection" : "dispatch", marker, text, phase: inspection ? "uncertain" : "held",
				updatedAt: Date.now(), ...(inspection ? { note: "producer fallback may own delivery" } : {}) });
			if (inspection) {
				if (accepted === "new") coldContinuations++;
				continuationColdInspection = true; replyContinuation(request, "retained-for-inspection"); return;
			}
			if (accepted === "new") {
				const turn: PendingTelegramTurn = { marker, origin: { ...origin }, continuation: {
					producer: request.producer, completionId: request.completionId, semanticFingerprint: request.semanticFingerprint },
					chatId: origin.chatId, replyToMessageId: origin.replyToMessageId, queuedAttachments: [],
					content: [{ type: "text", text }], historyText: text };
				queuedTelegramTurns.push(turn); queuedAt.set(turn, Date.now()); coldContinuations++;
			}
			// Durable local responsibility exists before this synchronous response.
			replyContinuation(request, accepted === "new" ? "accepted" : "duplicate");
			if (accepted === "new") drainTelegramQueue(originCtx!);
		} catch {
			inboxFault = true; updateStatus(originCtx!, "continuation handoff uncertain; operator inspection required");
			replyContinuation(request, "declined");
		}
	}

	function subscribeOrigins(ctx: ExtensionContext): void {
		originCtx = ctx;
		if (originSubscriptions.length) return;
		originSubscriptions.push(pi.events.on(ORIGIN_CAPTURE, (data: unknown) => {
			const request = data as OriginCapture | undefined;
			const origin = activeTelegramTurn?.origin;
			if (!closed && routingTelegram && origin && validOrigin(origin) && request?.sessionId === origin.sessionId &&
				typeof request.capture === "function") request.capture({ ...origin });
		}), pi.events.on(ORIGIN_CLAIM, (data: unknown) => {
			const request = data as OriginClaim | undefined;
			if (!request || typeof request.accept !== "function" || !validOrigin(request.origin) ||
				typeof request.text !== "string" || request.text.length > 50_000 || !request.text.startsWith("[jobs] Completed background jobs:")) return;
			if (admitOriginContinuation(request.origin, request.text)) request.accept();
		}), pi.events.on(TELEGRAM_CONTINUATION_CAPTURE, (data: unknown) => {
			const request = data as TelegramContinuationCaptureRequest | undefined;
			const origin = activeTelegramTurn?.origin;
			if (!closed && request?.version === TELEGRAM_CONTINUATION_API_VERSION && typeof request.capture === "function" &&
				routingTelegram && origin && currentContinuationOrigin(origin)) {
				try { request.capture(continuationContext(origin)); } catch { /* Capture is best-effort and synchronous. */ }
			}
		}), pi.events.on(TELEGRAM_CONTINUATION_OFFER, acceptContinuationOffer));
	}

	function submitNextTelegramTurn(ctx: ExtensionContext): void {
		if (!canSubmitTelegramTurn(ctx)) return;
		const turn = queuedTelegramTurns[0];
		if (!turn) {
			if (originReady(ctx)) pi.events.emit(ORIGIN_READY, { provider: "telegram", version: 1 });
			return;
		}
		try {
			journalTurn(turn, "dispatching");
			if (turn.continuation) { if (!continuations) throw new Error("continuation store unavailable"); continuations.transition(turn.continuation.producer, turn.continuation.completionId, turn.continuation.semanticFingerprint, "dispatching", Date.now()); }
		}
		catch { inboxFault = true; updateStatus(ctx, "admission dispatch blocked; operator repair required"); return; }
		submittedTelegramTurn = turn;
		transition("submitted");
		updateStatus(ctx);
		try {
			pi.sendUserMessage(turn.content);
			if (turn.continuation && submittedTelegramTurn === turn) {
				const continuation = turn.continuation, key = continuationTimerKey(continuation);
				const timer = setTimeout(() => {
					continuationSubmissionTimers.delete(key);
					if (submittedTelegramTurn !== turn) return;
					try { if (!continuations) throw new Error("continuation store unavailable"); continuations.transition(continuation.producer, continuation.completionId, continuation.semanticFingerprint, "uncertain", Date.now(), "host admission not observed"); }
					catch { inboxFault = true; }
					updateStatus(ctx, "continuation admission uncertain; operator inspection required");
				}, 5000);
				timer.unref(); continuationSubmissionTimers.set(key, timer);
			}
		} catch (error) {
			if (turn.continuation) {
				try { if (!continuations) throw new Error("continuation store unavailable"); continuations.transition(turn.continuation.producer, turn.continuation.completionId, turn.continuation.semanticFingerprint, "uncertain", Date.now(), "synchronous submission rejection"); }
				catch { inboxFault = true; }
				queuedTelegramTurns = queuedTelegramTurns.filter(candidate => candidate !== turn);
			}
			// A synchronous rejection did not accept the turn. Keep it in FIFO order.
			if (turn.incomingIds?.length) {
				uncertainReply = turn;
				try { journalTurn(turn, "uncertain"); } catch { /* fault already latched */ }
			} else if (submittedTelegramTurn === turn) submittedTelegramTurn = undefined;
			transition("submission-sync-rejected");
			updateStatus(ctx, "submission failed; outcome uncertain, inspect locally");
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext, intent: number): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			let existing = mediaGroups.get(key);
			if (!existing) {
				let ready!: () => void;
				const prepared = new Promise<void>((resolve) => { ready = resolve; });
				existing = { messages: [], ready };
				mediaGroups.set(key, existing);
				enqueueTelegramMessages(existing.messages, ctx, prepared);
			}
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			const state = existing;
			existing.flushTimer = setTimeout(() => {
				mediaGroups.delete(key);
				state.ready();
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx, intent);
	}

	function localSafetyStop(ctx: ExtensionContext): void {
		preserveQueuedTurnsAsHistory = true;
		for (const turn of queuedTelegramTurns.filter(candidate => candidate.continuation && candidate !== submittedTelegramTurn)) {
			try { continuations?.transition(turn.continuation!.producer, turn.continuation!.completionId, turn.continuation!.semanticFingerprint, "uncertain", Date.now(), "stopped before dispatch"); }
			catch { inboxFault = true; }
		}
		queuedTelegramTurns = queuedTelegramTurns.filter(turn => !turn.continuation || turn === submittedTelegramTurn);
		if (submittedTelegramTurn?.continuation) {
			try { continuations?.transition(submittedTelegramTurn.continuation.producer, submittedTelegramTurn.continuation.completionId, submittedTelegramTurn.continuation.semanticFingerprint, "uncertain", Date.now(), "stopped during host admission"); }
			catch { inboxFault = true; }
		}
		stopGeneration++;
		transition("stop-held");
		currentAbort?.();
		updateStatus(ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext, intent: number, signal: AbortSignal): Promise<void> {
		if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error("Invalid Telegram update identity");
		if (config.lastUpdateId !== undefined && update.update_id <= config.lastUpdateId) {
			const prior = inbox?.inspect().records.find(record => record.updateId === update.update_id);
			const message = update.message || update.edited_message;
			if (prior?.input && message && message.from?.id === config.allowedUserId) {
				const input = admissionDTO(update, message, ctx);
				inbox!.admit({ ...input, sessionId: prior.input.sessionId, epoch: prior.input.epoch, receivedAt: prior.input.receivedAt });
			}
			return; // Confirmed durable cursor permits ignoring compacted/pruned IDs.
		}
		const message = update.message || update.edited_message;
		const eligible = message && !message.business_connection_id && !message.guest_query_id && message.chat.type === "private" && message.from && !message.from.is_bot;
		const authorized = eligible && (config.allowedUserId === undefined || message.from!.id === config.allowedUserId);
		const command = authorized ? telegramControl(message) : undefined;
		const safetyStop = authorized && command?.name === "stop" && command.args === "" && !command.foreign &&
			!retainedIncoming.has(update.update_id) && !closed && intent === connectionIntent && !signal.aborted;
		let stopped = false;
		let admitted = false;
		const paired = authorized && config.allowedUserId === undefined;
		try {
			if (authorized) {
				openInbox(message.from!.id);
				if (config.lastUpdateId !== undefined) inbox!.prune(config.lastUpdateId);
				const input = admissionDTO(update, message, ctx);
				const prior = inbox!.inspect().records.find(record => record.updateId === update.update_id);
				if (prior?.input) {
					input.sessionId = prior.input.sessionId; input.epoch = prior.input.epoch; input.receivedAt = prior.input.receivedAt;
				} else if (prior) throw new Error("Telegram cursor disagrees with compacted admission");
				admitted = inbox!.admit(input).admitted;
				retainedIncoming.add(update.update_id);
				if (admitted) liveIncoming.add(update.update_id);
				if (admitted && safetyStop) {
					inbox!.stop([...liveIncoming].filter(id => id !== update.update_id));
					stopped = true; localSafetyStop(ctx);
				}
				messageIds.set(message, update.update_id);
			}
			await commitConfig({ ...config, ...(paired ? { allowedUserId: message!.from!.id } : {}), lastUpdateId: update.update_id });
		} catch (error) {
			if (safetyStop && !closed && intent === connectionIntent && !signal.aborted) {
				inboxFault = true;
				if (!stopped) localSafetyStop(ctx);
				updateStatus(ctx, "stop applied locally; persistence uncertain, operator repair required");
			}
			throw error;
		}
		if (!authorized) {
			if (eligible && message) await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}
		for (const id of retainedIncoming) if (id <= config.lastUpdateId!) retainedIncoming.delete(id);
		if (!admitted) return; // Retained duplicates NEVER repeat effects.
		if (closed) return;
		if (paired) {
			updateStatus(ctx);
			ctx.ui.notify("Telegram bridge paired with this account.", "info");
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}
		syncCommandMenu(message.chat.id, intent, signal);
		await handleAuthorizedTelegramMessage(message, ctx, intent);
		// Ordinary messages remain live through async preparation/finalization.
		// All standalone command paths return after local control handling only.
		if (!closed && telegramControl(message)) {
			journalTurn({ incomingIds: [update.update_id], marker: `control:${update.update_id}` } as PendingTelegramTurn, "handled");
		}
		if (!closed) inbox!.prune(config.lastUpdateId!);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal, intent: number): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				await commitConfig({ ...config, lastUpdateId: last?.update_id ?? 0 });
			} catch {
				inboxFault = true;
				updateStatus(ctx, "cursor initialization failed; operator repair required");
				return;
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					if (closed || signal.aborted) return;
					try {
						await handleUpdate(update, ctx, intent, signal);
					} catch (error) {
						if (!closed && config.lastUpdateId !== undefined && config.lastUpdateId >= update.update_id && liveIncoming.has(update.update_id)) {
							try { journalTurn({ incomingIds: [update.update_id], marker: `ingress:${update.update_id}` } as PendingTelegramTurn, "uncertain"); } catch { /* retain fault */ }
						}
						failedIngress.push({ updateId: Number.isSafeInteger(update.update_id) ? update.update_id : undefined });
						inboxFault = true;
						updateStatus(ctx, "admission interrupted; operator repair required");
						return;
					}
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				updateStatus(ctx, "Telegram polling unavailable");
				await new Promise<void>((resolve) => {
					const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
					const timer = setTimeout(done, 3000);
					signal.addEventListener("abort", done, { once: true });
				});
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (closed || inboxFault || reloadPending || !config.botToken || pollingPromise) return;
		try {
			ensureLease();
			if ((config.lastUpdateId === undefined || config.allowedUserId === undefined) && readdirSync(inboxRoot!).some(name => name !== `${digest(["pi-telegram/profile-writer/v1"])}.lock`))
				throw new Error("Telegram cursor or pairing missing over existing inbox");
			openInbox();
		} catch { inboxFault = true; updateStatus(ctx, "inbox unavailable; operator repair required"); return; }
		// A failed, quiesced handoff may retain identity for its drained ingress.
		// Starting another connection always requires a fresh verification.
		verifiedUsername = undefined;
		verifiedToken = undefined;
		restoredDisconnected = false;
		menuAttempted = false;
		menuState = "not-attempted";
		pollingController = new AbortController();
		const identity = identityController = new AbortController();
		const token = config.botToken;
		void boundedUiCall("getMe", {}, identity.signal, result => {
			if (closed || identityController !== identity || token !== config.botToken) return;
			const username = (result as { username?: unknown })?.username;
			if (typeof username === "string" && /^[a-zA-Z0-9_]+$/.test(username)) { verifiedUsername = username; verifiedToken = token; }
		});
		pollingPromise = pollLoop(ctx, pollingController.signal, connectionIntent).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
		drainTelegramQueue(ctx);
	}

	function refuseReload(ctx: ExtensionContext): boolean {
		if (inboxFault || coldIncoming.size || uncertainReply || submittedTelegramTurn || queuedTelegramTurns.some(turn => !!turn.continuation) || preflightPending || failedPreparations.length || failedIngress.length || setupInProgress) {
			ctx.ui.notify("Telegram reload refused: unacknowledged/preflight, uncertain reply, or failed preparation work. Preserve affected messages before ordinary teardown; no automatic replay.", "error");
			return true;
		}
		return false;
	}

	// Abandoning before quiescing must replace wakes consumed under reloadPending.
	// Use the normal deferred finalization/admission gates; never reconnect or
	// release existing stop/disconnected/recovery holds here.
	function releaseUnstartedReload(ctx: ExtensionContext): void {
		reloadPending = false;
		reloadRunning = false;
		drainTelegramQueue(ctx);
	}

	pi.registerCommand("telegram-reload", {
		description: "Explicit runtime reload with a one-shot Telegram queue handoff (does not upgrade source)",
		handler: async (_args, ctx) => {
			if (closed || reloadRunning || recoveryRequired) return;
			reloadPending = true;
			reloadRunning = true;
			reservation = undefined;
			const intent = connectionIntent;
			let stopped = false;
			try {
				if (refuseReload(ctx)) { releaseUnstartedReload(ctx); return; }
				await ctx.waitForIdle();
				if (finalizingReply) await new Promise<void>(resolve => replyWaiters.push(resolve));
				if (closed) return;
				if (intent !== connectionIntent) throw new Error("connection intent changed");
				if (refuseReload(ctx) || activeTelegramTurn || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("not safe");
				const connected = !!pollingPromise;
				if (connected && config.lastUpdateId === undefined) throw new Error("initial polling cursor not ready");
				const sessionId = ctx.sessionManager.getSessionId();
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("persistent session required");
				// Pi can allocate a filename before its first assistant message flushes
				// anything. Don't promise file-based recovery for an in-memory-only log.
				const persisted = await stat(sessionFile).then(info => info.isFile(), () => false);
				if (closed) return;
				if (intent !== connectionIntent) throw new Error("connection intent changed");
				if (!persisted) {
					releaseUnstartedReload(ctx);
					ctx.ui.notify("Telegram reload refused: session file is not persisted yet. Let Pi save an assistant response before retrying; queued work remains in this instance.", "error");
					return;
				}
				// Abort ONLY polling, not the session signal used by ingress/downloads/replies.
				stopped = true;
				// If handoff fails after quiescing, unrelated idle events must not
				// silently run a disconnected queue. Explicit connect releases it.
				restoredDisconnected = true;
				await stopPolling(true);
				for (const state of mediaGroups.values()) {
					if (state.flushTimer) clearTimeout(state.flushTimer);
					state.ready();
				}
				mediaGroups.clear();
				await preparingTurns;
				if (closed) return;
				if (intent !== connectionIntent) throw new Error("connection intent changed");
				if (refuseReload(ctx) || activeTelegramTurn || finalizingReply || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("not safe after quiescing");
				const diskConfig = await loadConfig();
				if (configDigest(diskConfig) !== configDigest(config) || diskConfig.lastUpdateId !== config.lastUpdateId) throw new Error("config changed");
				if (closed) return;
				if (intent !== connectionIntent) throw new Error("connection intent changed");
				// No async work between this final admission check and snapshot/reload.
				if (refuseReload(ctx) || activeTelegramTurn || finalizingReply || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("not safe after config verification");
				const snapshot = inbox?.inspect();
				checkpoint = structuredClone({ ...(snapshot ? { admission: { scope: snapshot.scope, generation: snapshot.generation, stopLatched: snapshot.stopLatched } } : {}), version: 1, reason: "telegram-reload", nonce: randomUUID(), sessionId, sessionFile,
					configDigest: configDigest(config), bridgeEpoch, connected, cursor: config.lastUpdateId,
					held: preserveQueuedTurnsAsHistory, stopGeneration, turns: queuedTelegramTurns });
				// Bound session growth; never silently truncate private text or image inputs.
				if (Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024) throw new Error("checkpoint too large");
				pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
				reloadState.permits.set(checkpoint.nonce, { digest: digest(checkpoint), armed: false, expires: Date.now() + 120_000 });
			} catch {
				if (closed) return;
				checkpoint = undefined;
				if (!stopped) releaseUnstartedReload(ctx);
				else {
					reloadRunning = false;
					reloadPending = false;
				}
				ctx.ui.notify(stopped
					? "Telegram reload stopped before teardown. Queue/evidence retained locally; polling stopped. Resolve the problem and explicitly retry /telegram-reload or /telegram-connect."
					: "Telegram reload refused before teardown. Work retained; wait for safe idle and retry.", "error");
				return;
			}
			// Terminal: failures after runtime invalidation are reported by the host, not
			// through captured stale pi/ctx. The immutable checkpoint remains in the session.
			const reloadNonce = checkpoint?.nonce;
			try { await ctx.reload(); }
			catch {
				if (!closed) {
					reloadRunning = false;
					reloadPending = false;
					ctx.ui.notify("Telegram runtime reload failed before shutdown; queue retained and polling stopped. Explicit retry required.", "error");
					return;
				}
				// The host error channel owns reporting after teardown; no stale API calls.
				throw new Error("Telegram runtime reload failed after teardown. Private session checkpoint retained; reconcile work manually before reconnecting.");
			} finally {
				// TUI reload/import failures can be diagnostics with a resolved promise.
				// The capability belongs only to THIS operation, never a later /reload.
				if (reloadNonce) reloadState.permits.delete(reloadNonce);
				if (!closed && reloadRunning) {
					reloadRunning = false;
					reloadPending = false;
					ctx.ui.notify("Telegram runtime was not replaced; queue retained and polling stopped. Explicit retry required.", "error");
				}
			}
			return;
		},
	});

	// Catalog and dispatch are separate host operations. Refuse ambiguity, including
	// duplicate namespaces; never infer ownership from a description or name alone.
	function reloadCallable(): boolean {
		try {
			const commands = pi.getCommands();
			const candidates = commands.filter(c => c.name === "telegram-reload" || c.name.startsWith("telegram-reload:"));
			return candidates.length === 1 && candidates[0].name === "telegram-reload" &&
				candidates[0].source === "extension" && candidates[0].sourceInfo?.path === fileURLToPath(new URL("./index.ts", import.meta.url));
		} catch { return false; }
	}
	type RequestOutcome = "requested" | "coalesced" | "refused";
	function requestText(outcome: RequestOutcome): string {
		return outcome === "requested"
			? "Requested /telegram-reload submission; completion, if admitted, is reported locally. This is not an admission or reconnection acknowledgement."
			: outcome === "coalesced" ? "Reload already pending; coalesced without another submission. Admission and completion remain unknown."
			: "Reload request refused or cancelled; nothing submitted. Check bridge recovery/connection state and command collisions locally; use local /telegram-reload only after resolving them.";
	}
	function reserveReload(): { outcome: RequestOutcome; owner?: symbol } {
		if (closed || recoveryRequired || !reloadCallable()) return { outcome: "refused" };
		if (reloadPending || reloadRunning) return { outcome: "coalesced" };
		reloadPending = true;
		reservation = Symbol();
		return { outcome: "requested", owner: reservation };
	}
	function submitReload(ctx: ExtensionContext, owner: symbol): RequestOutcome {
		if (reservation !== owner) return "refused";
		if (closed || recoveryRequired || !reloadCallable()) {
			reservation = undefined;
			if (!closed) releaseUnstartedReload(ctx);
			return "refused";
		}
		reservation = undefined;
		try {
			pi.sendUserMessage("/telegram-reload", { deliverAs: "followUp", expandPromptTemplates: true });
			return "requested";
		} catch {
			if (!closed && !reloadRunning) releaseUnstartedReload(ctx);
			return "refused";
		}
	}

	pi.registerTool({
		name: "telegram_reload",
		label: "Telegram Reload",
		description: "Schedule /telegram-reload safely after the current turn and Telegram reply. ONLY call with explicit user authorization to reload this runtime. Never reload autonomously. Does not install or upgrade source.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const request = reserveReload();
			const outcome = request.owner ? submitReload(ctx, request.owner) : request.outcome;
			return { content: [{ type: "text", text: requestText(outcome) }], details: { outcome } };
		},
	});

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			const turn = activeTelegramTurn;
			if (closed || !turn || !routingTelegram) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (closed || activeTelegramTurn !== turn || !routingTelegram) throw new Error("Telegram turn ended");
				if (turn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				turn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-inbox", {
		description: "Local-only retained inbox: summary, show ID, acknowledge ID (reason + confirmation; never replay)",
		handler: async (args, ctx) => {
			if (closed || !ctx.hasUI || ctx.mode !== "tui") return;
			try {
				ensureLease(); openInbox();
				if (!inbox || inboxFault || recoveryRequired) throw new Error("repair required");
				const [action = "summary", idText, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				const snapshot = inbox.inspect();
				if (action === "summary" && !idText) {
					ctx.ui.notify(JSON.stringify({ scope: snapshot.scope, revision: snapshot.generation, stopLatched: snapshot.stopLatched,
						interrupted: coldIncoming.size, live: liveIncoming.size,
						records: snapshot.records.map(record => ({ id: record.updateId, phase: record.phase, live: liveIncoming.has(record.updateId) })) }), "info"); return;
				}
				if (!idText || !/^\d+$/.test(idText) || (action !== "show" && extra.length)) throw new Error("invalid selection");
				const id = Number(idText), record = snapshot.records.find(record => record.updateId === id);
				if (!record) throw new Error("missing record");
				if (action === "show") {
					// JSON quoting prevents terminal control injection. This notification is
					// not a host/model message or a Telegram reply.
					const page = extra[0] ?? "0";
					if (extra.length > 1 || !/^\d{1,6}$/.test(page)) throw new Error("invalid page");
					const quoted = JSON.stringify(record).replace(/[\x7f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
					const pages = Math.ceil(quoted.length / 4096), offset = Number(page) * 4096;
					if (offset >= quoted.length) throw new Error("invalid page");
					ctx.ui.notify(`Retained record page ${page}/${pages - 1} (quoted): ${quoted.slice(offset, offset + 4096)}\nInspect ALL pages locally with /telegram-inbox show ${id} PAGE before ACK. Media references only: no durable attachment bytes or availability guarantee.`, "info"); return;
				}
				if (action !== "acknowledge" || liveIncoming.has(id) || !coldIncoming.has(id) || terminalPhase(record.phase)) throw new Error("live or ineligible");
				const reason = (await ctx.ui.input("Local reconciliation reason (required; no replay)", "How was this interrupted input resolved?"))?.trim();
				if (!reason || Buffer.byteLength(reason) > 1024 || /[\x00-\x1f\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(reason)) return;
				if (closed) return;
				const confirmed = await ctx.ui.confirm("Acknowledge interrupted Telegram input?",
					`Scope ${snapshot.scope}, update ${id}. Records a manual local disposition only; NEVER submits old records. Resolving the last interrupted record may unblock NEW current-process queued messages, not this old input. The stop latch remains unchanged. Media is reference-only.`);
				if (!confirmed || closed) return;
				if (!profileLease || !inbox || inboxFault || recoveryRequired || inbox.inspect().scope !== snapshot.scope || liveIncoming.has(id) || !coldIncoming.has(id) ||
					JSON.stringify(inbox.inspect().records.find(record => record.updateId === id)) !== JSON.stringify(record)) throw new Error("selection changed");
				inbox.acknowledge(id, { at: Date.now(), note: reason });
				coldIncoming.delete(id);
				updateStatus(ctx);
				ctx.ui.notify("Interrupted input acknowledged locally. No old input replayed.", "info");
				drainTelegramQueue(ctx);
			} catch { if (!closed) ctx.ui.notify("Telegram inbox refused: unavailable, live ownership, invalid selection or operator repair required. No replay or reset performed.", "error"); }
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			try { await promptForConfig(ctx); }
			catch { if (!closed) ctx.ui.notify("Telegram setup refused; inspect profile ownership/configuration locally.", "error"); }
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge gates and ages (detail: full bounded lifecycle history)",
		handler: async (args, ctx) => {
			const checkoutVersion = await getExtensionVersion();
			const snapshot = diagnostics(ctx);
			const { instance, loadedAt, configured, paired, polling, blocker, queued, submitted, preflight, active, finalizing,
				held, settlementOwed, finalizationStage, hostIdle, hostPending, agesMs } = snapshot;
			const view = args.trim() === "detail" ? snapshot : { admission: snapshot.admission, instance, loadedAt, configured, paired, polling, blocker, queued,
				submitted, preflight, active, finalizing, held, settlementOwed, finalizationStage,
				hostIdle, hostPending, agesMs };
			const status = Object.entries(view).map(([key, value]) =>
				`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
			status.push(`reload: ${recoveryRequired ? "recovery required" : reloadPending ? "pending" : "none"}`,
				`failed preparations/ingress: ${failedPreparations.length}/${failedIngress.length}`,
				`uncertain reply: ${uncertainReply ? "yes" : "no"}`);
			ctx.ui.notify(`checkout version (lazy cached, not loaded code): ${checkoutVersion} | ${status.join(" | ")}`, "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			if (pollingPromise || setupInProgress) return;
			if (reloadPending || recoveryRequired || inboxFault) {
				ctx.ui.notify("Telegram handoff pending or recovery required; inspect the retained session checkpoint before any reconnect.", "error");
				return;
			}
			ensureLease();
			const next = await loadConfig();
			if ((configDigest(next) !== configDigest(config) || next.lastUpdateId !== config.lastUpdateId) && (liveIncoming.size || coldContinuations || preparationCount || queuedTelegramTurns.length || submittedTelegramTurn || activeTelegramTurn || finalizingReply || uncertainReply || pollingPromise)) {
				ctx.ui.notify("Telegram identity change refused: live ownership.", "error"); return;
			}
			config = next;
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			connectionIntent++;
			restoredDisconnected = true;
			if (reservation) { reservation = undefined; releaseUnstartedReload(ctx); }
			await stopPolling();
			maybeReleaseLease();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		subscribeOrigins(ctx);
		// CLI/restored flags are applied after the factory, before session_start.
		registerDiagnosticsTool();
		transition("session-start");
		if (restoreStarted) return;
		restoreStarted = true;
		if (event.reason !== "reload") {
			config = await loadConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			inspectColdContinuations(); updateStatus(ctx);
			return;
		}
		const entries = ctx.sessionManager.getEntries();
		const entry = [...entries].reverse().find(e => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
		if (!entry || entry.type !== "custom") {
			config = await loadConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			inspectColdContinuations(); updateStatus(ctx);
			return;
		}
		const saved = entry.data as ReloadCheckpoint;
		const permit = saved && reloadState.permits.get(saved.nonce);
		// Claim synchronously before any await, even when validation fails. Retain the
		// original custom entry forever for deliberate manual recovery, not blind retry.
		if (saved?.nonce) reloadState.permits.delete(saved.nonce);
		if (!permit || !permit.armed || permit.expires < Date.now() || permit.digest !== digest(saved) ||
			saved.version !== 1 || saved.reason !== "telegram-reload" || saved.sessionId !== ctx.sessionManager.getSessionId() ||
			saved.sessionFile !== ctx.sessionManager.getSessionFile() ||
			entries.some(e => e.type === "custom" && e.customType === CLAIM_TYPE && (e.data as { nonce?: string })?.nonce === saved.nonce)) {
			config = await loadConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			inspectColdContinuations(); updateStatus(ctx);
			ctx.ui.notify("No valid live Telegram reload handoff; disconnected. Any archived checkpoint remains private session data, not permission to replay it.", "info");
			return;
		}
		reloadPending = true;
		recoveryRequired = true;
		try {
			pi.appendEntry(CLAIM_TYPE, { nonce: saved.nonce });
			config = await loadConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			if (saved.configDigest !== configDigest(config) || saved.cursor !== config.lastUpdateId) throw new Error("config mismatch");
			if (saved.bridgeEpoch !== undefined && !validEpoch(saved.bridgeEpoch)) throw new Error("invalid bridge epoch");
			if (saved.bridgeEpoch !== undefined) bridgeEpoch = saved.bridgeEpoch;
			ensureLease(); openInbox();
			const snapshot = inbox?.inspect();
			if (saved.admission) {
				if (!snapshot || saved.admission.scope !== snapshot.scope || saved.admission.generation !== snapshot.generation || saved.admission.stopLatched !== snapshot.stopLatched || saved.held !== snapshot.stopLatched) throw new Error("journal disagreement");
				const ids = saved.turns.flatMap(turn => turn.incomingIds ?? []);
				if (new Set(ids).size !== ids.length) throw new Error("duplicate checkpoint ownership");
				for (const turn of saved.turns) for (const id of turn.incomingIds ?? []) {
					const record = snapshot.records.find(record => record.updateId === id);
					if (!record?.input || !["queued", "held"].includes(record.phase) || record.turnMarker !== turn.marker || record.input.sessionId !== saved.sessionId || record.input.epoch !== bridgeEpoch) throw new Error("checkpoint ownership disagreement");
				}
				for (const id of ids) { coldIncoming.delete(id); liveIncoming.add(id); }
			} else {
				if (saved.turns.some(turn => turn.incomingIds?.length) || snapshot?.records.some(record => !terminalPhase(record.phase))) throw new Error("legacy checkpoint disagrees with journal");
				if (saved.held && inbox && !snapshot?.stopLatched) inbox.stop([]);
				ctx.ui.notify("Legacy same-process handoff: retained turns are not newly journal-protected.", "warning");
			}
			queuedTelegramTurns = structuredClone(saved.turns);
			// Diagnostic clocks restart in this instance, not at original arrival.
			const restoredAt = Date.now();
			for (const turn of queuedTelegramTurns) queuedAt.set(turn, restoredAt);
			restoredDisconnected = !saved.connected;
			preserveQueuedTurnsAsHistory = saved.held;
			stopGeneration = saved.stopGeneration;
			transition("queue-restored");
			if (saved.connected) {
				if (!config.botToken) throw new Error("missing config");
				// A successful real API round trip, not creation of a polling promise. This
				// probe does not advance the cursor or acknowledge any newer server updates.
				await callTelegram("deleteWebhook", { drop_pending_updates: false });
				await callTelegram("getUpdates", { offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
					limit: 1, timeout: 0, allowed_updates: ["message", "edited_message"] });
			}
			if (closed) return;
			recoveryRequired = false;
			reloadPending = false;
			if (saved.connected) await startPolling(ctx);
			if (closed) return;
			ctx.ui.notify(saved.connected ? "Telegram handoff restored; API verified, polling started (future network failures remain possible)."
				: "Telegram handoff restored; bridge remains disconnected.", "info");
			drainTelegramQueue(ctx);
		} catch {
			if (closed) return;
			ctx.ui.notify("Telegram handoff recovery required; disconnected and dispatch blocked. Original queue checkpoint retained in private session data. Preserve it and reconcile Telegram messages manually before ordinary reload/connect; no automatic replay or retry.", "error");
		}
	});

	pi.on("session_shutdown", async (event, _ctx) => {
		if (closed) { maybeReleaseLease(); return; }
		if (checkpoint) {
			const permit = reloadState.permits.get(checkpoint.nonce);
			if (permit) permit.armed = event.reason === "reload";
		}
		closed = true;
		for (const unsubscribe of originSubscriptions.splice(0)) unsubscribe();
		for (const timer of continuationSubmissionTimers.values()) clearTimeout(timer);
		continuationSubmissionTimers.clear();
		originCtx = undefined;
		menuController?.abort();
		menuController = undefined;
		settlementOwed = false;
		transition("shutdown");
		sessionController.abort();
		if (drainTimer) clearImmediate(drainTimer);
		drainTimer = undefined;
		if (compactionWakeTimer) clearTimeout(compactionWakeTimer);
		compactionWakeTimer = undefined;
		submittedTelegramTurn = undefined;
		routingTelegram = false;
		awaitingTelegramStart = false;
		queuedTelegramTurns = [];
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
			state.ready();
		}
		mediaGroups.clear();
		if (previewState?.flushTimer) clearTimeout(previewState.flushTimer);
		previewState = undefined;
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
		maybeReleaseLease();
	});


	pi.on("before_agent_start", async (event, ctx) => {
		if (closed) return;
		preflightPending = true;
		const turn = submittedTelegramTurn;
		const continuationOriginCurrent = !turn?.continuation || !!turn.origin && currentContinuationOrigin(turn.origin);
		routingTelegram = !!turn && continuationOriginCurrent && event.prompt.includes(turn.marker);
		if (turn?.continuation && !continuationOriginCurrent) {
			const key = continuationTimerKey(turn.continuation), timer = continuationSubmissionTimers.get(key); if (timer) clearTimeout(timer);
			continuationSubmissionTimers.delete(key);
			try { continuations?.transition(turn.continuation.producer, turn.continuation.completionId, turn.continuation.semanticFingerprint, "uncertain", Date.now(), "origin boundary changed before host start"); }
			catch { inboxFault = true; }
			submittedTelegramTurn = undefined; queuedTelegramTurns = queuedTelegramTurns.filter(candidate => candidate !== turn);
		}
		if (routingTelegram && turn) {
			if (turn.continuation) {
				const key = continuationTimerKey(turn.continuation), timer = continuationSubmissionTimers.get(key); if (timer) clearTimeout(timer);
				continuationSubmissionTimers.delete(key);
			}
			try {
				journalTurn(turn, "active");
				if (turn.continuation) { if (!continuations) throw new Error("continuation store unavailable"); continuations.transition(turn.continuation.producer, turn.continuation.completionId, turn.continuation.semanticFingerprint, "active", Date.now()); }
			}
			catch {
				// Host proceeds after this hook, even on error. Retain volatile routing.
				uncertainReply = turn;
				preserveQueuedTurnsAsHistory = true;
				updateStatus(ctx, "admission active marker failed; routing retained, operator repair required");
			}
			submittedTelegramTurn = undefined;
			queuedTelegramTurns.splice(queuedTelegramTurns.indexOf(turn), 1);
			activeTelegramTurn = turn;
			if (!turn.origin) {
				const origin = { provider: "telegram" as const, version: 1 as const, sessionId: ctx.sessionManager.getSessionId(),
					requestMarker: turn.marker, chatId: turn.chatId, replyToMessageId: turn.replyToMessageId,
					configDigest: configDigest(config), bridgeEpoch, stopGeneration };
				turn.origin = { ...origin, signature: originSignature(origin) };
			}
			awaitingTelegramStart = true;
			lastTelegramAssistant = {};
			previewState = { replyToMessageId: continuationReplyTo(activeTelegramTurn), mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
			startTypingLoop(ctx);
		}
		transition("before-agent-start", ctx);
		return { systemPrompt: event.systemPrompt + SYSTEM_PROMPT_SUFFIX +
			(routingTelegram ? "\n- The current user message came from Telegram." : "") };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (closed) return;
		settlementOwed = false;
		awaitingTelegramStart = false;
		preflightPending = false;
		transition("agent-start", ctx);
		if (compactionWakeTimer) clearTimeout(compactionWakeTimer);
		compactionWakeTimer = undefined;
		currentAbort = () => ctx.abort();
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if ((event.message as { role: string }).role === "user" && activeTelegramTurn &&
			!getMessageText(event.message).includes(activeTelegramTurn.marker)) {
			routingTelegram = false;
			stopTypingLoop();
		}
		if (closed || !routingTelegram || !activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		if (closed || !routingTelegram || !activeTelegramTurn) return;
		previewState = { replyToMessageId: continuationReplyTo(activeTelegramTurn), mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (closed || !routingTelegram || !activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { replyToMessageId: continuationReplyTo(activeTelegramTurn), mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("message_end", async (event) => {
		if (routingTelegram && activeTelegramTurn && isAssistantMessage(event.message)) {
			lastTelegramAssistant = extractAssistantText([event.message]);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!closed) transition("agent-end", ctx);
		if (routingTelegram && activeTelegramTurn) lastTelegramAssistant = extractAssistantText(event.messages);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!closed) transition(event.reason === "manual" ? "manual-compaction-start" : "auto-compaction-start", ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		if (!closed) transition(event.reason === "manual" ? "manual-compaction-complete" : "auto-compaction-complete", ctx);
		if (event.reason === "manual") wakeAfterManualCompaction(ctx);
		else drainTelegramQueue(ctx);
	});
	pi.on("session_compact_failed", (_event, ctx) => {
		if (!closed) transition("compaction-failed", ctx);
		drainTelegramQueue(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!closed) {
			settlementOwed = !!activeTelegramTurn;
			transition("agent-settled-observed", ctx);
		}
		await finalizeSettledTelegramTurn(ctx);
	});

	async function finalizeSettledTelegramTurn(ctx: ExtensionContext): Promise<void> {
		if (closed || preflightPending || finalizingReply || awaitingTelegramStart || !ctx.isIdle()) return;
		const turn = activeTelegramTurn;
		settlementOwed = false;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		routingTelegram = false;
		if (!turn) { drainTelegramQueue(ctx); return; }
		finalizingReply = true;
		finalizationStage = "preview-or-text";
		transition("finalization-start");
		updateStatus(ctx);
		let replyError: string | undefined;
		let localSuccess = false;
		try {
			const assistant = lastTelegramAssistant;
			if (assistant.stopReason === "aborted") {
				await clearPreview(turn.chatId);
				localSuccess = true; // Local abort handling, not request completion.
				return;
			}
			if (assistant.stopReason === "error") {
				await clearPreview(turn.chatId);
				await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.", continuationReplyTo(turn) !== undefined);
				localSuccess = true; // Error report locally finalized, not goal completion.
				return;
			}

			const finalText = assistant.text;
			if (previewState) {
				previewState.pendingText = finalText ?? previewState.pendingText;
			}

			if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
				const finalized = await finalizePreview(turn.chatId);
				if (!finalized) await sendTextReply(turn.chatId, turn.replyToMessageId, finalText, continuationReplyTo(turn) !== undefined);
			} else {
				await clearPreview(turn.chatId);
				if (finalText) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, finalText, continuationReplyTo(turn) !== undefined);
				} else if (turn.queuedAttachments.length > 0) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).", continuationReplyTo(turn) !== undefined);
				}
			}

			finalizationStage = "attachments";
			localSuccess = await sendQueuedAttachments(turn);
			if (!localSuccess) replyError = "attachment delivery failed; outcome uncertain, inspect locally";

		} catch (error) {
			uncertainReply = turn;
			transition("finalization-failed");
			replyError = "reply failed; outcome uncertain, inspect locally";
		} finally {
			finalizationStage = "preview-cleanup";
			try {
				await clearPreview(turn.chatId);
				if (!closed) journalTurn(turn, localSuccess ? "handled" : "uncertain");
				if (!closed && turn.continuation) {
					const handled = localSuccess && lastTelegramAssistant.stopReason !== "aborted";
					if (!continuations) throw new Error("continuation store unavailable");
					continuations.transition(turn.continuation.producer, turn.continuation.completionId, turn.continuation.semanticFingerprint, handled ? "handled" : "uncertain", Date.now(), handled ? undefined : "Telegram finalization not confirmed");
					if (handled) coldContinuations = Math.max(0, coldContinuations - 1);
				}
				if (!localSuccess && turn.incomingIds?.length) uncertainReply = turn;
				else if (localSuccess && uncertainReply === turn) uncertainReply = undefined;
			} catch { uncertainReply = turn; inboxFault = true; }
			finalizingReply = false;
			maybeReleaseLease();
			for (const resolve of replyWaiters.splice(0)) resolve();
			finalizationStage = "none";
			transition("finalization-finished");
			updateStatus(ctx, replyError);
			drainTelegramQueue(ctx);
		}
	}
}
