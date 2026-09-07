/** Explicit remote adapters only. Pi discovery is help metadata, never permission. */
export const telegramCommands = [
	{ command: "commands", description: "List Telegram commands and local-only Pi names", args: "" },
	{ command: "help", description: "Show Telegram help", args: "" },
	{ command: "start", description: "Show Telegram help", args: "" },
	{ command: "status", description: "Show model and token usage", args: "" },
	{ command: "bridge_status", description: "Show content-free bridge state", args: "[detail]" },
	{ command: "version", description: "Show cached checkout version (not loaded-code proof)", args: "" },
	{ command: "compact", description: "Compact idle Pi context with optional instructions", args: "[instructions]" },
	{ command: "stop", description: "Abort the run and hold queued history", args: "" },
	{ command: "telegram_reload", description: "Request safe runtime reload (not an upgrade)", args: "" },
] as const;

export function parseTelegramCommand(text: string, ownUsername?: string) {
	const raw = text.trim();
	if (raw.toLowerCase() === "stop") return { name: "stop", args: "" };
	if (!raw.startsWith("/")) return undefined;
	const match = /^\/([^\s@]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(raw);
	if (!match) return { name: "", args: "" };
	if (match[2] && (!ownUsername || match[2].toLowerCase() !== ownUsername.toLowerCase()))
		return { name: "", args: "", foreign: true };
	return { name: match[1].toLowerCase(), args: match[3] ?? "" };
}

export function telegramHelp(discovered: unknown): string {
	const lines = ["Telegram commands (implemented remotely):", ...telegramCommands.map(c => `/${c.command}${c.args ? ` ${c.args}` : ""} — ${c.description}`),
		"Bare stop also works. Commands require standalone text; captions remain normal input.",
		"Other slash commands are not executed or forwarded. /reload: use /telegram_reload.",
		"/telegram-inbox is LOCAL ONLY: inspect/reconcile retained input; no remote acknowledge or replay.",
		"Pi catalog — LOCAL ONLY, not supported remotely (no automatic aliases):"];
	if (!Array.isArray(discovered)) return [...lines, "Catalog unavailable."].join("\n");
	const seen = new Set<string>();
	let omitted = discovered.length > 200;
	for (const item of discovered.slice(0, 200)) {
		if (!item || typeof item !== "object" || typeof item.name !== "string" ||
			! /^[a-zA-Z0-9_][a-zA-Z0-9_:-]{0,63}$/.test(item.name) ||
			! ["extension", "prompt", "skill"].includes(item.source)) { omitted = true; continue; }
		const label = `${item.name} (${item.source})`;
		if (seen.has(label)) continue;
		if (seen.size >= 12) { omitted = true; continue; }
		seen.add(label);
		lines.push(label); // No descriptions or sourceInfo: these can contain paths/secrets.
	}
	if (!seen.size) lines.push("No displayable names.");
	if (omitted) lines.push("[Catalog truncated/filtered; inspect full catalog locally.]");
	lines.push("Interactive Pi built-ins are not discovered by getCommands.");
	return lines.join("\n");
}
