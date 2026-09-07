/** Public same-process jobs/bridge protocol. No request body or credentials. */
export interface JobOrigin {
	provider: "telegram";
	version: 1;
	sessionId: string;
	requestMarker: string;
	chatId: number;
	replyToMessageId: number;
	configDigest: string;
	bridgeEpoch: string;
	stopGeneration: number;
	signature: string;
}
export const ORIGIN_CAPTURE = "jobs:origin:capture:v1";
export const ORIGIN_CLAIM = "jobs:origin:claim:v1";
export const ORIGIN_READY = "jobs:origin:ready:v1";
const keys = ["provider", "version", "sessionId", "requestMarker", "chatId", "replyToMessageId", "configDigest", "bridgeEpoch", "stopGeneration", "signature"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validEpoch(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
export function validOrigin(value: unknown): value is JobOrigin {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const o = value as JobOrigin;
	return Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k)) &&
		o.provider === "telegram" && o.version === 1 && typeof o.sessionId === "string" &&
		o.sessionId.length > 0 && o.sessionId.length <= 200 && !/[\u0000-\u001f]/.test(o.sessionId) &&
		typeof o.requestMarker === "string" && /^\[turn:[0-9a-f-]{36}\]$/.test(o.requestMarker) &&
		Number.isSafeInteger(o.chatId) && o.chatId > 0 && Number.isSafeInteger(o.replyToMessageId) && o.replyToMessageId > 0 &&
		typeof o.configDigest === "string" && /^[0-9a-f]{64}$/.test(o.configDigest) && validEpoch(o.bridgeEpoch) &&
		Number.isSafeInteger(o.stopGeneration) && o.stopGeneration >= 0 &&
		typeof o.signature === "string" && /^[0-9a-f]{64}$/.test(o.signature);
}
/** Stable exact-request grouping, independent of input property order. */
export function originKey(o: JobOrigin): string { return JSON.stringify(keys.map(k => o[k as keyof JobOrigin])); }
export interface OriginCapture { sessionId: string; capture: (origin: JobOrigin) => void; }
export interface OriginClaim { origin: JobOrigin; text: string; accept: () => void; }
