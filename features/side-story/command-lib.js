// features/side-story/command-lib.js
// 番外指令库数据层：tag（标签，多对多）+ 指令（全局汇总，只存文本）。
// 数据存于 extension_settings[extName].novelSideStory，随 ST 设置自动保存。
// 存储结构：
//   novelSideStory = {
//     tags: {                            // 标签表（平铺，无层级）
//       "tag_abc": { id: "tag_abc", name: "日常", createdAt: 1234567890 }
//     },
//     commands: {                        // 指令库（全局，跨聊天汇总）
//       "cmd_789": {
//         id: "cmd_789",
//         text: "（user 指令原文）",
//         name: "可选名称",               // 用户给指令取的名字
//         tagIds: ["tag_abc", "tag_def"], // 多对多，默认 []
//         favorite: false,                // 收藏（指令行星标）
//         createdAt: 1234567890
//       }
//     }
//   }
// 旧数据迁移：1.x 版本的 categories（文件夹树）+ 指令 categoryId 会在首次访问时
// 自动迁移为 tags + tagIds（拍平层级，指令归类到对应 tag），迁移后清理 categories。
// 去重：按 user 指令文本（trim 后）完全一致去重。

/** 生成唯一 id（时间戳 + 随机段，可跨标签页防撞） */
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 创建番外指令库核心。
 * @param {object} deps 依赖注入
 * @param {string} deps.extName 插件扩展名（用于 extension_settings 命名空间）
 * @param {Function} deps.getSettings   () => object  读取 extension_settings（含目标命名空间）
 * @param {Function} deps.saveSettings  () => void   保存设置（saveSettingsDebounced）
 * @returns {object} command-lib API
 */
