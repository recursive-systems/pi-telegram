import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from '@earendil-works/pi-tui';
import { markdownToTelegramHtml as render } from '../markdown-to-telegram.ts';

// Expected outputs compared offline with the original markdown-it formatter.
// Intentional differences have their own fixtures below; no oracle dependency remains.
const parity = [
  ['empty', '', ''],
  ['whitespace', ' \n\t', ' \n\t'],
  ['heading', '# Heading', '<b>Heading</b>'],
  ['setext', 'Heading\n===', '<b>Heading</b>'],
  ['nesting', '***bold italic*** and ~~strike~~', '<i><b>bold italic</b></i> and <s>strike</s>'],
  ['strike nesting', '**bold ~~gone~~**', '<b>bold <s>gone</s></b>'],
  ['underscore', '_a_ __b__ foo_bar_baz', '<i>a</i> <b>b</b> foo_bar_baz'],
  ['inline code', '`**x** &amp; <x>`', '<code>**x** &amp;amp; &lt;x&gt;</code>'],
  ['code backticks', '`` `a` ``', '<code>`a`</code>'],
  ['fence', '```js\nx < y\n```', '<pre><code class="language-js">x &lt; y\n</code></pre>'],
  ['indented code', '    x < y\n', '<pre>x &lt; y\n</pre>'],
  ['fence literal', '~~~\n**bold** &amp; <b>\n~~~', '<pre><code>**bold** &amp;amp; &lt;b&gt;\n</code></pre>'],
  ['language info', '```ts extra info\nx\n```', '<pre><code class="language-ts">x\n</code></pre>'],
  ['nested list', '- a\n  - b\n- c', '• a\n  • b\n• c'],
  ['ordered start', '3. a\n4. b', '3. a\n4. b'],
  ['loose list', '- a\n\n  b\n\n- c', '• a\n  b\n• c'],
  ['quote', '> first\n>\n> second', '<blockquote>first\nsecond</blockquote>'],
  ['table', 'a | b\n--|--\nc|d', 'a | b\nc | d'],
  ['formatted table', '**a** | `b`\n--|--\nc|d', '<b>a</b> | <code>b</code>\nc | d'],
  ['link entities', '[x](https://x/?a=1&amp;b=2)', '<a href="https://x/?a=1&amp;b=2">x</a>'],
  ['nested link label', '[**x**](https://x)', '<a href="https://x"><b>x</b></a>'],
  ['image', '![alt](https://x)', '[alt]'],
  ['empty image', '![](https://x)', '[image]'],
  ['breaks', 'a  \nb\nc', 'a\nb\nc'],
  ['escaped break', 'a\\\nb', 'a\nb'],
  ['rule', '---', '──────────'],
  ['unfinished emphasis', '**unfinished', '**unfinished'],
  ['unfinished code', '`unfinished', '`unfinished'],
  ['unfinished link', '[x](https://', '[x](https://'],
  ['html', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['entities', '&amp; &lt; &#x1f600; &#169; &quot;', '&amp; &lt; 😀 © &quot;'],
  ['no recursive entities', '&amp;lt;', '&amp;lt;'],
  ['unicode', '你好 👩🏽‍💻 café', '你好 👩🏽‍💻 café'],
  ['javascript', '[x](javascript:alert(1))', '[x](javascript:alert(1))'],
  ['task', '- [x] done', '• [x] done'],
  ['bare URL', 'https://example.com', 'https://example.com'],
  ['autolink', '<https://example.com>', '<a href="https://example.com">https://example.com</a>'],
  ['tg', '[x](tg://user?id=1)', '<a href="tg://user?id=1">x</a>'],
  ['mailto', '[x](mailto:a@example.com)', '<a href="mailto:a@example.com">x</a>'],
  ['reference', '[x][ref]\n\n[ref]: https://example.com', '<a href="https://example.com">x</a>'],
];
for (const [name, input, expected] of parity) test(name, () => assert.equal(render(input), expected));

const differences = [
  ['unsupported entity preserved', '&copy; &bogus;', '&amp;copy; &amp;bogus;'],
  ['unsafe scheme retains source', '[x](ftp://x)', '[x](ftp://x)'],
  ['nested quotes flattened', '> outer\n>> inner', '<blockquote>outer\ninner</blockquote>'],
  ['streamed fence newline normalized', '```py\nx', '<pre><code class="language-py">x\n</code></pre>'],
  ['html block is literal', '<div>**bold**</div>', '&lt;div&gt;**bold**&lt;/div&gt;'],
];
for (const [name, input, expected] of differences) test(name, () => assert.equal(render(input), expected));

test('uses real public Pi Marked, without changing global parser defaults', () => {
  assert.equal(new Marked().lexer('# x')[0].type, 'heading');
  render('https://example.com');
  assert.equal(new Marked().lexer('https://example.com')[0].tokens[0].type, 'link');
});

test('valid uppercase basic entities decode in text and link destinations', () => {
  assert.equal(render('&AMP; &LT; &GT; &QUOT;'), '&amp; &lt; &gt; &quot;');
  assert.equal(render('[x](https://example.com/?a=1&AMP;b=2)'), '<a href="https://example.com/?a=1&amp;b=2">x</a>');
  assert.equal(render('&aMp; &lT; &APOS;'), '&amp;aMp; &amp;lT; &amp;APOS;');
});

test('untrusted links retain their complete escaped source, never active anchors', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///tmp/x', '//example.com', 'https://', 'mailto:', 'java&#115;cript:alert(1)', 'https://x/&#10;bad', 'https://x/&#0;bad']) {
    const input = `[label](${url})`;
    const expected = input.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    assert.equal(render(input), expected, url);
  }
});

test('attribute values cannot inject HTML', () => {
  assert.equal(render('[x](https://x/?q=&quot;evil&quot;)',), '<a href="https://x/?q=&quot;evil&quot;">x</a>');
  assert.equal(render('```x"/><b>\ny\n```'), '<pre><code class="language-x&quot;/&gt;&lt;b&gt;">y\n</code></pre>');
  assert.equal(render('<img src=x onerror="evil()">'), '&lt;img src=x onerror=&quot;evil()&quot;&gt;');
});

test('single tilde is retained, not a parser extension we implement', () => {
  assert.equal(render('~literal~'), '~literal~');
});

test('all prefixes of representative streams remain escaped and renderable', () => {
  const input = '# Title\n\n**strong _nested_**\n\n```ts\n<x>&amp;\n```\n\n[x](javascript:alert(1))\n\n- [x] done';
  for (let i = 0; i <= input.length; i++) {
    const html = render(input.slice(0, i));
    assert.equal(typeof html, 'string');
    assert.ok(!/<(?:x|script|img)\b/.test(html));
    assert.ok(!html.includes('href="javascript:'));
  }
});
