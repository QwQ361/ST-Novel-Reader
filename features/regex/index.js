// features/regex/index.js
// 正则过滤核心：让用户把酒馆的正则应用到小说阅读渲染。
//
// 数据源（与酒馆正则面板一致）：
//   - 全局正则：extension_settings.regex（用户在正则面板创建的「全局」类型脚本）
//   - 角色正则：当前角色 data.extensions.regex_scripts（角色的「角色」类型脚本）
//   - 预设正则：当前 API 预设管理器中的各预设 extensions.regex_scripts
//     （通过 getPresetManager().readPresetExtensionField({ name, path: 'regex_scripts' }) 按名读取）
//
// 勾选状态持久化：extension_settings[EXT_NAME].regexEnabledIds（Array<string>，存脚本 key）。
// 每个脚本一个唯一 key：
//   - 全局：global:{id}
//   - 角色：character:{avatar}:{id}
//   - 预设：preset:{apiId}:{presetName}:{id}   ← 跨 API/预设唯一，勾选后不随当前选中预设丢失
// 默认全部不勾选（保守），用户按需在「阅读器选项 → 正则过滤」中勾选。
// 预设正则「跨预设累积」：切换查看预设时，已勾选的其他预设正则依然生效（key 持久化）。
//
// 执行引擎：自实现 runRegexScript（复刻 ST engine.js 的 runRegexScript 核心）：
//   - findRegex 支持 /pattern/flags 或普通字符串（regexFromString 解析）
//   - replaceString 支持 {{match}}（→ $0）、$1 / $<name> 捕获组
//   - trimStrings 从替换结果中剔除指定子串
//   不依赖 ST 的 substituteParams 宏（{{user}}/{{char}} 等）：阅读器渲染的是历史聊天，
//   宏没有当前上下文，直接按字面处理。

/**
 * 将正则字符串解析为 RegExp（复刻 ST utils.js regexFromString）。
 * 支持 /pattern/flags 与裸字符串；解析失败返回 null。
 * @param {string} input
 * @returns {RegExp|null}
 */
export function regexFromString(input) {
  try {
    const m = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
    if (!m) return null;
    if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
      return new RegExp(String(input));
    }
    return new RegExp(m[2], m[3]);
  } catch {
    return null;
  }
}

// ---- RegExp 编译缓存 ----
// 同一 findRegex 字符串的编译结果确定且不可变，渲染热路径（每章上百条消息）
// 会反复执行同一批正则脚本，这里按字符串缓存编译结果，避免每条消息重复编译。
const regexCache = new Map();
const REGEX_CACHE_MAX = 200;

/**
 * 取编译后的 RegExp（带缓存；结果确定，仅用于 String.replace，无 lastIndex 副作用）。
 * @param {string} findRegex 原始 findRegex 字符串
 * @returns {RegExp|null}
 */
