import { DatabaseError, validateDatabase } from './core.mjs';

const abort = () => new DOMException('Retrieval aborted', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abort(); }
const normalize = text => text.normalize('NFKC').toLocaleLowerCase();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
function tokens(text) {
  const normalized = normalize(text);
  const words = [...segmenter.segment(normalized)].filter(item => item.isWordLike).map(item => item.segment);
  // Bigrams also match Chinese phrases whose word boundaries differ by context.
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) words.push(chars[0]);
    for (let index = 0; index < chars.length - 1; index++) words.push(chars[index] + chars[index + 1]);
  }
  return [...new Set(words)];
}
const document = entry => [entry.id, entry.title, ...entry.keywords, ...entry.tags, entry.content, entry.notes].join('\n');
function lexical(entry, query, queryTokens) {
  const reasons = [];
  let score = 0;
  if (!query) return { score, reasons };
  if (normalize(entry.id) === query) { score += 100; reasons.push('exact-id'); }
  if (normalize(entry.title).includes(query)) { score += 60; reasons.push('title'); }
  if (entry.keywords.some(key => normalize(key).includes(query) || (normalize(key) && query.includes(normalize(key))))) { score += 50; reasons.push('keyword'); }
  if (entry.tags.some(tag => normalize(tag).includes(query))) { score += 30; reasons.push('tag'); }
  const text = normalize(document(entry));
  const matched = queryTokens.filter(token => text.includes(token)).length;
  if (matched) { score += 10 * matched / queryTokens.length; reasons.push('lexical'); }
  return { score, reasons };
}
function validateVectors(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected) throw new Error('Invalid embedding count');
  const dimension = vectors[0]?.length;
  if (!Number.isSafeInteger(dimension) || dimension < 1 || vectors.some(vector => !Array.isArray(vector) || vector.length !== dimension || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error('Invalid embeddings');
  return vectors;
}
function validateRanks(ranks, count) {
  if (!Array.isArray(ranks) || ranks.length > count) throw new Error('Invalid reranking count');
  const seen = new Set();
  for (const rank of ranks) {
    if (!rank || !Number.isInteger(rank.index) || rank.index < 0 || rank.index >= count || typeof rank.score !== 'number' || !Number.isFinite(rank.score) || seen.has(rank.index)) throw new Error('Invalid reranking result');
    seen.add(rank.index);
  }
  return ranks;
}
function unit(vector) {
  const scale = vector.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  if (!scale) return vector.map(() => 0);
  const scaled = vector.map(value => value / scale);
  const norm = Math.sqrt(scaled.reduce((total, value) => total + value * value, 0));
  return scaled.map(value => value / norm);
}
const cosine = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

export function createRetriever({ embed, rerank } = {}) {
  if (embed !== undefined && typeof embed !== 'function' || rerank !== undefined && typeof rerank !== 'function') throw new DatabaseError('INVALID_RETRIEVAL_CONFIG', 'Retrieval providers must be functions');
  return {
    async search({ entries, query, limit = 12, signal }) {
      checkAbort(signal);
      if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 0) throw new DatabaseError('INVALID_SEARCH', 'Search requires a query string and nonnegative integer limit');
      const enabled = validateDatabase({ id: 'retrieval', name: 'Retrieval', version: 1, entries }).entries.filter(entry => entry.mode !== 'disabled');
      const required = enabled.filter(entry => entry.mode === 'required').map(entry => entry.id);
      const degraded = [];
      if (!embed) degraded.push('embedding_unconfigured');
      if (!rerank) degraded.push('reranking_unconfigured');
      const queryText = normalize(query.trim());
      const queryTokens = tokens(queryText);
      const lexicalRanks = enabled.map((entry, index) => ({ id: entry.id, index, ...lexical(entry, queryText, queryTokens) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
      const scores = new Map(lexicalRanks.map(item => [item.id, item]));
      const documents = enabled.map(document);
      if (embed && enabled.length) {
        try {
          const vectors = validateVectors(await embed([query, ...documents], signal), enabled.length + 1).map(unit);
          checkAbort(signal);
          const semantic = enabled.map((entry, index) => ({ id: entry.id, index, score: cosine(vectors[0], vectors[index + 1]) })).sort((a, b) => b.score - a.score || a.index - b.index);
          for (const item of scores.values()) item.score = 0;
          lexicalRanks.forEach((item, index) => { scores.get(item.id).score += 1 / (61 + index); });
          semantic.forEach((item, index) => {
            const old = scores.get(item.id) ?? { id: item.id, index: item.index, score: 0, reasons: [] };
            old.score += 1 / (61 + index);
            old.reasons.push('embedding');
            scores.set(item.id, old);
          });
        } catch (cause) {
          if (signal?.aborted || cause?.name === 'AbortError') throw abort();
          degraded.push('embedding_failed');
        }
      }
      let ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.index - b.index);
      if (rerank && enabled.length) {
        try {
          const ranks = validateRanks(await rerank({ query, documents, signal }), enabled.length);
          checkAbort(signal);
          const reranked = ranks.map(rank => {
            const entry = enabled[rank.index];
            const previous = scores.get(entry.id) ?? { id: entry.id, index: rank.index, reasons: [], score: 0 };
            return { ...previous, reasons: [...previous.reasons, 'rerank'], providerScore: rank.score };
          }).sort((a, b) => b.providerScore - a.providerScore || a.index - b.index);
          const ids = new Set(reranked.map(item => item.id));
          ranked = [...reranked, ...ranked.filter(item => !ids.has(item.id))].map((item, index) => ({ ...item, score: 1 / (61 + index) }));
        } catch (cause) {
          if (signal?.aborted || cause?.name === 'AbortError') throw abort();
          degraded.push('reranking_failed');
        }
      }
      checkAbort(signal);
      return { candidates: ranked.slice(0, limit).map(({ id, score, reasons }) => ({ id, score, reasons: [...reasons] })), required, degraded };
    },
  };
}

function providerConfig(config, endpoint) {
  if (!config || typeof config !== 'object' || typeof config.baseURL !== 'string' || typeof config.model !== 'string' || !config.model.trim() || config.apiKey !== undefined && typeof config.apiKey !== 'string') throw new DatabaseError('INVALID_RETRIEVAL_CONFIG', 'Provider requires an explicit baseURL and model');
  let url;
  try { url = new URL(config.baseURL); } catch { throw new DatabaseError('INVALID_RETRIEVAL_CONFIG', 'Provider baseURL must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DatabaseError('INVALID_RETRIEVAL_CONFIG', 'Provider baseURL must be an HTTP(S) URL without embedded credentials, query or fragment');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
  return { url: url.href, model: config.model, apiKey: config.apiKey };
}

export function createHttpRetrieval({ embedding, reranking, fetch: fetcher = globalThis.fetch } = {}) {
  const result = {};
  if ((embedding || reranking) && typeof fetcher !== 'function') throw new DatabaseError('INVALID_RETRIEVAL_CONFIG', 'A fetch implementation is required');
  async function request(config, body, signal, decode) {
    checkAbort(signal);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const response = await fetcher(config.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!response.ok) throw new Error('Provider rejected request');
      const payload = await response.json();
      checkAbort(signal);
      return decode(payload);
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw abort();
      throw new DatabaseError('RETRIEVAL_PROVIDER_ERROR', 'Retrieval provider request failed or returned an invalid response', 502);
    }
  }
  if (embedding !== undefined) {
    const config = providerConfig(embedding, 'embeddings');
    result.embed = async (texts, signal) => {
      if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string')) throw new DatabaseError('INVALID_SEARCH', 'Embedding input must be a nonempty array of strings');
      return request(config, { model: config.model, input: texts }, signal, payload => {
        if (!Array.isArray(payload?.data) || payload.data.length !== texts.length) throw new Error('Invalid embedding data');
        const data = payload.data;
        let vectors;
        if (data.some(item => item?.index !== undefined)) {
          validateRanks(data.map(item => ({ index: item.index, score: 0 })), texts.length);
          vectors = [...data].sort((a, b) => a.index - b.index).map(item => item.embedding);
        } else vectors = data.map(item => item?.embedding);
        return validateVectors(vectors, texts.length);
      });
    };
  }
  if (reranking !== undefined) {
    const config = providerConfig(reranking, 'rerank');
    result.rerank = async ({ query, documents, signal }) => {
      if (typeof query !== 'string' || !Array.isArray(documents) || documents.some(text => typeof text !== 'string')) throw new DatabaseError('INVALID_SEARCH', 'Rerank input requires a query and string documents');
      return request(config, { model: config.model, query, documents, top_n: documents.length }, signal, payload => {
        const ranks = payload?.results ?? payload?.data;
        if (!Array.isArray(ranks)) throw new Error('Invalid reranking data');
        return validateRanks(ranks.map(item => ({ index: item?.index, score: item?.relevance_score ?? item?.score })), documents.length);
      });
    };
  }
  return result;
}
