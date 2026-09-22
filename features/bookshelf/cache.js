// features/bookshelf/cache.js
// 聊天列表缓存：按角色 avatar 维度缓存「聊天列表拉取 Promise」，带 TTL。

const DEFAULT_TTL = 60_000; // 1 分钟

/**
 * 创建聊天列表缓存核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.fetcher (avatar) => Promise<Array> 实际的聊天列表拉取函数
 * @param {number} [deps.ttl=60000] 缓存有效期（毫秒）
 * @returns {{ get: Function, peek: Function, invalidate: Function, clear: Function }}
 */
export function createChatCacheCore(deps) {
  const { fetcher, ttl = DEFAULT_TTL } = deps;
  /** @type {Map<string, { promise: Promise, value: Array|null, ts: number }>} */
  const store = new Map();

  /**
   * 取某角色的聊天列表（带缓存）。
   * @param {string} avatar 角色头像文件名
   * @returns {Promise<Array>} 聊天数组（不含 .jsonl 判断由上层处理）
   */
  function get(avatar) {
    if (!avatar) return Promise.resolve([]);
    const hit = store.get(avatar);
    const now = Date.now();
    if (hit && now - hit.ts < ttl) {
      return hit.promise;
    }
    const promise = Promise.resolve()
      .then(() => fetcher(avatar))
      .then((list) => {
        // 记录已解析的数组（供 peek 同步读取）
        const entry = store.get(avatar);
        if (entry && entry.promise === promise) entry.value = list;
        return list;
      })
      .catch((err) => {
        // 失败时移除缓存，允许下次重试
        store.delete(avatar);
        console.warn("[NovelReader] 拉取聊天列表失败:", avatar, err);
        return [];
      });
    store.set(avatar, { promise, value: null, ts: now });
    return promise;
  }

  /**
   * 同步读取已解析的聊天列表（未解析/已过期/失败时返回 null）。
   * 用于避免重复拉取：如完整聊天内容缓存需要列表里的 file_size 做失效判断。
   * @param {string} avatar 角色头像文件名
   * @returns {Array|null}
   */
  function peek(avatar) {
    if (!avatar) return null;
    const hit = store.get(avatar);
    const now = Date.now();
    if (hit && now - hit.ts < ttl) return hit.value || null;
    return null;
  }

  /** 使某角色缓存失效 */
  function invalidate(avatar) {
    if (avatar) store.delete(avatar);
  }

  /** 清空全部缓存 */
  function clear() {
    store.clear();
  }

  /**
   * 把已解析的聊天列表直接写入缓存（供 peek 同步读取）。
   * 用于「删除/重命名聊天」后：invalidate 之后立即重拉列表，
   * 把新列表 setResolved 回缓存，避免 UI 重绘时数据缺失/闪烁。
   * @param {string} avatar 角色头像文件名
   * @param {Array} list 已解析的聊天数组
   */
  function setResolved(avatar, list) {
    if (!avatar) return;
    store.set(avatar, {
      promise: Promise.resolve(list),
      value: list,
      ts: Date.now(),
    });
  }

  return { get, peek, invalidate, clear, setResolved };
}

/**
 * 创建「完整聊天内容」缓存核心（按 avatar+fileName 维度，带 TTL + file_size 失效）。
 * 解决长聊天文件每次进目录/正文都重新 POST /api/chats/get 的卡顿：
 * 首次拉取后缓存 Promise，TTL 内直接复用；file_size 变化（聊天被追加/编辑）时自动刷新。
 * @param {object} deps 依赖注入
 * @param {Function} deps.fetcher (avatar, fileName) => Promise<Array> 实际的完整消息拉取函数
 * @param {number} [deps.ttl=300000] 缓存有效期（毫秒，默认 5 分钟）
 * @returns {{ get: Function, invalidate: Function, clear: Function }}
 */
export function createChatContentCacheCore(deps) {
  const { fetcher, ttl = 5 * 60_000 } = deps;
  /** @type {Map<string, { promise: Promise, ts: number, fileSize: number }>} */
  const store = new Map();

  function keyFor(avatar, fileName) {
    return `${avatar}\u0000${fileName}`;
  }

  /**
   * 取某聊天的完整消息数组（带缓存）。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @param {number} [fileSize] 聊天列表里的文件大小（字节），与缓存记录不一致时强制刷新
   * @returns {Promise<Array>} 消息数组
   */
  function get(avatar, fileName, fileSize) {
    if (!avatar || !fileName) return Promise.resolve([]);
    const key = keyFor(avatar, fileName);
    const hit = store.get(key);
    const now = Date.now();
    // TTL 内且文件大小未变化（或调用方未提供 fileSize）→ 直接复用
    if (hit && now - hit.ts < ttl && hit.fileSize === fileSize) {
      return hit.promise;
    }
    const promise = Promise.resolve()
      .then(() => fetcher(avatar, fileName))
      .catch((err) => {
        // 失败时移除缓存，允许下次重试
        store.delete(key);
        console.warn(
          "[NovelReader] 拉取完整聊天内容失败:",
          avatar,
          fileName,
          err,
        );
        return [];
      });
    store.set(key, { promise, ts: now, fileSize });
    return promise;
  }

  /**
   * 使缓存失效。只传 avatar 时清除该角色全部聊天的缓存。
   * @param {string} avatar 角色头像文件名
   * @param {string} [fileName] 聊天文件名；省略则清除该角色全部缓存
   */
  function invalidate(avatar, fileName) {
    if (!avatar) return;
    if (fileName) {
      store.delete(keyFor(avatar, fileName));
      return;
    }
    const prefix = avatar + "\u0000";
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }

  /** 清空全部缓存 */
  function clear() {
    store.clear();
  }

  return { get, invalidate, clear };
}
