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

import { markdownToTelegramHtml } from "./markdown-to-telegram.ts";

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
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
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

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
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
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let reloadPending = false;
	let reloadRunning = false;
	let checkpoint: ReloadCheckpoint | undefined;
	let restoreStarted = false;
	let recoveryRequired = false;
	let restoredDisconnected = false;
	let uncertainReply: ActiveTelegramTurn | undefined;
	const failedPreparations: TelegramMessage[][] = [];
	const failedIngress: TelegramUpdate[] = [];
	const replyWaiters: Array<() => void> = [];
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
		const blocker = closed ? "closed" : recoveryRequired ? "recovery-required" : reloadPending ? "reload-pending" :
			restoredDisconnected ? "restored-disconnected" : failedPreparations.length || failedIngress.length ? "failed-ingress-or-preparation" : state.preflight ? "preflight" : state.held ? "held" :
			state.submitted ? "submitted" : state.active ? "active-awaiting-settlement" :
			state.finalizing ? "finalizing" : !hostIdle ? "host-busy" : hostPending ? "host-pending" :
			queuedTelegramTurns.length ? "awaiting-drain" : state.preparing ? "preparing" : "none";
		return { instance, loadedAt, closed, configured: !!config.botToken, paired: config.allowedUserId !== undefined, polling: !!pollingPromise,
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
		if (closed) throw new Error("Telegram session shut down");
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal ? AbortSignal.any([options.signal, sessionController.signal]) : sessionController.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
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
			throw new Error(data.description || `Telegram API ${method} failed`);
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
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
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
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
				state.messageId = sent.message_id;
			} catch {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
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
			await sendFormattedText(chatId, finalText);
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	/** Send `text` preferring formatted HTML, falling back to plain text on rejection. */
	async function sendFormattedText(chatId: number, text: string): Promise<number | undefined> {
		try {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: markdownToTelegramHtml(text), parse_mode: "HTML" });
			return sent.message_id;
		} catch {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text });
			return sent.message_id;
		}
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			lastMessageId = await sendFormattedText(chatId, chunk);
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				uncertainReply = turn;
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
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
		if (!ctx.hasUI || setupInProgress || reloadPending) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
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
			marker,
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: [...historyTurns.map((turn) => turn.historyText), formatTelegramHistoryText(rawText, files)].join("\n\n"),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (closed || !firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			preserveQueuedTurnsAsHistory = true;
			transition("stop-held");
			stopGeneration++;
			if (currentAbort) {
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (lower === "/version") {
			const version = await getExtensionVersion();
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `pi-telegram extension @ ${version}`);
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					if (closed) return;
					drainTelegramQueue(ctx);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.").catch((error) => updateStatus(ctx, String(error)));
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					if (closed) return;
					drainTelegramQueue(ctx);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`).catch((error) => updateStatus(ctx, String(error)));
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

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
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
			transition("preparation-failed");
			failedPreparations.push(structuredClone(messages));
			updateStatus(ctx, "attachment preparation failed; work retained, dispatch blocked");
		}).finally(() => { preparationCount--; transition("preparation-finished"); });
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

	function submitNextTelegramTurn(ctx: ExtensionContext): void {
		if (closed || reloadPending || restoredDisconnected || failedPreparations.length || failedIngress.length || preflightPending || preserveQueuedTurnsAsHistory || submittedTelegramTurn || activeTelegramTurn || finalizingReply ||
			!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const turn = queuedTelegramTurns[0];
		if (!turn) return;
		submittedTelegramTurn = turn;
		transition("submitted");
		updateStatus(ctx);
		try {
			pi.sendUserMessage(turn.content);
		} catch (error) {
			// A synchronous rejection did not accept the turn. Keep it in FIFO order.
			if (submittedTelegramTurn === turn) submittedTelegramTurn = undefined;
			transition("submission-sync-rejected");
			updateStatus(ctx, `submission failed: ${String(error)}`);
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
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

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
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
				config.lastUpdateId = last?.update_id ?? 0;
				await writeConfig(config);
			} catch {
				// ignore
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
						config.lastUpdateId = update.update_id;
						await writeConfig(config);
						await handleUpdate(update, ctx);
					} catch (error) {
						failedIngress.push(update);
						throw error;
					}
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
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
		if (closed || reloadPending || !config.botToken || pollingPromise) return;
		restoredDisconnected = false;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			updateStatus(ctx);
		});
		updateStatus(ctx);
		drainTelegramQueue(ctx);
	}

	function refuseReload(ctx: ExtensionContext): boolean {
		if (uncertainReply || submittedTelegramTurn || preflightPending || failedPreparations.length || failedIngress.length || setupInProgress) {
			ctx.ui.notify("Telegram reload refused: unacknowledged/preflight, uncertain reply, or failed preparation work. Preserve affected messages before ordinary teardown; no automatic replay.", "error");
			return true;
		}
		return false;
	}

	pi.registerCommand("telegram-reload", {
		description: "Explicit runtime reload with a one-shot Telegram queue handoff (does not upgrade source)",
		handler: async (_args, ctx) => {
			if (closed || reloadRunning || recoveryRequired) return;
			reloadPending = true;
			reloadRunning = true;
			let stopped = false;
			try {
				if (refuseReload(ctx)) { reloadPending = false; reloadRunning = false; return; }
				await ctx.waitForIdle();
				if (finalizingReply) await new Promise<void>(resolve => replyWaiters.push(resolve));
				if (closed) return;
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
				if (!persisted) {
					reloadPending = false;
					reloadRunning = false;
					ctx.ui.notify("Telegram reload refused: session file is not persisted yet. Let Pi save an assistant response before retrying; queued work remains in this instance.", "error");
					return;
				}
				// Abort ONLY polling, not the session signal used by ingress/downloads/replies.
				stopped = true;
				// If handoff fails after quiescing, unrelated idle events must not
				// silently run a disconnected queue. Explicit connect releases it.
				restoredDisconnected = true;
				await stopPolling();
				for (const state of mediaGroups.values()) {
					if (state.flushTimer) clearTimeout(state.flushTimer);
					state.ready();
				}
				mediaGroups.clear();
				await preparingTurns;
				if (closed) return;
				if (refuseReload(ctx) || activeTelegramTurn || finalizingReply || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("not safe after quiescing");
				const diskConfig = await readConfig();
				if (configDigest(diskConfig) !== configDigest(config) || diskConfig.lastUpdateId !== config.lastUpdateId) throw new Error("config changed");
				if (closed) return;
				// No async work between this final admission check and snapshot/reload.
				if (refuseReload(ctx) || activeTelegramTurn || finalizingReply || !ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("not safe after config verification");
				checkpoint = structuredClone({ version: 1, reason: "telegram-reload", nonce: randomUUID(), sessionId, sessionFile,
					configDigest: configDigest(config), connected, cursor: config.lastUpdateId,
					held: preserveQueuedTurnsAsHistory, stopGeneration, turns: queuedTelegramTurns });
				// Bound session growth; never silently truncate private text or image inputs.
				if (Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024) throw new Error("checkpoint too large");
				pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
				reloadState.permits.set(checkpoint.nonce, { digest: digest(checkpoint), armed: false, expires: Date.now() + 120_000 });
			} catch {
				if (closed) return;
				checkpoint = undefined;
				reloadRunning = false;
				reloadPending = false;
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

	pi.registerTool({
		name: "telegram_reload",
		label: "Telegram Reload",
		description: "Schedule /telegram-reload safely after the current turn and Telegram reply. ONLY call with explicit user authorization to reload this runtime. Never reload autonomously. Does not install or upgrade source.",
		parameters: Type.Object({}),
		async execute() {
			if (!reloadPending && !closed) {
				reloadPending = true;
				// Command dispatch precedes streaming checks. Do not await it from the tool:
				// the command itself waits for host idle, including this tool's final turn.
				pi.sendUserMessage("/telegram-reload", { deliverAs: "followUp", expandPromptTemplates: true });
			}
			return { content: [{ type: "text", text: "Requested /telegram-reload; completion is reported locally. This is not an admission or reconnection acknowledgement." }], details: {} };
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

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge gates and ages (detail: full bounded lifecycle history)",
		handler: async (args, ctx) => {
			const checkoutVersion = await getExtensionVersion();
			const snapshot = diagnostics(ctx);
			const { instance, loadedAt, configured, paired, polling, blocker, queued, submitted, preflight, active, finalizing,
				held, settlementOwed, finalizationStage, hostIdle, hostPending, agesMs } = snapshot;
			const view = args.trim() === "detail" ? snapshot : { instance, loadedAt, configured, paired, polling, blocker, queued,
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
			if (reloadPending || recoveryRequired) {
				ctx.ui.notify("Telegram handoff pending or recovery required; inspect the retained session checkpoint before any reconnect.", "error");
				return;
			}
			config = await readConfig();
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
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		// CLI/restored flags are applied after the factory, before session_start.
		registerDiagnosticsTool();
		transition("session-start");
		if (restoreStarted) return;
		restoreStarted = true;
		if (event.reason !== "reload") {
			config = await readConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			updateStatus(ctx);
			return;
		}
		const entries = ctx.sessionManager.getEntries();
		const entry = [...entries].reverse().find(e => e.type === "custom" && e.customType === CHECKPOINT_TYPE);
		if (!entry || entry.type !== "custom") {
			config = await readConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			updateStatus(ctx);
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
			config = await readConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			updateStatus(ctx);
			ctx.ui.notify("No valid live Telegram reload handoff; disconnected. Any archived checkpoint remains private session data, not permission to replay it.", "info");
			return;
		}
		reloadPending = true;
		recoveryRequired = true;
		try {
			pi.appendEntry(CLAIM_TYPE, { nonce: saved.nonce });
			config = await readConfig();
			await mkdir(TEMP_DIR, { recursive: true });
			if (saved.configDigest !== configDigest(config) || saved.cursor !== config.lastUpdateId) throw new Error("config mismatch");
			queuedTelegramTurns = structuredClone(saved.turns);
			restoredDisconnected = !saved.connected;
			preserveQueuedTurnsAsHistory = saved.held;
			stopGeneration = saved.stopGeneration;
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
		if (checkpoint) {
			const permit = reloadState.permits.get(checkpoint.nonce);
			if (permit) permit.armed = event.reason === "reload";
		}
		closed = true;
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
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (closed) return;
		preflightPending = true;
		const turn = submittedTelegramTurn;
		routingTelegram = !!turn && event.prompt.includes(turn.marker);
		if (routingTelegram && turn) {
			submittedTelegramTurn = undefined;
			queuedTelegramTurns.splice(queuedTelegramTurns.indexOf(turn), 1);
			activeTelegramTurn = turn;
			awaitingTelegramStart = true;
			lastTelegramAssistant = {};
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
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
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (closed || !routingTelegram || !activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
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
		try {
			const assistant = lastTelegramAssistant;
			if (assistant.stopReason === "aborted") {
				await clearPreview(turn.chatId);
				return;
			}
			if (assistant.stopReason === "error") {
				await clearPreview(turn.chatId);
				await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
				return;
			}

			const finalText = assistant.text;
			if (previewState) {
				previewState.pendingText = finalText ?? previewState.pendingText;
			}

			if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
				const finalized = await finalizePreview(turn.chatId);
				if (!finalized) await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else {
				await clearPreview(turn.chatId);
				if (finalText) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
				} else if (turn.queuedAttachments.length > 0) {
					await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
				}
			}

			finalizationStage = "attachments";
			await sendQueuedAttachments(turn);

		} catch (error) {
			uncertainReply = turn;
			transition("finalization-failed");
			replyError = `reply failed: ${String(error)}`;
		} finally {
			finalizationStage = "preview-cleanup";
			await clearPreview(turn.chatId);
			finalizingReply = false;
			for (const resolve of replyWaiters.splice(0)) resolve();
			finalizationStage = "none";
			transition("finalization-finished");
			updateStatus(ctx, replyError);
			drainTelegramQueue(ctx);
		}
	}
}
