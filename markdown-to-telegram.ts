/**
 * Markdown -> Telegram HTML converter.
 *
 * Ported from the headless bridge (../pi-telegram/src/markdown-to-telegram.ts).
 *
 * Telegram only supports a tiny HTML subset (b, i, u, s, a, code, pre,
 * blockquote, tg-emoji) and *rejects* messages containing anything else
 * (no <p>, <h1>, <ul>, <table>...). So we can't just render markdown to
 * generic HTML: we walk markdown-it's token stream and emit Telegram-safe
 * HTML directly:
 *
 *   # heading      -> <b>bold line</b>
 *   **bold**       -> <b>
 *   *italic*       -> <i>
 *   ~~strike~~     -> <s>
 *   `code`         -> <code>
 *   ```fenced```   -> <pre><code class="language-x">
 *   > quote        -> <blockquote>
 *   - item / 1. x  -> "• " / "1. " prefixed lines
 *   tables         -> pipe-separated lines
 *   links          -> <a href> (only http(s)/tg/mailto; others fall back to text)
 */
import MarkdownIt, { type Token } from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

const esc = md.utils.escapeHtml;

/** Schemes Telegram accepts in an href. */
const SAFE_HREF = /^(https?:\/\/|tg:\/\/|mailto:)/i;

function findMatchingClose(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].nesting === 1) depth++;
    else if (tokens[i].nesting === -1 && --depth === 0) return i;
  }
  return tokens.length - 1;
}

function renderInline(tokens: Token[]): string {
  let out = "";
  const linkStack: boolean[] = []; // true = the open link emitted an <a>

  for (const tok of tokens) {
    switch (tok.type) {
      case "text":
      case "text_special":
      case "html_inline":
        out += esc(tok.content);
        break;
      case "code_inline":
        out += `<code>${esc(tok.content)}</code>`;
        break;
      case "strong_open":
        out += "<b>";
        break;
      case "strong_close":
        out += "</b>";
        break;
      case "em_open":
        out += "<i>";
        break;
      case "em_close":
        out += "</i>";
        break;
      case "s_open":
      case "del_open":
        out += "<s>";
        break;
      case "s_close":
      case "del_close":
        out += "</s>";
        break;
      case "link_open": {
        const href = String(tok.attrGet("href") ?? "");
        const ok = SAFE_HREF.test(href);
        linkStack.push(ok);
        if (ok) out += `<a href="${esc(href)}">`;
        break;
      }
      case "link_close":
        if (linkStack.pop()) out += "</a>";
        break;
      case "autolink": {
        const href = String(tok.attrGet("href") ?? tok.content);
        if (SAFE_HREF.test(href)) out += `<a href="${esc(href)}">${esc(tok.content)}</a>`;
        else out += esc(tok.content);
        break;
      }
      case "image":
        out += `[${esc(tok.content || "image")}]`;
        break;
      case "hardbreak":
      case "softbreak":
        out += "\n";
        break;
      default:
        if (tok.nesting === 0 && tok.content) out += esc(tok.content);
    }
  }
  return out;
}

function renderTable(tokens: Token[]): string {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "tr_open") row = [];
    else if (tok.type === "th_open" || tok.type === "td_open") {
      const inline = tokens[i + 1]?.type === "inline" ? tokens[i + 1] : null;
      row.push(renderInline(inline?.children ?? []));
    } else if (tok.type === "tr_close") {
      rows.push(row);
      row = [];
    }
    i++;
  }
  return rows.map((r) => r.join(" | ")).join("\n");
}

function renderListItems(tokens: Token[], ordered: boolean, start: number): string[] {
  const lines: string[] = [];
  let i = 0;
  let n = start;
  while (i < tokens.length) {
    if (tokens[i].type === "list_item_open") {
      const closeIdx = findMatchingClose(tokens, i);
      const entries = renderBlocks(tokens.slice(i + 1, closeIdx));
      const marker = ordered ? `${n}. ` : "• ";
      const pad = " ".repeat(marker.length);
      const [first, ...rest] = entries.length ? entries : [""];
      lines.push(
        marker + first,
        ...rest.map((entry) =>
          entry
            .split("\n")
            .map((line) => pad + line)
            .join("\n")
        )
      );
      n++;
      i = closeIdx + 1;
    } else {
      i++;
    }
  }
  return lines;
}

/** Renders block-level tokens; each array entry is one "paragraph-ish" block. */
function renderBlocks(tokens: Token[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    switch (tok.type) {
      case "paragraph_open":
      case "heading_open": {
        const inline = tokens[i + 1]?.type === "inline" ? tokens[i + 1] : null;
        const text = renderInline(inline?.children ?? []);
        out.push(tok.type === "heading_open" ? `<b>${text}</b>` : text);
        i += 3; // open, inline, close
        break;
      }
      case "fence": {
        const lang = tok.info.trim().split(/\s+/)[0];
        const cls = lang ? ` class="language-${esc(lang)}"` : "";
        out.push(`<pre><code${cls}>${esc(tok.content)}</code></pre>`);
        i += 1;
        break;
      }
      case "code_block":
        out.push(`<pre>${esc(tok.content)}</pre>`);
        i += 1;
        break;
      case "blockquote_open": {
        const closeIdx = findMatchingClose(tokens, i);
        const inner = renderBlocks(tokens.slice(i + 1, closeIdx));
        out.push(`<blockquote>${inner.join("\n")}</blockquote>`);
        i = closeIdx + 1;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const closeIdx = findMatchingClose(tokens, i);
        const ordered = tok.type === "ordered_list_open";
        const start = ordered ? Number(tok.attrGet("start") ?? 1) || 1 : 1;
        out.push(renderListItems(tokens.slice(i + 1, closeIdx), ordered, start).join("\n"));
        i = closeIdx + 1;
        break;
      }
      case "table_open": {
        const closeIdx = findMatchingClose(tokens, i);
        out.push(renderTable(tokens.slice(i + 1, closeIdx)));
        i = closeIdx + 1;
        break;
      }
      case "hr":
        out.push("──────────");
        i += 1;
        break;
      case "html_block":
        out.push(esc(tok.content));
        i += 1;
        break;
      case "inline":
        out.push(renderInline(tok.children ?? []));
        i += 1;
        break;
      default:
        // open/close tags of blocks handled above, or unknown types: skip
        i += 1;
    }
  }

  return out.filter((s) => s.length > 0);
}

/** Convert a markdown string to Telegram-safe HTML. */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown.trim()) return esc(markdown);
  const html = renderBlocks(md.parse(markdown, {})).join("\n\n");
  return html || esc(markdown);
}
