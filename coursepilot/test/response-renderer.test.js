const { test } = require('node:test');
const assert = require('node:assert/strict');
const renderer = import('../response-renderer.mjs');
const sourceOptions = () => ({
  sources: new Map([['course:growth', {
    id: 'course:growth', kind: 'course', number: 1, title: 'Bacterial Growth Curve',
    text: 'Retrieved course text.'
  }]]),
  citations: new Map([['9:0', 'course:growth']])
});

test('typesets the screenshot example and renders Markdown and provider citations', async () => {
  const { responseHtml } = await renderer;
  const { html, mathErrors } = responseHtml(String.raw`Use **generation time**.

1. **Find the number of doublings:**
   \(40 \div 20 = 2\) generations ${'\u30109:0\u2020source\u3011'}.

2. **Double the starting cells:**
   \(10 \times 2^{2} = 40\) cells.

**Answer: 40 cells**`, sourceOptions());
  assert.equal(mathErrors, 0);
  assert.match(html, /<strong>generation time<\/strong>/);
  assert.match(html, /<ol>/);
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /<msup>/);
  assert.match(html, /<math /);
  assert.match(html, /<button type="button"[^>]*data-source-id="course:growth"[^>]*aria-controls="course-source-panel"[^>]*>\[1\]<\/button>/);
  assert.doesNotMatch(html, /href=|target=|blob:/);
  assert.doesNotMatch(html, /【|†source|\\\(|\\\)/);
});

test('citation numbers match the source list, repeated citations reuse a number, and policies stay unlinked', async () => {
  const { responseHtml } = await renderer;
  const options = sourceOptions();
  options.sources.get('course:growth').number = 2;
  options.sources.set('policy', { id: 'policy', kind: 'policy', title: 'Teaching policy' });
  options.citations.set('2:0', 'policy');
  const text = 'First \u30109:0\u2020source\u3011; repeated \u30109:0\u2020source\u3011. Rules \u30102:0\u2020source\u3011.';
  const { html, citationErrors } = responseHtml(text, options);
  assert.equal((html.match(/>\[2\]<\/button>/g) || []).length, 2);
  assert.match(html, /<span class="citation">\[Teaching policy\]<\/span>/);
  assert.doesNotMatch(html, /data-source-id="policy"/);
  assert.equal(citationErrors, 0);
});

test('unmapped citations remain explicitly unavailable instead of being assigned a guessed source number', async () => {
  const { responseHtml } = await renderer;
  const marker = '\u301099:4\u2020source\u3011';
  const pending = responseHtml(marker, { ...sourceOptions(), streaming: true });
  assert.match(pending.html, /\[source\]/);
  assert.equal(pending.citationErrors, 0);
  const final = responseHtml(marker, sourceOptions());
  assert.match(final.html, /\[source unavailable\]/);
  assert.equal(final.citationErrors, 1);
  assert.doesNotMatch(final.html, /<a|99:4|\[1\]/);
});

test('numbered course sources without retrieved text do not get a preview button', async () => {
  const { responseHtml } = await renderer;
  const options = sourceOptions();
  delete options.sources.get('course:growth').text;
  const result = responseHtml('\u30109:0\u2020source\u3011', options);
  assert.match(result.html, /source text unavailable/);
  assert.match(result.html, /\[1\]/);
  assert.doesNotMatch(result.html, /<a|<button/);
});
test('handles fractions, roots, subscripts, aligned display math, and double-dollar blocks', async () => {
  const { responseHtml } = await renderer;
  const { html, mathErrors } = responseHtml(String.raw`Inline \(\frac{x_1}{\sqrt{y}}\).

\[
\begin{aligned}
N &= N_0 \times 2^{t/g} \\
  &= 40 \text{ cells}
\end{aligned}
\]

Also $$a^{2}$$ here.

$$
\frac{1}{2}
$$`);
  assert.equal(mathErrors, 0);
  assert.equal((html.match(/class="katex"/g) || []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 3);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.match(html, /<msub>/);
  assert.match(html, /<mtable/);
});

test('does not interpret currency or math and citation examples inside code', async () => {
  const { responseHtml } = await renderer;
  const { html } = responseHtml([
    'It costs $20 and $40. Literal `\\(a^2\\) \u30109:0\u2020source\u3011`.',
    '',
    '```text',
    '\\[a^2\\]',
    '```'
  ].join('\n'));
  assert.match(html, /\$20 and \$40/);
  assert.doesNotMatch(html, /class="katex"|class="citation"/);
  assert.match(html, /<pre><code/);
});

test('buffers split math during streaming, then renders the complete equation', async () => {
  const { responseHtml } = await renderer;
  const text = String.raw`The result is \(10 \times 2^{2} = 40\).`;
  const start = text.indexOf('\\(') + 2;
  const end = text.indexOf('\\)') + 2;
  for (let index = start; index < end; index++) {
    const partial = responseHtml(text.slice(0, index), { streaming: true });
    assert.equal(partial.mathErrors, 0);
    assert.match(partial.html, /math-pending/);
    assert.doesNotMatch(partial.html, /class="katex"|math-error/);
  }
  assert.match(responseHtml(text, { streaming: true }).html, /class="katex"/);
  assert.doesNotMatch(responseHtml(text).html, /math-pending/);
  assert.match(responseHtml(String.raw`Stopped at \(\frac{1}`).html, /frac/);
  assert.match(responseHtml(String.raw`\[
\frac{1}`, { streaming: true }).html, /math-pending/);
});

test('shows malformed math as escaped source with an explicit formatting error', async () => {
  const { responseHtml } = await renderer;
  const { html, mathErrors } = responseHtml(String.raw`\(\notARealCommand{<img src=x onerror=alert(1)>}\)`);
  assert.equal(mathErrors, 1);
  assert.match(html, /class="math-error"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});

test('does not enable model HTML, images, unsafe links, or trusted TeX commands', async () => {
  const { responseHtml } = await renderer;
  const { html } = responseHtml(String.raw`<script>alert(1)</script>
<img src=x onerror=alert(1)>
[bad](javascript:alert(1))
[data](data:text/html,unsafe)
![remote image](https://example.test/tracker)
[course](https://example.edu/notes)
\(\href{javascript:alert(1)}{click}\)
\(\htmlStyle{position:fixed}{x}\)`);
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|data):|style="[^"]*position:\s*fixed/);
  assert.match(html, /href="https:\/\/example.edu\/notes"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
