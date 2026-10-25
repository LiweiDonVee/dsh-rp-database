export function createRpDatabaseApi(send = (...args) => globalThis.fetch(...args)) {
  async function request(action, input, signal) {
    const response = await send(new URL('api/rp-database/request', document.baseURI), {
      method: 'POST', headers: {'content-type': 'application/json'}, signal,
      body: JSON.stringify({action, ...input}),
    })
    let data
    try { data = await response.json() }
    catch { throw Object.assign(new Error('无法读取数据库响应，请重试。'), {status: response.status}) }
    if (!response.ok || data?.error) throw Object.assign(new Error(data?.error?.message || '数据库请求失败，请重试。'), {status: response.status, code: data?.error?.code})
    if (!data || typeof data !== 'object') throw new Error('数据库响应不完整，请重新载入。')
    return data
  }
  return {
    state: (sessionId, signal) => request('state', sessionId ? {sessionId} : {}, signal),
    database: (databaseId, version, signal) => request('database', {databaseId, ...(version === undefined ? {} : {version})}, signal),
    source: (sourceId, signal) => request('source', {sourceId}, signal),
    create: (name, expectedRevision, signal) => request('create', {name, expectedRevision}, signal),
    import: (rawText, options, signal) => request('import', {rawText, ...options}, signal),
    save: (database, expectedRevision, signal) => request('save', {database, expectedRevision}, signal),
    bind: (sessionId, input, signal) => request('bind', {sessionId, ...input}, signal),
    search: (sessionId, query, signal) => request('search', {sessionId, query}, signal),
    subscribe(sessionId, onEvent, onError) {
      const url = new URL('api/rp-database/events', document.baseURI)
      url.searchParams.set('sessionId', sessionId)
      const source = new EventSource(url)
      for (const type of ['connected', 'changed']) source.addEventListener(type, event => {
        let data
        try { data = JSON.parse(event.data) } catch { return }
        if (data?.sessionId === sessionId) onEvent({...data, type})
      })
      source.onerror = onError
      return () => source.close()
    },
  }
}
