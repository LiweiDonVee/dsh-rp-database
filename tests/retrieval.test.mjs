import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const entries = [
  { id: 'moon-city', title: '月城', content: '北方古城有一座高塔', keywords: ['银月', 'silver moon'], tags: ['地点'], notes: '', mode: 'auto' },
  { id: 'hero', title: '旅人', content: '他来自南方港口', keywords: ['主角'], tags: ['人物'], mode: 'auto' },
  { id: 'must', title: 'Rules', content: 'Always included', mode: 'required' },
  { id: 'hidden', title: '银月', content: 'Secret forbidden text', keywords: ['银月'], mode: 'disabled' },
];

test('lexical retrieval handles Chinese, IDs, keywords and reports unconfigured providers', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const retriever = createRetriever();
  for (const query of ['moon-city', '月城', '银月', '地点', '北方古城', 'SILVER MOON']) {
    const result = await retriever.search({ entries, query, limit: 1 });
    assert.equal(result.candidates[0].id, 'moon-city');
    assert.deepEqual(result.required, ['must']);
    assert.deepEqual(result.degraded, ['embedding_unconfigured', 'reranking_unconfigured']);
    assert.ok(result.candidates[0].reasons.length);
    assert.ok(Number.isFinite(result.candidates[0].score));
  }
  assert.deepEqual((await retriever.search({ entries, query: 'no match here', limit: 0 })).candidates, []);
});

test('embedding and rerank actually receive enabled documents and the abort signal', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const signal = new AbortController().signal;
  let embeddingCalls = 0; let rerankCalls = 0;
  const retriever = createRetriever({
    embed: async (texts, receivedSignal) => {
      embeddingCalls++;
      assert.equal(receivedSignal, signal);
      assert.equal(texts[0], '海上来客');
      assert.equal(texts.length, 4);
      assert.ok(texts.every(text => !text.includes('Secret forbidden text')));
      return [[1, 0], [0, 1], [1, 0], [0, 0.5]];
    },
    rerank: async ({ query, documents, signal: receivedSignal }) => {
      rerankCalls++;
      assert.equal(query, '海上来客');
      assert.equal(receivedSignal, signal);
      assert.equal(documents.length, 3);
      const hero = documents.findIndex(text => text.includes('南方港口'));
      return [{ index: hero, score: 0.99 }];
    },
  });
  const result = await retriever.search({ entries, query: '海上来客', signal, limit: 1 });
  assert.equal(embeddingCalls, 1);
  assert.equal(rerankCalls, 1);
  assert.equal(result.candidates[0].id, 'hero');
  assert.ok(result.candidates[0].reasons.includes('embedding'));
  assert.ok(result.candidates[0].reasons.includes('rerank'));
  assert.deepEqual(result.degraded, []);
  assert.deepEqual(result.required, ['must']);
});

test('rerank-only retrieval considers enabled documents outside lexical matches', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const result = await createRetriever({ rerank: async ({ documents }) => [{ index: documents.findIndex(text => text.includes('南方港口')), score: 0.8 }] }).search({ entries, query: 'seafarer', limit: 1 });
  assert.equal(result.candidates[0].id, 'hero');
  assert.deepEqual(result.degraded, ['embedding_unconfigured']);
});

test('malformed embeddings degrade to lexical results without semantic success', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  for (const vectors of [[], [[1], [1], [1]], [[1, 0], [1], [1], [1]], [[1], [NaN], [1], [1]], [[1], [Infinity], [1], [1]], [[], [], [], []]]) {
    const result = await createRetriever({ embed: async () => vectors }).search({ entries, query: '月城' });
    assert.equal(result.candidates[0].id, 'moon-city');
    assert.ok(result.degraded.includes('embedding_failed'));
    assert.ok(result.candidates.every(item => !item.reasons.includes('embedding')));
  }
});

test('malformed rerank indices and scores degrade without replacing lexical rank', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  for (const ranks of [[{ index: 99, score: 1 }], [{ index: -1, score: 1 }], [{ index: 0.5, score: 1 }], [{ index: 0, score: NaN }], [{ index: 0, score: 1 }, { index: 0, score: 2 }], {}]) {
    const result = await createRetriever({ rerank: async () => ranks }).search({ entries, query: '月城' });
    assert.equal(result.candidates[0].id, 'moon-city');
    assert.ok(result.degraded.includes('reranking_failed'));
  }
});

test('provider exceptions are sanitized and aborted searches reject', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const retriever = createRetriever({ embed: async () => { throw new Error('secret api key'); }, rerank: async () => { throw new Error('provider payload'); } });
  const result = await retriever.search({ entries, query: '月城' });
  assert.deepEqual(result.degraded, ['embedding_failed', 'reranking_failed']);
  assert.ok(!JSON.stringify(result).includes('secret api key'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(retriever.search({ entries, query: '月城', signal: controller.signal }), { name: 'AbortError' });
  const mid = new AbortController();
  await assert.rejects(createRetriever({ embed: async () => { mid.abort(); return [[1], [1], [1], [1]]; } }).search({ entries, query: 'x', signal: mid.signal }), { name: 'AbortError' });
});

test('all-disabled databases cause no provider calls and required IDs survive truncation', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const retriever = createRetriever({ embed: async () => assert.fail('disabled embed'), rerank: async () => assert.fail('disabled rerank') });
  assert.deepEqual((await retriever.search({ entries: [entries[3]], query: 'secret' })).candidates, []);
  const result = await createRetriever().search({ entries, query: '月城', limit: 1 });
  assert.deepEqual(result.required, ['must']);
  assert.equal(result.candidates.length, 1);
});

