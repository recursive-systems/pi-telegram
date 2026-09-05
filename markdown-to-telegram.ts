/** Markdown -> Telegram's small HTML subset, using Pi's public parser export. */
import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";

// Private instance: never change Pi's parser or another extension's defaults.
const md = new Marked({ gfm: true, breaks: false, pedantic: false });
// Keep bare URLs literal, as before. Explicit/autolinks still use Marked's parser.
md.use({ tokenizer: { url() { return undefined; } } });

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Telegram supports these named entities and numeric references, not HTML's full table.
 * Unknown names remain literal rather than emitting entities Telegram rejects.
 * Decode exactly once, outside code/raw HTML only.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (raw, entity: string) => {
    const named: Record<string, string> = { amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'" };
    if (entity[0] !== "#") return named[entity] ?? raw;
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
  });
}

function safeHref(href: string): boolean {
  if (!/^(https?:\/\/|tg:\/\/|mailto:)/i.test(href) || /[\s\u0000-\u001f\u007f\ufffd]/u.test(href)) return false;
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" ? !!url.pathname : !!url.hostname;
  } catch { return false; }
}

function renderInline(tokens: Token[]): string {
  return tokens.map((tok): string => {
    switch (tok.type) {
      case "text": return tok.tokens ? renderInline(tok.tokens) : esc(decodeEntities(tok.text));
      case "escape": return esc(tok.text);
      case "html": return esc(tok.raw);
      case "codespan": return `<code>${esc(tok.text)}</code>`;
      case "strong": return `<b>${renderInline(tok.tokens ?? [])}</b>`;
      case "em": return `<i>${renderInline(tok.tokens ?? [])}</i>`;
      case "del":
        // Marked accepts ~single~ strike; retain unsupported single delimiters.
        return tok.raw.startsWith("~~") ? `<s>${renderInline(tok.tokens ?? [])}</s>` : esc(tok.raw);
      case "link": {
        const href = decodeEntities(tok.href);
        const label = renderInline(tok.tokens ?? []);
        return safeHref(href) ? `<a href="${esc(href)}">${label}</a>` : esc(tok.raw);
      }
      case "image": return `[${esc(decodeEntities(tok.text || "image"))}]`;
      case "br": return "\n";
      case "checkbox": return esc(tok.raw);
      default: return esc(tok.raw);
    }
  }).join("");
}

function renderList(tok: Tokens.List, inQuote: boolean): string {
  return tok.items.map((item, i) => {
    const marker = tok.ordered ? `${Number(tok.start) + i}. ` : "• ";
    const checkbox = item.tokens[0]?.type === "checkbox" ? esc(item.tokens[0].raw) : "";
    const entries = renderBlocks(checkbox ? item.tokens.slice(1) : item.tokens, inQuote);
    const [first = "", ...rest] = entries;
    return [marker + checkbox + first, ...rest.map(entry => entry.split("\n").map(line => " ".repeat(marker.length) + line).join("\n"))].join("\n");
  }).join("\n");
}

function renderBlocks(tokens: Token[], inQuote = false): string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    switch (tok.type) {
      case "space": case "def": break;
      case "paragraph": case "text":
        out.push(tok.tokens ? renderInline(tok.tokens) : esc(decodeEntities(tok.text)));
        break;
      case "heading": out.push(`<b>${renderInline(tok.tokens ?? [])}</b>`); break;
      case "code": {
        // Marked strips the final newline; keep code content otherwise verbatim.
        const needsNewline = tok.text && (tok.codeBlockStyle !== "indented" || !tok.text.endsWith("\n"));
        const content = esc(tok.text + (needsNewline ? "\n" : ""));
        const lang = decodeEntities(tok.lang ?? "").trim().split(/\s+/)[0];
        const cls = lang ? ` class="language-${esc(lang)}"` : "";
        out.push(tok.codeBlockStyle === "indented" ? `<pre>${content}</pre>` : `<pre><code${cls}>${content}</code></pre>`);
        break;
      }
      case "blockquote": {
        const inner = renderBlocks(tok.tokens ?? [], true).join("\n");
        // Telegram forbids nested blockquotes. Flatten, retaining the content.
        out.push(inQuote ? inner : `<blockquote>${inner}</blockquote>`);
        break;
      }
      case "list": out.push(renderList(tok as Tokens.List, inQuote)); break;
      case "table": {
        const table = tok as Tokens.Table;
        out.push([table.header, ...table.rows].map(row => row.map(cell => renderInline(cell.tokens)).join(" | ")).join("\n"));
        break;
      }
      case "hr": out.push("──────────"); break;
      case "checkbox":
        // Marked 18 emits a separate task marker ahead of the item's text.
        out.push(esc(tok.raw)); break;
      default: out.push(esc(tok.raw));
    }
  }
  return out.filter(Boolean);
}

/** Convert complete or streamed Markdown; parser failures retain escaped source. */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown.trim()) return esc(markdown);
  try {
    return renderBlocks(md.lexer(markdown)).join("\n\n") || esc(markdown);
  } catch {
    return esc(markdown);
  }
}
