// features/bookmarks/index.js
// 书签功能聚合入口：收藏章节 + 收藏列表（数据层）。
// 数据存于 extension_settings[extName].novelBookmarks，随 ST 设置自动保存。
// 存储结构：
//   novelBookmarks = {
//     "avatar::fileName": {
//       "3": { chapter: 3, title: "章节标题", size: 12, addedAt: 1234567890 },
//       "7": { chapter: 7, title: "章节标题", size: 8,  addedAt: 1234567891 }
//     }
//   }
// 内层用「章节号 → 书签」的对象映射：同一章重复收藏只保留一份（覆盖标题/大小）。

/**
 * 创建书签核心。
 * @param {object} deps 依赖注入
 * @param {string} deps.extName 插件扩展名（用于 extension_settings 命名空间）
 * @param {Function} deps.getSettings   () => object  读取 extension_settings（含目标命名空间）
 * @param {Function} deps.saveSettings  () => void   保存设置（saveSettingsDebounced）
 * @returns {object} bookmarks API
 */
export function createBookmarksCore(deps) {
  const { extName, getSettings, saveSettings } = deps;

  /** 读取书签表（惰性初始化） */
  function table() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!s[extName].novelBookmarks) s[extName].novelBookmarks = {};
    return s[extName].novelBookmarks;
  }

  /**
   * 收藏章节（同一章重复收藏覆盖标题/大小，保留原 addedAt）。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @param {{ chapter: number, title?: string, size?: number }} bm 书签信息
   */
  function add(avatar, fileName, bm) {
    const t = table();
    const key = `${avatar}::${fileName}`;
    if (!t[key]) t[key] = {};
    const prev = t[key][String(bm.chapter)];
    t[key][String(bm.chapter)] = {
      chapter: bm.chapter,
      title: bm.title ?? "",
      size: Number(bm.size) || 0,
      addedAt: prev?.addedAt ?? Date.now(),
    };
    saveSettings();
  }

  /**
   * 删除某聊天某章书签。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @param {number} chapter 章节号（1 起）
   */
  function remove(avatar, fileName, chapter) {
    const t = table();
    const key = `${avatar}::${fileName}`;
    if (t[key]) {
      delete t[key][String(chapter)];
      if (!Object.keys(t[key]).length) delete t[key];
    }
    saveSettings();
  }

  /**
   * 列出某聊天全部书签（按章节大小降序；同大小按章节号升序）。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @returns {Array<{chapter:number,title:string,size:number,addedAt:number}>}
   */
  function list(avatar, fileName) {
    const t = table();
    const key = `${avatar}::${fileName}`;
    const map = t[key] || {};
    return Object.values(map)
      .filter((b) => b && Number(b.chapter) > 0)
      .sort((a, b) => {
        if (b.size !== a.size) return b.size - a.size; // 章节大小降序
        return a.chapter - b.chapter; // 同大小按章节号升序
      });
  }

  /**
   * 某章是否已收藏。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @param {number} chapter 章节号（1 起）
   * @returns {boolean}
   */
  function has(avatar, fileName, chapter) {
    const t = table();
    const key = `${avatar}::${fileName}`;
    return Boolean(t[key] && t[key][String(chapter)]);
  }

  /** 清除某角色全部书签 */
  function clearByAvatar(avatar) {
    const t = table();
    for (const key of Object.keys(t)) {
      if (key.startsWith(`${avatar}::`)) delete t[key];
    }
    saveSettings();
  }

  return { add, remove, list, has, clearByAvatar };
}
