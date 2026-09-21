/** Pure helpers for the remote `/model` route. No host, network or filesystem access. */

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof thinkingLevels)[number];

export interface ModelSelection {
	provider?: string;
	model: string;
	thinking?: ThinkingLevelName;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface ModelCandidate extends ModelRef {
	auth: boolean;
}

export const MODEL_LIST_LIMIT = 40;

const PROVIDER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MODEL_PATTERN = /^[A-Za-z0-9_.:/@-]{1,128}$/;

export function modelLabel(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

/**
 * `""` → undefined (show current model and choices).
 * `"<provider>/<id> [thinking]"` or `"<id> [thinking]"` → selection.
 * Anything else → "invalid". Model text keeps its case; the thinking level is case-insensitive.
 */
export function parseModelSelection(args: string): ModelSelection | undefined | "invalid" {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return undefined;
	if (tokens.length > 2) return "invalid";
	const [target, level] = tokens;
	const slash = target.indexOf("/");
	const provider = slash === -1 ? undefined : target.slice(0, slash);
	const model = slash === -1 ? target : target.slice(slash + 1);
	if ((provider !== undefined && !PROVIDER_PATTERN.test(provider)) || !MODEL_PATTERN.test(model)) return "invalid";
	const selection: ModelSelection = provider === undefined ? { model } : { provider, model };
	if (level !== undefined) {
		const thinking = thinkingLevels.find((name) => name === level.toLowerCase());
		if (!thinking) return "invalid";
		selection.thinking = thinking;
	}
	return selection;
}

/** Exact match on id (and provider when given) against the session's candidates only. */
export function resolveModelSelection<T extends ModelRef>(selection: ModelSelection, candidates: readonly T[]): { model: T } | { error: string } {
	const matches = candidates.filter((candidate) => candidate.id === selection.model &&
		(selection.provider === undefined || candidate.provider === selection.provider));
	if (matches.length === 1) return { model: matches[0] };
	const requested = selection.provider === undefined ? selection.model : `${selection.provider}/${selection.model}`;
	if (matches.length === 0) return { error: `${requested} is not available in this session. Send /model to list choices.` };
	return { error: `${requested} is ambiguous; use the full name: ${matches.slice(0, MODEL_LIST_LIMIT).map(modelLabel).join(", ")}` };
}

export function describeModels(current: ModelRef | undefined, thinking: string | undefined, candidates: readonly ModelCandidate[], scoped: boolean): string {
	const lines = [
		`Model: ${current ? modelLabel(current) : "unknown"}${thinking ? ` (thinking: ${thinking})` : ""}`,
		scoped ? "Available in this session (scoped):" : "Available in this session:",
	];
	if (candidates.length === 0) lines.push("No models.");
	for (const candidate of candidates.slice(0, MODEL_LIST_LIMIT)) {
		const active = current && current.provider === candidate.provider && current.id === candidate.id;
		// Plain text only: replies are rendered as markdown, so no list markers or angle brackets.
		lines.push(`${modelLabel(candidate)}${active ? " (active)" : ""}${candidate.auth ? "" : " (no credentials)"}`);
	}
	if (candidates.length > MODEL_LIST_LIMIT) lines.push(`[${candidates.length - MODEL_LIST_LIMIT} more; inspect locally]`);
	lines.push(`Switch: /model provider/id [thinking], thinking one of ${thinkingLevels.join(", ")}. A bare id works when unique.`);
	return lines.join("\n");
}
