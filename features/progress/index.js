// features/progress/index.js
// 阅读进度持久化：按「角色 avatar + 聊天 file_name」维度记录阅读位置。
// 数据存于 extension_settings[extName].novelProgress，随 ST 设置自动保存。
// 最小闭环阶段提供轻量实现：记录/读取/清理。

/**
 * 创建阅读进度核心。
 * @param {object} deps 依赖注入
 * @param {string} deps.extName 插件扩展名（用于 extension_settings 命名空间）
 * @param {Function} deps.getSettings   () => object  读取 extension_settings（含目标命名空间）
 * @param {Function} deps.saveSettings  () => void   保存设置（saveSettingsDebounced）
 * @returns {object} progress API
 */
export function createProgressCore(deps) {
  const { extName, getSettings, saveSettings } = deps;

  /** 读取进度表（惰性初始化） */
  function table() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!s[extName].novelProgress) s[extName].novelProgress = {};
    return s[extName].novelProgress;
  }

  /**
   * 记录某聊天阅读位置。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @param {{ chapter?: number, msgId?: number|string, index?: number, scrollTop?: number, updatedAt?: number }} pos 位置信息
   */
  function save(avatar, fileName, pos) {
    const t = table();
    const key = `${avatar}::${fileName}`;
    t[key] = {
      chapter: pos.chapter ?? 0, // 当前章节索引（1 起；0 = 未进入正文）
      msgId: pos.msgId ?? null,
      index: pos.index ?? 0,
      scrollTop: pos.scrollTop ?? 0,
      updatedAt: pos.updatedAt ?? Date.now(),
    };
    saveSettings();
  }

  /**
   * 读取某聊天阅读位置。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileName 聊天文件名（带 .jsonl）
   * @returns {object|null} 位置信息或 null
   */
  function load(avatar, fileName) {
    const t = table();
    return t[`${avatar}::${fileName}`] ?? null;
  }

  /** 清除某聊天阅读位置 */
  function clear(avatar, fileName) {
    const t = table();
    delete t[`${avatar}::${fileName}`];
    saveSettings();
  }

  /** 清除某角色全部阅读位置 */
  function clearByAvatar(avatar) {
    const t = table();
    for (const key of Object.keys(t)) {
      if (key.startsWith(`${avatar}::`)) delete t[key];
    }
    saveSettings();
  }

  /** 把某聊天的阅读位置迁移到新文件名（重命名聊天时同步迁移 key） */
  function renameKey(avatar, oldFileName, newFileName) {
    const t = table();
    const oldKey = `${avatar}::${oldFileName}`;
    if (t[oldKey]) {
      t[`${avatar}::${newFileName}`] = t[oldKey];
      delete t[oldKey];
      saveSettings();
    }
  }

  return { save, load, clear, clearByAvatar, renameKey };
}
