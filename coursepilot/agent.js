const { randomUUID } = require('node:crypto');
const { EventType } = require('@ag-ui/core');

async function* readSse(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
  if (pending.trim()) throw new Error('The agent stream ended with an incomplete event.');
}

function sourcesFromItem(item) {
  if (item.type !== 'mcp_call' || !item.output) return [];
  if (!['course_content', 'pedagogy_policy'].includes(item.server_label)) return [];
  const result = JSON.parse(item.output);
  return (result.documents || []).map((document) => {
    if (item.server_label === 'pedagogy_policy') {
      return { id: 'policy', kind: 'policy', title: 'Teaching policy', referenceUrl: document.url };
    }
    const content = JSON.parse(document.content);
    return {
      id: `course:${content.id || document.url || document.id}`,
      kind: 'course',
      title: typeof content.title === 'string' && content.title
        ? content.title : typeof document.title === 'string' && document.title || 'Course source',
      referenceUrl: document.url,
      text: typeof content.content === 'string' ? content.content : null
    };
  });
}

function citationsFromItem(item, sourcesByUrl) {
  if (item.type !== 'message') return [];
  const citations = new Map();
  for (const content of item.content || []) {
    if (content.type !== 'output_text') continue;
    for (const annotation of content.annotations || []) {
      if (annotation.type !== 'url_citation' || !sourcesByUrl.has(annotation.url)) continue;
      if (!Number.isInteger(annotation.start_index) || !Number.isInteger(annotation.end_index) ||
          annotation.start_index < 0 || annotation.end_index <= annotation.start_index) continue;
      // Provider offsets can use Unicode characters rather than UTF-16 units.
      const spans = [
        content.text.slice(annotation.start_index, annotation.end_index),
        Array.from(content.text).slice(annotation.start_index, annotation.end_index).join('')
      ];
      const references = new Set(spans.map((span) =>
        /^\u3010(\d+:\d+)(?:\u2020[^\u3011\n]*)?\u3011$/.exec(span)?.[1]).filter(Boolean));
      if (references.size !== 1) continue;
      const reference = [...references][0];
      const sourceId = sourcesByUrl.get(annotation.url);
      citations.set(reference, citations.has(reference) && citations.get(reference) !== sourceId ? null : sourceId);
    }
  }
  return [...citations].filter(([, sourceId]) => sourceId !== null)
    .map(([reference, sourceId]) => ({ reference, sourceId }));
}

async function streamAgent(input, { endpoint, agentName, agentVersion, credential, serverPolicy, fetchImpl = fetch, signal, emit }) {
  const token = await credential.getToken('https://ai.azure.com/.default', { abortSignal: signal });
  if (!token) throw new Error('Azure did not return an access token.');
  const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/openai/v1/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_reference: { type: 'agent_reference', name: agentName, version: agentVersion },
      input: [
        ...(serverPolicy ? [{
          type: 'message',
          role: 'developer',
          content: `COURSEPILOT_SERVER_POLICY\n${JSON.stringify({
            professorName: serverPolicy.professorName,
            course: serverPolicy.course,
            policyText: serverPolicy.policyText
          })}`
        }] : []),
        ...input.messages.map(({ role, content }) => ({ type: 'message', role, content }))
      ],
      stream: true,
      store: false
    }),
    signal
  });
  if (!response.ok) {
    // Do not log the response body: it can include retrieved course content.
    throw new Error(`Foundry request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('Foundry returned an empty stream.');
  let messageId;
  let completed = false;
  const sourcesByUrl = new Map();
  for await (const event of readSse(response.body)) {
    if (event.type === 'response.output_item.added' && event.item.type === 'mcp_call') {
      const label = event.item.server_label;
      await emit({
        type: EventType.CUSTOM,
        name: 'coursepilot.status',
        value: label === 'pedagogy_policy' ? 'Reading teaching policy' : 'Searching course material'
      });
    }
    if (event.type === 'response.output_item.done' && event.item.type === 'mcp_call') {
      if (event.item.error) throw new Error('A knowledge retrieval tool failed.');
      const sources = sourcesFromItem(event.item);
      for (const source of sources) {
        if (source.referenceUrl) sourcesByUrl.set(source.referenceUrl, source.id);
      }
      if (sources.length) await emit({
        type: EventType.CUSTOM, name: 'coursepilot.sources',
        value: sources.map(({ referenceUrl, ...source }) => source)
      });
    }
    if (event.type === 'response.output_item.done' && event.item.type === 'message') {
      const citations = citationsFromItem(event.item, sourcesByUrl);
      if (citations.length) await emit({ type: EventType.CUSTOM, name: 'coursepilot.citations', value: citations });
    }
    if (event.type === 'response.output_text.delta' && event.delta) {
      if (!messageId) {
        messageId = randomUUID();
        await emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
      }
      await emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.delta });
    }
    if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      throw new Error('The agent could not complete this response.');
    }
    if (event.type === 'response.completed') completed = true;
  }
  if (!completed || !messageId) throw new Error('The agent stream ended before a complete answer was received.');
  await emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}

module.exports = { readSse, sourcesFromItem, citationsFromItem, streamAgent };