test('HTTP adapters use explicit OpenAI-compatible endpoints, bodies and authorization', async () => {
  const { createHttpRetrieval } = await import('../src/retrieval.mjs');
  const requests = [];
  const controller = new AbortController();
  const adapters = createHttpRetrieval({
    embedding: { baseURL: 'https://retrieval.example/v1/', model: 'embedding-real', apiKey: 'test-only' },
    reranking: { baseURL: 'http://localhost:1234/v1', model: 'rerank-real' },
    fetch: async (url, options) => {
      requests.push({ url: String(url), ...options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => String(url).endsWith('/embeddings') ? { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } : { results: [{ index: 1, relevance_score: 0.9 }] } };
    },
  });
  assert.deepEqual(await adapters.embed(['query', 'doc'], controller.signal), [[1, 0], [0, 1]]);
  assert.deepEqual(await adapters.rerank({ query: 'query', documents: ['one', 'two'], signal: controller.signal }), [{ index: 1, score: 0.9 }]);
  assert.deepEqual(requests.map(x => x.url), ['https://retrieval.example/v1/embeddings', 'http://localhost:1234/v1/rerank']);
  assert.deepEqual(requests[0].body, { model: 'embedding-real', input: ['query', 'doc'] });
  assert.equal(requests[0].headers.Authorization, 'Bearer test-only');
  assert.equal(requests[0].signal, controller.signal);
  assert.deepEqual(requests[1].body, { model: 'rerank-real', query: 'query', documents: ['one', 'two'], top_n: 2 });
  assert.equal(requests[1].headers.Authorization, undefined);
});

test('HTTP adapters do not infer endpoints or call anything when unconfigured', async () => {
  const { createHttpRetrieval } = await import('../src/retrieval.mjs');
  assert.deepEqual(createHttpRetrieval({ fetch: () => assert.fail('unconfigured fetch') }), {});
  for (const config of [{ model: 'https://fake.example/model' }, { baseURL: 'file:///etc/secret', model: 'x' }, { baseURL: 'ftp://host', model: 'x' }, { baseURL: 'https://user:password@host', model: 'x' }, { baseURL: 'https://host', model: '' }]) assert.throws(() => createHttpRetrieval({ embedding: config }), { code: 'INVALID_RETRIEVAL_CONFIG' });
});

test('HTTP malformed responses and failures expose no keys or provider payload', async () => {
  const { createHttpRetrieval } = await import('../src/retrieval.mjs');
  const config = { baseURL: 'https://retrieval.example', model: 'x', apiKey: 'sensitive-key' };
  for (const response of [{ ok: false, json: async () => ({ error: 'sensitive-key' }) }, { ok: true, json: async () => ({ data: [{ embedding: [NaN] }] }) }, { ok: true, json: async () => ({ data: [] }) }, { ok: true, json: async () => { throw new Error('sensitive-key'); } }]) {
    const adapter = createHttpRetrieval({ embedding: config, fetch: async () => response });
    await assert.rejects(adapter.embed(['x']), error => error.code === 'RETRIEVAL_PROVIDER_ERROR' && !String(error).includes('sensitive-key'));
  }
  const adapter = createHttpRetrieval({ reranking: config, fetch: async () => ({ ok: true, json: async () => ({ results: [{ index: 8, relevance_score: 0.8 }] }) }) });
  await assert.rejects(adapter.rerank({ query: 'x', documents: ['one'] }), { code: 'RETRIEVAL_PROVIDER_ERROR' });
});

test('HTTP abort signal is forwarded and abort errors stay sanitized', async () => {
  const { createHttpRetrieval } = await import('../src/retrieval.mjs');
  const controller = new AbortController();
  const { embed } = createHttpRetrieval({ embedding: { baseURL: 'https://example.com', model: 'x' }, fetch: async (_url, { signal }) => { assert.equal(signal, controller.signal); controller.abort(); throw new Error('private provider content'); } });
  await assert.rejects(embed(['one'], controller.signal), { name: 'AbortError', message: 'Retrieval aborted' });
});

test('cosine similarity ranks enabled vectors with deterministic ties and no lexical match', async () => {
  const { createRetriever } = await import('../src/retrieval.mjs');
  const result = await createRetriever({ embed: async () => [[1e308, 1e308], [-1, -1], [1, 1], [1, 1]] }).search({ entries, query: 'unrelated semantic phrase' });
  assert.deepEqual(result.candidates.map(item => item.id), ['hero', 'must', 'moon-city']);
  assert.ok(result.candidates.every(item => Number.isFinite(item.score)));
});

test('HTTP adapters make real local HTTP embedding and reranking requests', async t => {
  const { createHttpRetrieval, createRetriever } = await import('../src/retrieval.mjs');
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    calls.push({ url: request.url, ...parsed });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/embeddings') response.end(JSON.stringify({ data: parsed.input.map((_text, index) => ({ index, embedding: index === 2 ? [1, 0] : [0, 1] })) }));
    else response.end(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const config = { baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-test-only' };
  const result = await createRetriever(createHttpRetrieval({ embedding: config, reranking: config })).search({ entries, query: 'visitor', limit: 1 });
  assert.equal(result.candidates[0].id, 'hero');
  assert.deepEqual(result.degraded, []);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/v1/embeddings');
  assert.equal(calls[1].url, '/v1/rerank');
  assert.ok(calls[0].input.every(text => !text.includes('Secret forbidden text')));
});