export function createCommandLibCore(deps) {
  const { extName, getSettings, saveSettings } = deps;

  /**
   * 旧数据迁移（惰性一次性）：categories 文件夹树 → tags 标签表。
   * - 所有分类（含子分类）拍平为 tag，父子同名时子分类加父名前缀防冲突
   * - 指令 categoryId → tagIds（原所属分类映射到对应 tag）
   * - 迁移完成后删除 categories 字段；幂等：仅当 categories 存在且 tags 不存在时执行
   */
  function ensureMigration() {
    const s = getSettings();
    const t = s[extName]?.novelSideStory;
    if (!t || !t.categories || t.tags) return;
    t.tags = {};
    // 子分类映射（保证父先于子处理，便于父子同名前缀）
    const byParent = {};
    for (const c of Object.values(t.categories)) {
      const pid = c.parentId ?? null;
      (byParent[pid] ||= []).push(c);
    }
    const catToTag = {}; // categoryId -> tagId
    const usedNames = new Set();
    const process = (parentId, parentName) => {
      const children = byParent[parentId] || [];
      children.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      for (const c of children) {
        let name = String(c.name || "未命名").trim() || "未命名";
        // 父子同名 → 子分类加父名前缀防冲突
        if (parentName && name === parentName) name = `${parentName}-${name}`;
        // 顶层/全局查重：重名时追加序号
        let finalName = name;
        let n = 2;
        while (usedNames.has(finalName)) {
          finalName = `${name} (${n})`;
          n++;
        }
        usedNames.add(finalName);
        const tag = { id: uid("tag"), name: finalName, createdAt: Date.now() };
        t.tags[tag.id] = tag;
        catToTag[c.id] = tag.id;
        process(c.id, c.name);
      }
    };
    process(null, null);
    // 指令：categoryId → tagIds
    for (const cmd of Object.values(t.commands || {})) {
      const tagId = cmd.categoryId ? catToTag[cmd.categoryId] : null;
      delete cmd.categoryId;
      cmd.tagIds = tagId ? [tagId] : [];
    }
    delete t.categories;
    saveSettings();
  }

  /** 读取指令库表（惰性初始化 + 触发一次性迁移） */
  function table() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!s[extName].novelSideStory) s[extName].novelSideStory = {};
    const t = s[extName].novelSideStory;
    if (!t.tags) t.tags = {};
    if (!t.commands) t.commands = {};
    ensureMigration();
    return t;
  }

  // ---------------- tag ----------------

  /** 列出全部 tag（返回 tag 对象映射副本） */
  function listTags() {
    return { ...table().tags };
  }

  /**
   * 创建单个 tag。
   * @param {string} name tag 名
   * @returns {object|null} 新 tag 对象；名称为空或已存在（trim 后一致）返回 null
   */
  function createTag(name) {
    const t = table();
    const n = String(name || "").trim();
    if (!n) return null;
    if (Object.values(t.tags).some((tag) => tag.name === n)) return null;
    const tag = { id: uid("tag"), name: n, createdAt: Date.now() };
    t.tags[tag.id] = tag;
    saveSettings();
    return tag;
  }

  /**
   * 批量创建 tag：接收数组或逗号分隔字符串（支持中英文逗号 `，` `,`）。
   * 逐条 trim 后创建；空名 / 重复名（含已存在）跳过；返回新建 tag 对象数组。
   * @param {Array<string>|string} names tag 名（数组或逗号分隔字符串）
   * @returns {Array<object>} 新建的 tag 对象数组
   */
  function createTags(names) {
    const raw = Array.isArray(names)
      ? names
      : String(names || "").split(/[,，]/);
    const created = [];
    for (const item of raw) {
      const tag = createTag(String(item || "").trim());
      if (tag) created.push(tag);
    }
    return created;
  }

  /**
   * 重命名 tag（trim 后查重）。
   * @param {string} id tag id
   * @param {string} name 新 tag 名
   * @returns {boolean} 是否成功
   */
  function renameTag(id, name) {
    const t = table();
    const tag = t.tags[id];
    if (!tag) return false;
    const n = String(name || "").trim();
    if (!n) return false;
    if (Object.values(t.tags).some((x) => x.id !== id && x.name === n))
      return false;
    tag.name = n;
    saveSettings();
    return true;
  }

  /**
   * 删除单个 tag：并从所有指令的 tagIds 中移除。
   * @param {string} id tag id
   * @returns {boolean} 是否成功
   */
  function deleteTag(id) {
    const t = table();
    if (!t.tags[id]) return false;
    delete t.tags[id];
    for (const cmd of Object.values(t.commands)) {
      if (Array.isArray(cmd.tagIds)) {
        cmd.tagIds = cmd.tagIds.filter((x) => x !== id);
      }
    }
    saveSettings();
    return true;
  }

  /**
   * 批量删除 tag：逐个删除并从所有指令 tagIds 移除；返回成功删除数量。
   * @param {Array<string>} ids tag id 数组
   * @returns {number} 成功删除数量
   */
  function deleteTags(ids) {
    let n = 0;
    for (const id of ids || []) {
      if (deleteTag(id)) n++;
    }
    return n;
  }

  // ---------------- 指令 ----------------

  /** 列出全部指令（返回指令对象映射副本） */
  function listCommands() {
    return { ...table().commands };
  }

  /** 列出全部指令（按创建时间倒序） */
  function listAllCommands() {
    const t = table();
    return Object.values(t.commands).sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    );
  }

  /** 列出含某 tag 的指令（按创建时间倒序） */
  function listCommandsByTag(tagId) {
    const t = table();
    if (!t.tags[tagId]) return [];
    return Object.values(t.commands)
      .filter((cmd) => Array.isArray(cmd.tagIds) && cmd.tagIds.includes(tagId))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 列出无任何 tag 的指令（按创建时间倒序） */
  function listUntaggedCommands() {
    const t = table();
    return Object.values(t.commands)
      .filter((cmd) => !Array.isArray(cmd.tagIds) || cmd.tagIds.length === 0)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /**
   * 创建指令（手动创建 / 导入）。
   * @param {string} text 指令文本
   * @param {object} [options]
   * @param {string} [options.name] 指令名称（可选）
   * @param {Array<string>} [options.tagIds] 所属 tag id 数组（默认 []，无效 id 忽略）
   * @returns {object|null} 新指令对象；文本为空返回 null
   */
  function createCommand(text, options = {}) {
    const t = table();
    const txt = String(text || "").trim();
    if (!txt) return null;
    const tagIds = Array.isArray(options.tagIds)
      ? options.tagIds.filter((id) => t.tags[id])
      : [];
    const cmd = {
      id: uid("cmd"),
      text: txt,
      name: String(options.name || "").trim(),
      tagIds,
      favorite: Boolean(options.favorite),
      createdAt: Date.now(),
    };
    t.commands[cmd.id] = cmd;
    saveSettings();
    return cmd;
  }

  /**
   * 按文本内容查重（trim 后完全一致）。
   * @param {string} text 指令文本
   * @returns {boolean} 已存在则 true
   */
  function existsByText(text) {
    const t = table();
    const txt = String(text || "").trim();
    if (!txt) return false;
    return Object.values(t.commands).some(
      (cmd) => String(cmd.text || "").trim() === txt,
    );
  }

  /**
   * 从消息文本加入指令库（番外标注自动入库用；按文本去重）。
   * 未提供名称时自动命名为「未命名-N」（N 为自增序号），避免 name 为空
   * 导致批量重命名时把指令正文误识别为公共前/后缀。
   * @param {string} text 指令文本（user 楼层正文）
   * @param {object} [options] 同 createCommand
   * @returns {object|null} 已存在返回 null（不入库）；新增返回新指令
   */
  function addFromMessage(text, options = {}) {
    if (existsByText(text)) return null;
    let name = String(options.name || "").trim();
    if (!name) {
      let n = 1;
      while (existsByName(`未命名-${n}`)) n += 1;
      name = `未命名-${n}`;
    }
    return createCommand(text, { ...options, name });
  }

  /**
   * 按名称查重（trim 后完全一致）。
   * @param {string} name 指令名称
   * @returns {boolean} 已存在则 true
   */
  function existsByName(name) {
    const t = table();
    const n = String(name || "").trim();
    if (!n) return false;
    return Object.values(t.commands).some(
      (cmd) => String(cmd.name || "").trim() === n,
    );
  }

  /**
   * 更新指令（文本 / 名称 / tagIds / 收藏）。
   * @param {string} id 指令 id
   * @param {object} patch { text?, name?, tagIds?, favorite? }（tagIds 整体替换）
   * @returns {boolean} 是否成功
   */
  function updateCommand(id, patch = {}) {
    const t = table();
    const cmd = t.commands[id];
    if (!cmd) return false;
    if (patch.text !== undefined) {
      const txt = String(patch.text || "").trim();
      if (!txt) return false;
      cmd.text = txt;
    }
    if (patch.name !== undefined) cmd.name = String(patch.name || "").trim();
    if (patch.favorite !== undefined) cmd.favorite = Boolean(patch.favorite);
    if (patch.tagIds !== undefined) {
      cmd.tagIds = Array.isArray(patch.tagIds)
        ? patch.tagIds.filter((tid) => t.tags[tid])
        : [];
    }
    saveSettings();
    return true;
  }

  /**
   * 切换指令收藏，返回切换后是否为已收藏。
   * @param {string} id 指令 id
   * @returns {boolean} 切换后是否为已收藏（失败返回 false）
   */
  function toggleFavorite(id) {
    const t = table();
    const cmd = t.commands[id];
    if (!cmd) return false;
    cmd.favorite = !cmd.favorite;
    saveSettings();
    return cmd.favorite;
  }

  /**
   * 收藏指令列表（按收藏时间倒序）。
   * @returns {Array<object>} 收藏的指令对象数组
   */
  function listFavoriteCommands() {
    const t = table();
    return Object.values(t.commands)
      .filter((cmd) => cmd.favorite)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 收藏指令数量 */
  function listFavoriteCount() {
    return Object.values(table().commands).filter((cmd) => cmd.favorite).length;
  }

  /** 删除指令 */
  function deleteCommand(id) {
    const t = table();
    if (!t.commands[id]) return false;
    delete t.commands[id];
    saveSettings();
    return true;
  }

  /** 清空指令库（保留 tags） */
  function clearCommands() {
    table().commands = {};
    saveSettings();
  }

  return {
    listTags,
    createTag,
    createTags,
    renameTag,
    deleteTag,
    deleteTags,
    listCommands,
    listAllCommands,
    listCommandsByTag,
    listUntaggedCommands,
    createCommand,
    existsByText,
    existsByName,
    addFromMessage,
    updateCommand,
    toggleFavorite,
    listFavoriteCommands,
    listFavoriteCount,
    deleteCommand,
    clearCommands,
  };
}