function getCompiledRegex(findRegex) {
  const key = String(findRegex ?? "");
  if (regexCache.has(key)) return regexCache.get(key);
  const re = regexFromString(key);
  // 防无限增长：超出上限时清空（下次重新编译，量小可接受）
  if (regexCache.size >= REGEX_CACHE_MAX) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

/**
 * 对单个正则脚本执行替换（复刻 ST runRegexScript 核心，去除宏依赖）。
 * @param {object} script RegexScriptData 结构
 * @param {string} rawString 原文
 * @returns {string} 替换后的文本
 */
export function runRegexScript(script, rawString) {
  let newString = rawString;
  if (
    !script ||
    script.disabled ||
    !script.findRegex ||
    typeof rawString !== "string"
  ) {
    return newString;
  }

  const findRegex = getCompiledRegex(String(script.findRegex));
  if (!findRegex) return newString;

  const replaceString = String(script.replaceString ?? "").replace(
    /{{match}}/gi,
    "$0",
  );

  newString = rawString.replace(findRegex, function (match) {
    const args = [...arguments];
    const replaceWithGroups = replaceString.replaceAll(
      /\$(\d+)|\$<([^>]+)>/g,
      (_, num, groupName) => {
        if (num) {
          match = args[Number(num)];
        } else if (groupName) {
          const groups = args[args.length - 1];
          match =
            groups && typeof groups === "object" && groups[groupName]
              ? groups[groupName]
              : "";
        }
        if (!match) return "";
        // trimStrings：剔除匹配内容中的指定子串
        const filtered = applyTrimStrings(match, script.trimStrings);
        return filtered;
      },
    );
    return replaceWithGroups;
  });

  return newString;
}

/**
 * 剔除替换结果中的 trimStrings。
 * @param {string} rawString
 * @param {string[]} [trimStrings]
 * @returns {string}
 */
function applyTrimStrings(rawString, trimStrings) {
  let finalString = String(rawString ?? "");
  if (Array.isArray(trimStrings)) {
    for (const trimString of trimStrings) {
      if (trimString)
        finalString = finalString.replaceAll(String(trimString), "");
    }
  }
  return finalString;
}

/**
 * 创建正则过滤核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getSettings 读 extension_settings
 * @param {Function} deps.saveSettings 持久化
 * @param {Function} deps.getStContext 获取 ST 上下文（取全局正则 / 当前角色）
 * @param {string} deps.extName 插件名（extension_settings 下的键）
 * @returns {object} regex API
 */
export function createRegexCore(deps) {
  const { getSettings, saveSettings, getStContext, extName } = deps;

  // ---- 脚本列表缓存 ----
  // getAllScripts（默认「全部预设」枚举）的结果按 avatar 维度缓存：
  // 渲染热路径中每条消息都会调用 runRegexOnText → getAllScripts，
  // 若不缓存，长聊天渲染会逐条消息重新枚举全部预设并读取各预设的正则脚本
  // （readPresetExtensionField 可能触发预设文件读取），是明显的重复开销。
  // 缓存 10s（预设/脚本变更后最迟 10s 反映；聊天切换时由 index.js 显式失效）。
  const scriptListCache = new Map(); // avatar -> { ts, items }
  const SCRIPT_LIST_TTL = 10_000;

  /**
   * 预设名转 key 段（预设名可能含冒号，替换为全角冒号避免 key 解析歧义）。
   * @param {string} name
   * @returns {string}
   */
  function encodePresetName(name) {
    return String(name ?? "").replaceAll(":", "：");
  }

  /**
   * 获取当前 API 的预设管理器。
   * 优先走 ST 标准路径：SillyTavern.getContext().getPresetManager(apiId)
   * （st-context.js 已把 preset-manager.js 的 getPresetManager 挂到 context 上，CFM 同款写法）。
   * 兜底：集成层的动态导入（preset-manager.js 模块命名空间）。
   * 无参调用时 PresetManager 内部用 main_api 决定 apiId（与 ST engine.js 读预设正则一致）。
   * @returns {object|null} PresetManager 实例或 null
   */
  function getPresetManager() {
    try {
      const ctx = getStContext?.() || null;
      if (typeof ctx?.getPresetManager === "function") {
        const pm = ctx.getPresetManager();
        if (pm) return pm;
      }
      // 兜底：动态导入 preset-manager.js（部分旧版 ST / 极端情况 context 未挂载）
      const getPm = deps?.getPresetManagerFunc?.();
      if (typeof getPm === "function") {
        const pm = getPm();
        if (pm) return pm;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 读取指定预设的正则脚本（readPresetExtensionField 同步按名读取）。
   * @param {string} presetName 预设名
   * @returns {Array<object>} 正则脚本数组
   */
  function getPresetScripts(presetName) {
    try {
      const pm = getPresetManager();
      if (!pm || !presetName) return [];
      const scripts = pm.readPresetExtensionField({
        name: presetName,
        path: "regex_scripts",
      });
      return Array.isArray(scripts) ? scripts : [];
    } catch (err) {
      console.warn("[NovelReader] 读取预设正则失败:", presetName, err);
      return [];
    }
  }

  /**
   * 枚举所有预设（名 + 各自正则脚本数），供设置弹窗下拉选择。
   * @returns {Array<{name: string, count: number}>}
   */
  function getAllPresets() {
    try {
      const pm = getPresetManager();
      if (!pm) return [];
      const names = pm.getAllPresets?.() ?? [];
      return names
        .filter((n) => n && n !== "gui")
        .map((name) => ({ name, count: getPresetScripts(name).length }));
    } catch (err) {
      console.warn("[NovelReader] 枚举预设失败:", err);
      return [];
    }
  }

  /** 读勾选的脚本 id 列表（默认空数组） */
  function getEnabledIds() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds))
      s[extName].regexEnabledIds = [];
    return s[extName].regexEnabledIds;
  }

  /** 设置勾选状态 */
  function setEnabled(id, on) {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds))
      s[extName].regexEnabledIds = [];
    const ids = s[extName].regexEnabledIds;
    const idx = ids.indexOf(id);
    if (on && idx === -1) ids.push(id);
    if (!on && idx !== -1) ids.splice(idx, 1);
    saveSettings?.();
  }

  /**
   * 读用户手动排除的脚本 key 列表（用于「取消自动勾选」的全局正则）。
   * 全局正则默认跟随酒馆勾选状态自动启用；用户手动取消后写入此列表，
   * 之后即使酒馆中仍启用也保持取消（除非用户重新勾选）。
   * @returns {string[]}
   */
  function getExcludedIds() {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexExcludedIds))
      s[extName].regexExcludedIds = [];
    return s[extName].regexExcludedIds;
  }

  /**
   * 判断某条正则是否有效启用（勾选状态）。
   * 优先级：手动排除（用户取消自动勾选）> 手动勾选列表 > 全局正则酒馆启用（自动勾选）。
   * @param {{script: object, source: string, key: string}} item getAllScripts 返回的元素
   * @returns {boolean}
   */
  function isEnabled(item) {
    if (!item || !item.key) return false;
    if (getExcludedIds().includes(item.key)) return false;
    const enabled = getEnabledIds();
    if (enabled.includes(item.key) || enabled.includes(item.script?.id))
      return true;
    // 全局正则：酒馆正则面板中用户当前勾选（未禁用）的自动勾选
    if (item.source === "global" && !item.script?.disabled) return true;
    return false;
  }

  /**
   * 设置某条正则的启用状态（统一处理手动勾选 + 自动勾选的排除标记）。
   * @param {{script: object, source: string, key: string}} item
   * @param {boolean} on
   */
  function setEnabledState(item, on) {
    if (!item || !item.key) return;
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds))
      s[extName].regexEnabledIds = [];
    if (!Array.isArray(s[extName].regexExcludedIds))
      s[extName].regexExcludedIds = [];
    const enabled = s[extName].regexEnabledIds;
    const excluded = s[extName].regexExcludedIds;
    const ei = enabled.indexOf(item.key);
    const xi = excluded.indexOf(item.key);
    if (on) {
      // 勾选：移除排除标记，并记录手动勾选
      if (ei === -1) enabled.push(item.key);
      if (xi !== -1) excluded.splice(xi, 1);
    } else {
      // 取消：移除手动勾选
      if (ei !== -1) enabled.splice(ei, 1);
      // 若该全局正则当前在酒馆中启用（会自动勾选），需记录排除以维持取消状态
      if (item.source === "global" && !item.script?.disabled && xi === -1) {
        excluded.push(item.key);
      }
    }
    saveSettings?.();
  }

  /**
   * 获取所有可用正则脚本（全局 + 当前角色级 + 所有预设），标注来源。
   * @param {object} [options]
   * @param {string} [options.avatar] 当前角色头像名（用于取角色级正则）
   * @param {Array<string>} [options.presetNames] 需要包含的预设名（默认 = 所有预设）
   * @returns {Array<{script: object, source: "global"|"character"|"preset", key: string, presetName?: string}>}
   *   key 用于勾选状态的唯一标识：
   *     global:{id} / character:{avatar}:{id} / preset:{apiId}:{presetName}:{id}
   */
  function getAllScripts(options = {}) {
    const { avatar = "", presetNames = null } = options;
    // 渲染热路径缓存：默认（presetNames = null，即「全部预设」）枚举结果按 avatar 缓存。
    // 显式指定 presetNames 的临时枚举（设置面板局部查询）不缓存。
    if (presetNames == null) {
      const hit = scriptListCache.get(avatar);
      if (hit && Date.now() - hit.ts < SCRIPT_LIST_TTL) return hit.items;
    }
    const results = [];
    const seen = new Set();

    const push = (script, source, extra = {}) => {
      if (!script || typeof script !== "object") return;
      const id = script.id;
      if (!id) return;
      let key;
      if (source === "global") {
        // 全局脚本与角色无关（跨角色勾选状态一致）
        key = `global:${id}`;
      } else if (source === "character") {
        key = `character:${avatar}:${id}`;
      } else {
        // 预设：key 含 apiId + 预设名 + id，跨 API/预设唯一
        const pm = getPresetManager();
        const apiId = pm?.apiId ?? "preset";
        const presetName = encodePresetName(extra.presetName ?? "");
        key = `preset:${apiId}:${presetName}:${id}`;
      }
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ script, source, key, ...extra });
    };

    // 全局正则：extension_settings.regex
    const ctx = getStContext?.() || null;
    const globalScripts = ctx?.extensionSettings?.regex;
    if (Array.isArray(globalScripts)) {
      globalScripts.forEach((s) => push(s, "global"));
    }

    // 角色正则：characters[avatar].data.extensions.regex_scripts
    if (avatar) {
      const char = ctx?.characters?.find((c) => c.avatar === avatar);
      const charScripts = char?.data?.extensions?.regex_scripts;
      if (Array.isArray(charScripts)) {
        charScripts.forEach((s) => push(s, "character"));
      }
    }

    // 预设正则：所有预设（或指定预设）的 extensions.regex_scripts
    // presetNames 语义：undefined = 全部预设；[] = 不加载预设；[name] = 仅指定预设
    const pm = getPresetManager();
    let presetNamesToLoad = [];
    if (Array.isArray(presetNames)) {
      presetNamesToLoad = presetNames;
    } else if (pm) {
      presetNamesToLoad = (pm.getAllPresets?.() ?? []).filter(
        (n) => n && n !== "gui",
      );
    }
    for (const presetName of presetNamesToLoad) {
      const scripts = getPresetScripts(presetName);
      scripts.forEach((s) => push(s, "preset", { presetName }));
    }

    // 仅缓存默认枚举结果；防无限增长（角色/头像过多时直接清空，下次重新枚举）
    if (presetNames == null) {
      scriptListCache.set(avatar, { ts: Date.now(), items: results });
      if (scriptListCache.size > 64) scriptListCache.clear();
    }
    return results;
  }

  /**
   * 对文本应用所有已勾选的正则（按顺序）。
   * 已勾选的预设正则跨预设聚合生效（例如预设1勾选正则A、预设2勾选正则B，两者都会应用）。
   * @param {string} text 原文
   * @param {object} [options]
   * @param {string} [options.avatar] 当前角色头像（决定启用哪些角色级正则）
   * @returns {string} 过滤后的文本
   */
  function runRegexOnText(text, options = {}) {
    if (typeof text !== "string" || !text) return text ?? "";
    const { avatar = "" } = options;

    // 聚合所有来源：全局 + 当前角色级 + 所有预设（已勾选的跨预设累积；
    // 全局正则自动勾选酒馆中用户当前启用的脚本）。
    // 列表走缓存（10s），避免每条消息重复枚举预设。
    const all = getAllScripts({ avatar });

    // 快速路径：一次性收集启用脚本，无启用时直接返回原文
    // （避免逐条消息重复 getAllScripts + 逐个 isEnabled 判断）
    const enabledItems = [];
    for (const item of all) {
      if (isEnabled(item)) enabledItems.push(item);
    }
    if (!enabledItems.length) return text;

    let out = text;
    for (const item of enabledItems) {
      try {
        out = runRegexScript(item.script, out);
      } catch (err) {
        console.warn(
          "[NovelReader] 正则执行失败:",
          item.script.scriptName,
          err,
        );
      }
    }
    return out;
  }

  /** 是否启用了任何正则（含自动勾选的全局正则） */
  function hasEnabled() {
    return getAllScripts().some((item) => isEnabled(item));
  }

  /** 失效脚本列表缓存（聊天切换 / 角色重命名 / 正则脚本变更后调用） */
  function invalidateScriptCache() {
    scriptListCache.clear();
  }

  return {
    getEnabledIds,
    getExcludedIds,
    setEnabled,
    setEnabledState,
    isEnabled,
    getAllScripts,
    getAllPresets,
    getPresetScripts,
    runRegexOnText,
    hasEnabled,
    invalidateScriptCache,
  };
}
