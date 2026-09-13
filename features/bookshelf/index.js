// features/bookshelf/index.js
// 书架功能聚合入口：组装数据层 + 缓存，导出 createBookshelfCore。
// 依赖注入 deps（由 index.js 提供）：
//   getStContext / getRequestHeaders / getPastCharacterChatsFunc / getChatMessages 等
// 注意：UI 层已由 index.js 的状态机全屏 UI 接管（角色卡片网格 / 聊天卡片），
//       本模块只负责数据获取与缓存。

import { createChatCacheCore, createChatContentCacheCore } from "./cache.js";
import {
  getCharactersCore,
  getCharChatsCore,
  getChatMessagesCore,
} from "./data.js";

/**
 * 创建书架核心（数据层）。
 * @param {object} deps 依赖注入
 * @returns {object} 书架 API
 */
export function createBookshelfCore(deps) {
  // 聊天列表缓存（TTL 60s）
  const chatCache = createChatCacheCore({
    ttl: 60_000,
    fetcher: (avatar) => {
      const chars = getCharactersCore(deps);
      const idx = chars.findIndex((c) => c.avatar === avatar);
      return getCharChatsCore(deps, idx >= 0 ? idx : 0, avatar);
    },
  });

  /**
   * 从聊天列表缓存（若已拉取）同步取某聊天的 file_size。
   * 列表缓存已有已解析数组时用它做内容失效判断；尚未拉取 → 返回 undefined（仅按 TTL）。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @returns {number|undefined}
   */
  function getChatFileSize(avatar, fileName) {
    try {
      const list = chatCache.peek(avatar);
      if (Array.isArray(list)) {
        const found = list.find((c) => c.file_name === fileName);
        return typeof found?.file_size === "number" ? found.file_size : undefined;
      }
    } catch {
      // 忽略：拿不到 file_size 就不做失效判断
    }
    return undefined;
  }

  // 完整聊天内容缓存（TTL 5 分钟 + file_size 变化自动失效）
  // 解决长聊天文件每次进目录/正文都重新 POST /api/chats/get 的卡顿
  const contentCache = createChatContentCacheCore({
    ttl: 5 * 60_000,
    fetcher: (avatar, fileName) =>
      getChatMessagesCore(deps, avatar, fileName),
  });

  return {
    getCharacters: () => getCharactersCore(deps),
    getCharChats: (charIdx, avatar) =>
      chatCache.get(avatar || getCharactersCore(deps)[charIdx]?.avatar),
    // 聊天内容：从内容缓存读取。若聊天列表缓存（TTL 60s）已有该聊天的
    // file_size，用它做失效判断——文件被追加/编辑导致大小变化时自动重新拉取。
    getChatMessages: (avatar, fileName) => {
      const size = getChatFileSize(avatar, fileName);
      return contentCache.get(avatar, fileName, size);
    },
    // 强制刷新某个聊天内容（如设置变更后需要重新分章）
    refreshChatMessages: (avatar, fileName) => {
      contentCache.invalidate(avatar, fileName);
      return contentCache.get(avatar, fileName, undefined);
    },
    invalidate: (avatar) => chatCache.invalidate(avatar),
    clearCache: () => {
      chatCache.clear();
      contentCache.clear();
    },
  };
}
