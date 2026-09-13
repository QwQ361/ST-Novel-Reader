// features/cfm-bridge/index.js
// CFM（AAAA-ST-Folder-Manager-V2）数据桥接（方案A：单向读取，CFM 零修改）。
export { createCfmFolderPanel } from "./panel.js";
// 仅当用户同时安装了 CFM 时启用：在小说插件的「角色搜索框」「预设搜索框」旁
// 注入文件夹下拉，按 CFM 的文件夹树过滤小说插件**自己的**搜索结果列表。
//
// 数据契约（CFM 侧全部存于全局 extension_settings["ST-Char-Folder-Manager"]，
// 任何插件都能直接读，无需 CFM 配合）：
//   - 角色文件夹树：CFM.folders = { [tagId]: { parentId, displayName, sortOrder } }
//   - 角色→文件夹归属：getStContext().tagMap = { [avatar]: [tagId...] }（SillyTavern 全局）
//   - 预设文件夹树：CFM.resourceFolderTree.presets = { [folderId]: { parentId, sortOrder, displayName? } }
//   - 预设→文件夹归属：CFM.presetGroups = { [presetName]: folderId }
//
// 角色归属判定（叶子标签模式，与 CFM features/folders/counts.js 一致）：
//   角色属于某文件夹 = tagMap[avatar] 含该 folderId，且不含任何子文件夹 id（父子互斥）
// 预设归属判定（与 CFM integrations/native-filters.js 一致）：
//   预设属于某文件夹 = presetGroups[name] === folderId（递归子文件夹）

const CFM_NS = "ST-Char-Folder-Manager";

/** 读 extension_settings（多入口兜底） */
function readExtSettings(deps) {
  try {
    return deps.getExtensionSettings?.() || deps.getSettings?.() || {};
  } catch {
    return {};
  }
}

/** 读 CFM 命名空间 */
function readCfm(deps) {
  return readExtSettings(deps)?.[CFM_NS] || {};
}

/**
 * 检测 CFM 是否正在运行。
 * 双条件判定：
 *   1) CFM 设置命名空间存在（首次运行 ensureSettingsDefaults 会创建）
 *   2) CFM 的运行按钮出现在 DOM 中——因为「设置存在」可能只是禁用/卸载后的残留，
 *      按钮才代表 CFM 此刻真正激活。三个按钮 id 对应 buttonMode 的三种模式：
 *      topbar → #cfm-topbar-button；floating → #cfm-folder-button；wand → #cfm-wand-button
 * @param {object} deps 依赖注入
 * @returns {boolean}
 */
function isCfmInstalled(deps = {}) {
  const hasSettings = !!readExtSettings(deps)?.[CFM_NS];
  if (!hasSettings) return false;
  try {
    const doc = deps.document || document;
    return !!(
      doc.querySelector("#cfm-topbar-button") ||
      doc.querySelector("#cfm-folder-button") ||
      doc.querySelector("#cfm-wand-button")
    );
  } catch {
    return false;
  }
}

/**
 * 读取 CFM 角色文件夹树。
 * @param {object} deps 依赖注入
 * @returns {object} { [tagId]: { parentId, displayName, sortOrder } }
 */
function getCfmCharFolders(deps = {}) {
  return readCfm(deps)?.folders || {};
}

/**
 * 读取 CFM 预设文件夹树。
 * @param {object} deps 依赖注入
 * @returns {object} { [folderId]: { parentId, sortOrder, displayName? } }
 */
function getCfmPresetFolders(deps = {}) {
  return readCfm(deps)?.resourceFolderTree?.presets || {};
}

/**
 * 读取预设→文件夹归属映射。
 * @param {object} deps 依赖注入
 * @returns {object} { [presetName]: folderId }
 */
function getCfmPresetGroups(deps = {}) {
  return readCfm(deps)?.presetGroups || {};
}

/**
 * 角色→文件夹归属（SillyTavern 全局 tagMap）。
 * @param {object} deps 依赖注入
 * @returns {object} { [avatar]: [tagId...] }
 */
function getCharTagMap(deps = {}) {
  try {
    const ctx = deps.getStContext?.();
    return ctx?.tagMap || {};
  } catch {
    return {};
  }
}

/**
 * 取某文件夹的直接子文件夹 ID 列表（按 sortOrder + 显示名排序）。
 * @param {object} tree 文件夹树
 * @param {string|null} parentId 父文件夹 id（null = 顶层）
 * @returns {Array<string>}
 */
