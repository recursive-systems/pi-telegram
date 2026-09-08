/** Producer-neutral, synchronous continuation protocol over Pi's process-local event bus. */
export const TELEGRAM_CONTINUATION_API_VERSION = 1 as const;
export const TELEGRAM_CONTINUATION_CAPTURE = "pi-telegram:continuation:v1:capture";
export const TELEGRAM_CONTINUATION_OFFER = "pi-telegram:continuation:v1:offer";

/** Opaque, bounded, serializable proof of the active Telegram-owned request. */
export type TelegramContinuationContext = string;

export interface TelegramContinuationCaptureRequest {
	version: typeof TELEGRAM_CONTINUATION_API_VERSION;
	capture(context: TelegramContinuationContext): void;
}

export type TelegramContinuationOfferMode = "dispatch" | "existing-only" | "inspection-only";
export type TelegramContinuationDisposition = "accepted" | "duplicate" | "retained-for-inspection" | "declined";

export interface TelegramContinuationResponse {
	version: typeof TELEGRAM_CONTINUATION_API_VERSION;
	disposition: TelegramContinuationDisposition;
}

export interface TelegramContinuationOfferRequest {
	version: typeof TELEGRAM_CONTINUATION_API_VERSION;
	producer: string;
	completionId: string;
	/** Required for dispatch/inspection-only; optional additional fence for existing-only. */
	context?: TelegramContinuationContext;
	content: string;
	/** Producer-owned SHA-256 over every protocol-specific semantic field. */
	semanticFingerprint: string;
	mode: TelegramContinuationOfferMode;
	reply(response: TelegramContinuationResponse): void;
}

export function validContinuationProducer(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128 &&
		/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}

export function validContinuationId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 &&
		!/[\u0000-\u001f\u007f]/.test(value);
}

export function validSemanticFingerprint(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validContinuationContext(value: unknown): value is TelegramContinuationContext {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(value);
}
