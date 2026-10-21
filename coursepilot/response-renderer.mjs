import MarkdownIt from 'markdown-it';
import katex from 'katex';
import DOMPurify from 'dompurify';

const delimiters = [
  { open: '\\(', close: '\\)', display: false },
  { open: '\\[', close: '\\]', display: true },
  { open: '$$', close: '$$', display: true }
];
const markdown = new MarkdownIt({ html: false, breaks: true }).disable('image');
markdown.validateLink = (url) => /^https:\/\//i.test(url);
markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};

function closingIndex(text, delimiter, start) {
  let index = text.indexOf(delimiter, start);
  while (index !== -1) {
    let preceding = index;
    while (preceding > 0 && text[preceding - 1] === '\\') preceding--;
    if ((index - preceding) % 2 === 0) return index;
    index = text.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

markdown.inline.ruler.before('escape', 'math', (state, silent) => {
  const delimiter = delimiters.find(({ open }) => state.src.startsWith(open, state.pos));
  if (!delimiter) return false;
  const start = state.pos + delimiter.open.length;
  const end = closingIndex(state.src, delimiter.close, start);
  if (end === -1 && !state.env.streaming) return false;
  if (!silent) {
    const token = state.push(end === -1 ? 'math_pending' : 'math', '', 0);
    token.content = state.src.slice(start, end === -1 ? state.posMax : end);
    token.meta = { display: delimiter.display };
  }
  state.pos = end === -1 ? state.posMax : end + delimiter.close.length;
  return true;
});

markdown.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const delimiter = delimiters.find(({ open, display }) => display && state.src.startsWith(open, start));
  if (!delimiter) return false;
  const end = closingIndex(state.src, delimiter.close, start + delimiter.open.length);
  if (end === -1 && !state.env.streaming) return false;
  let nextLine = startLine;
  while (nextLine < endLine && (end === -1 || state.eMarks[nextLine] < end + delimiter.close.length)) nextLine++;
  if (end !== -1 && (nextLine >= endLine ||
      state.src.slice(end + delimiter.close.length, state.eMarks[nextLine]).trim())) return false;
  if (silent) return true;
  const token = state.push(end === -1 ? 'math_pending' : 'math', '', 0);
  token.block = true;
  token.content = state.src.slice(start + delimiter.open.length, end === -1 ? state.eMarks[endLine - 1] : end);
  token.meta = { display: true };
  state.line = end === -1 ? endLine : nextLine + 1;
  return true;
});

markdown.renderer.rules.math = (tokens, index, _options, env) => {
  const token = tokens[index];
  try {
    return katex.renderToString(token.content, {
      displayMode: token.meta.display,
      output: 'htmlAndMathml',
      trust: false,
      strict: 'error',
      throwOnError: true,
      maxExpand: 200,
      maxSize: 20
    });
  } catch (error) {
    if (!(error instanceof katex.ParseError)) throw error;
    env.mathErrors++;
    return `<code class="math-error" title="This expression could not be typeset.">${markdown.utils.escapeHtml(token.content)}</code>`;
  }
};
markdown.renderer.rules.math_pending = () =>
  '<span class="math-pending" role="status" aria-label="Receiving equation">…</span>';

// Match provider markers only through the accompanying citation annotations.
markdown.core.ruler.after('inline', 'citations', (state) => {
  for (const block of state.tokens) {
    if (!block.children) continue;
    block.children = block.children.flatMap((token) => {
      if (token.type !== 'text') return [token];
      const parts = [];
      let start = 0;
      for (const match of token.content.matchAll(/\u3010(\d+:\d+)(?:\u2020[^\u3011\n]*)?\u3011/g)) {
        if (match.index > start) {
          const text = new state.Token('text', '', 0);
          text.content = token.content.slice(start, match.index);
          parts.push(text);
        }
        const citation = new state.Token('citation', '', 0);
        citation.content = match[1];
        parts.push(citation);
        start = match.index + match[0].length;
      }
      if (!parts.length) return [token];
      if (start < token.content.length) {
        const text = new state.Token('text', '', 0);
        text.content = token.content.slice(start);
        parts.push(text);
      }
      return parts;
    });
  }
});
markdown.renderer.rules.citation = (tokens, index, _options, env) => {
  const reference = tokens[index].content;
  const source = env.sources.get(env.citations.get(reference));
  if (source?.kind === 'policy') return '<span class="citation">[Teaching policy]</span>';
  if (source?.kind === 'course' && Number.isInteger(source.number) && source.number > 0) {
    const title = markdown.utils.escapeHtml(source.title);
    if (typeof source.text === 'string' && source.text.trim()) {
      return `<button type="button" class="citation" data-source-id="${markdown.utils.escapeHtml(source.id)}" aria-controls="course-source-panel" title="${title} (view source)">[${source.number}]</button>`;
    }
    return `<span class="citation" title="${title}; source text unavailable">[${source.number}]</span>`;
  }
  if (!env.streaming) env.citationErrors++;
  return `<span class="citation">${env.streaming ? '[source]' : '[source unavailable]'}</span>`;
};

export function responseHtml(text, { streaming = false, sources = new Map(), citations = new Map() } = {}) {
  const env = { streaming, sources, citations, mathErrors: 0, citationErrors: 0 };
  const html = markdown.render(text, env);
  return { html, mathErrors: env.mathErrors, citationErrors: env.citationErrors };
}

export function renderResponse(element, text, options = {}) {
  const result = responseHtml(text, options);
  element.replaceChildren(DOMPurify.sanitize(result.html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ['style']
  }));
  if (result.mathErrors) {
    const warning = element.ownerDocument.createElement('p');
    warning.className = 'format-warning';
    warning.textContent = 'Some math could not be typeset and is shown as source notation.';
    element.append(warning);
  }
  if (result.citationErrors) {
    const warning = element.ownerDocument.createElement('p');
    warning.className = 'format-warning';
    warning.textContent = 'Some citations could not be matched to retrieved sources.';
    element.append(warning);
  }
}

export function createResponseRenderer(element, { onError, onRender, sources, citations } = {}) {
  let latest = '';
  let frame;
  const render = (streaming) => {
    try {
      renderResponse(element, latest, { streaming, sources, citations });
    } catch (error) {
      element.textContent = latest;
      onError?.(error);
    }
    onRender?.();
  };
  return {
    update(text) {
      latest = text;
      if (frame === undefined) frame = requestAnimationFrame(() => {
        frame = undefined;
        render(true);
      });
    },
    finish(text = latest) {
      latest = text;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      render(false);
    }
  };
}
