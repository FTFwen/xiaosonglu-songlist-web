// 测试用的内存 R2 替身（`_` 前缀表示内部工具）。
// 保留 ETag 条件写入语义：无条件写入一定成功，conditional-put 只在 ETag 不匹配时失败。
// 写入前让出事件循环，好让并发请求真的交错——这是唯一能证明「不会互相覆盖」的方式。
export function createTestBucket({ writeDelay = 0, conditionalPutLimit = Infinity } = {}) {
  const store = new Map();
  const counters = { reads: 0, writes: 0, conditionalFailures: 0, head: 0 };
  const trace = [];
  let version = 0;
  const sleep = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

  function metaOf(key) {
    const entry = store.get(key);
    if (!entry) return null;
    return { key, size: entry.body.length, httpEtag: `"${entry.version}"`, etag: entry.version };
  }

  function allows(onlyIf, entry) {
    if (!onlyIf) return true;
    if (counters.conditionalFailures >= conditionalPutLimit) return false;
    if (onlyIf.etagDoesNotMatch === '*' && entry) return false;
    if (onlyIf.etagMatches !== undefined) {
      const expected = String(onlyIf.etagMatches).replace(/^"|"$/g, '');
      if (!entry || String(entry.version) !== expected) return false;
    }
    return true;
  }

  return {
    counters,
    trace,
    keys: () => [...store.keys()].sort(),
    raw: key => (store.has(key) ? JSON.parse(store.get(key).body) : null),
    body: key => (store.has(key) ? store.get(key).body : null),
    async get(key) {
      counters.reads++;
      await sleep(writeDelay);
      const entry = store.get(key);
      if (!entry) return null;
      return {
        key,
        body: entry.body,
        httpEtag: `"${entry.version}"`,
        async text() { return entry.body; },
      };
    },
    async head(key) {
      counters.head++;
      await sleep(writeDelay);
      const meta = metaOf(key);
      trace.push({ op: 'head', key, version: meta ? meta.etag : null });
      return meta;
    },
    async put(key, body, options = {}) {
      counters.writes++;
      const entered = { key, global: version, keyVersion: store.get(key) ? store.get(key).version : null };
      await sleep(writeDelay);
      const entry = store.get(key);
      const verdict = options.onlyIf ? allows(options.onlyIf, entry) : true;
      if (options.onlyIf && !verdict) {
        counters.conditionalFailures++;
        trace.push({ op: 'put', key, expected: describeOnlyIf(options.onlyIf), entered, current: entry ? entry.version : null, result: 'conflict' });
        return null;
      }
      version++;
      store.set(key, { body: String(body), version });
      trace.push({ op: 'put', key, expected: describeOnlyIf(options.onlyIf), entered, current: null, result: 'ok' });
      return metaOf(key);
    },
    async delete(key) {
      store.delete(key);
      return true;
    },
  };
}

function describeOnlyIf(onlyIf) {
  if (!onlyIf) return 'none';
  if (onlyIf.etagMatches !== undefined) return `match:${onlyIf.etagMatches}`;
  if (onlyIf.etagDoesNotMatch !== undefined) return `create-only`;
  return 'unknown';
}

// 模拟前端的自动补偿重试：冲突返回时再打一次（明细已落盘时等价于幂等补偿）。
export async function rateWithClientRetry(applyRating, context, songKey, clientId, score, retries = 3) {
  let result = await applyRating(context, songKey, clientId, score);
  for (let attempt = 1; attempt <= retries && !result.ok; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    result = await applyRating(context, songKey, clientId, score);
  }
  return result;
}