function getChildIds(tree, parentId) {
  return Object.keys(tree)
    .filter((id) => tree[id]?.parentId === parentId)
    .sort((a, b) => {
      const oa = tree[a]?.sortOrder ?? 0;
      const ob = tree[b]?.sortOrder ?? 0;
      if (oa !== ob) return oa - ob;
      return (tree[a]?.displayName || a).localeCompare(
        tree[b]?.displayName || b,
        "zh-CN",
      );
    });
}

/**
 * 递归收集某文件夹下所有条目（含子文件夹）。
 * @param {"chars"|"presets"} type 类型
 * @param {string|null} folderId 文件夹 id；"__all__"/null = 全部（返回 null 由调用方放行）
 * @param {object} deps 依赖注入
 * @returns {Set<string>|null} chars 为 avatar 集合，presets 为预设名集合
 */
function getCfmItemsInFolder(type, folderId, deps = {}) {
  if (!folderId || folderId === "__all__") return null;

  const items = new Set();
  if (type === "chars") {
    const tree = getCfmCharFolders(deps);
    const tagMap = getCharTagMap(deps);
    const allChars = deps.getAllChars?.() || [];

    // 未归类：没有任何文件夹标签的角色
    if (folderId === "__ungrouped__") {
      const folderTagIds = new Set(Object.keys(tree));
      for (const c of allChars) {
        const avatar = c?.avatar;
        if (!avatar) continue;
        const tags = tagMap[avatar] || [];
        if (!tags.some((t) => folderTagIds.has(t))) items.add(avatar);
      }
      return items;
    }

    // 叶子标签模式：属于父文件夹 = 含父 id 且不含任何子文件夹 id
    const childIds = new Set(getChildIds(tree, folderId));
    for (const c of allChars) {
      const avatar = c?.avatar;
      if (!avatar) continue;
      const tags = tagMap[avatar] || [];
      if (tags.includes(folderId) && !tags.some((t) => childIds.has(t))) {
        items.add(avatar);
      }
    }
    // 递归子文件夹
    for (const childId of getChildIds(tree, folderId)) {
      for (const av of getCfmItemsInFolder("chars", childId, deps) || []) {
        items.add(av);
      }
    }
  } else {
    const tree = getCfmPresetFolders(deps);
    const groups = getCfmPresetGroups(deps);

    // 未归类：预设未映射到任何文件夹，或映射的文件夹已不存在
    if (folderId === "__ungrouped__") {
      for (const [name, fid] of Object.entries(groups)) {
        if (!fid || !tree[fid]) items.add(name);
      }
      return items;
    }

    // 预设归属：presetGroups[name] === folderId（精确映射）
    for (const [name, fid] of Object.entries(groups)) {
      if (fid === folderId) items.add(name);
    }
    // 递归子文件夹
    for (const childId of getChildIds(tree, folderId)) {
      for (const name of getCfmItemsInFolder("presets", childId, deps) || []) {
        items.add(name);
      }
    }
  }
  return items;
}

/**
 * 角色 tag 名列表（ST 全局 ctx.tags；CFM getTagNameCore 中间回退层）。
 * @param {object} deps 依赖注入
 * @returns {Array<{id: string, name: string}>}
 */
function getTagList(deps = {}) {
  try {
    const ctx = deps.getStContext?.();
    return Array.isArray(ctx?.tags) ? ctx.tags : [];
  } catch {
    return [];
  }
}

/**
 * 文件夹显示名：对齐 CFM getTagNameCore 的三级回退：
 *   1) tree[id].displayName（用户自定义显示名）
 *   2) ctx.tags 中 id 匹配的 tag 名（角色文件夹 = tag 本身的名字）
 *   3) id 本身（最后兜底，避免显示 UUID）
 * @param {object} tree 文件夹树
 * @param {string} id 文件夹 id
 * @param {object} [deps] 依赖注入（提供 getStContext 以读 ctx.tags）
 * @returns {string}
 */
function getFolderDisplayName(tree, id, deps = {}) {
  const node = tree?.[id];
  if (node?.displayName) return node.displayName;
  const tag = getTagList(deps).find((t) => t.id === id);
  if (tag?.name) return tag.name;
  return id;
}

/**
 * 返回全部文件夹 ID（含顶层与子层，用于「展开全部」）。
 * @param {"chars"|"presets"} type 类型
 * @param {object} deps 依赖注入
 * @returns {Array<string>}
 */
function getAllFolderIds(type, deps = {}) {
  const tree =
    type === "chars" ? getCfmCharFolders(deps) : getCfmPresetFolders(deps);
  return Object.keys(tree);
}

/**
 * 生成文件夹树 HTML（浮动面板用）。
 * 结构与 CFM ui/tree/tree-view.js 一致：箭头 + 图标 + 名称，层级缩进；
 * 顶部固定「全部」节点，底部固定「未归类」节点。
 * @param {"chars"|"presets"} type 类型
 * @param {Set<string>} expandedSet 展开节点 id 集合
 * @param {string} currentFilter 当前选中过滤值（用于高亮）
 * @param {object} deps 依赖注入
 * @returns {string} 树形 HTML
 */
function buildFolderTreeHtml(type, expandedSet, currentFilter, deps = {}) {
  const tree =
    type === "chars" ? getCfmCharFolders(deps) : getCfmPresetFolders(deps);
  const esc = escapeHtml;
  let html = `<div class="novel-cfm-tnode${
    currentFilter === "__all__" ? " novel-cfm-tnode-selected" : ""
  }" data-id="__all__"><span class="novel-cfm-tnode-arrow novel-cfm-arrow-hidden"><i class="fa-solid fa-caret-right"></i></span><span class="novel-cfm-tnode-icon"><i class="fa-solid fa-folder-tree"></i></span><span class="novel-cfm-tnode-label">全部</span></div>`;

  const walk = (parentId, depth) => {
    for (const id of getChildIds(tree, parentId)) {
      const children = getChildIds(tree, id);
      const hasChildren = children.length > 0;
      const isExpanded = expandedSet.has(id);
      const selected =
        currentFilter === id ? " novel-cfm-tnode-selected" : "";
      const arrowCls = hasChildren
        ? isExpanded
          ? " novel-cfm-arrow-expanded"
          : ""
        : " novel-cfm-arrow-hidden";
      html += `<div class="novel-cfm-tnode${selected}" data-id="${esc(
        id,
      )}" data-has-children="${hasChildren ? "1" : "0"}" style="padding-left:${
        8 + depth * 16
      }px">`;
      html += `<span class="novel-cfm-tnode-arrow${arrowCls}"><i class="fa-solid fa-caret-right"></i></span>`;
      html += `<span class="novel-cfm-tnode-icon"><i class="fa-solid ${
        isExpanded ? "fa-folder-open" : "fa-folder"
      }"></i></span>`;
      html += `<span class="novel-cfm-tnode-label">${esc(
        getFolderDisplayName(tree, id, deps),
      )}</span>`;
      html += `</div>`;
      if (hasChildren && isExpanded) walk(id, depth + 1);
    }
  };
  walk(null, 0);

  html += `<div class="novel-cfm-tnode${
    currentFilter === "__ungrouped__" ? " novel-cfm-tnode-selected" : ""
  }" data-id="__ungrouped__"><span class="novel-cfm-tnode-arrow novel-cfm-arrow-hidden"><i class="fa-solid fa-caret-right"></i></span><span class="novel-cfm-tnode-icon"><i class="fa-solid fa-circle-question"></i></span><span class="novel-cfm-tnode-label">未归类</span></div>`;
  return html;
}

/** HTML 转义（option 内用） */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 创建 CFM 数据桥接核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getExtensionSettings 读 extension_settings（小说插件的 getSettings）
 * @param {Function} deps.getStContext 取 ST 上下文（tagMap）
 * @param {Function} deps.getAllChars 返回全部角色数组（元素含 avatar 字段）
 * @returns {object} CFM 桥接 API
 */
export function createCfmBridgeCore(deps = {}) {
  return {
    isCfmInstalled: () => isCfmInstalled(deps),
    getCharFolders: () => getCfmCharFolders(deps),
    getPresetFolders: () => getCfmPresetFolders(deps),
    getPresetGroups: () => getCfmPresetGroups(deps),
    getCharTagMap: () => getCharTagMap(deps),
    getItemsInFolder: (type, folderId) =>
      getCfmItemsInFolder(type, folderId, deps),
    buildFolderOptions: (type) => buildCfmFolderOptions(type, deps),
    getAllFolderIds: (type) => getAllFolderIds(type, deps),
    buildFolderTreeHtml: (type, expandedSet, currentFilter) =>
      buildFolderTreeHtml(type, expandedSet, currentFilter, deps),
  };
}
