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

  const findRegex = regexFromString(String(script.findRegex));
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
      if (trimString) finalString = finalString.replaceAll(String(trimString), "");
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
    if (!Array.isArray(s[extName].regexEnabledIds)) s[extName].regexEnabledIds = [];
    return s[extName].regexEnabledIds;
  }

  /** 设置勾选状态 */
  function setEnabled(id, on) {
    const s = getSettings();
    if (!s[extName]) s[extName] = {};
    if (!Array.isArray(s[extName].regexEnabledIds)) s[extName].regexEnabledIds = [];
    const ids = s[extName].regexEnabledIds;
    const idx = ids.indexOf(id);
    if (on && idx === -1) ids.push(id);
    if (!on && idx !== -1) ids.splice(idx, 1);
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
    const enabled = new Set(getEnabledIds());
    if (enabled.size === 0) return text;

    let out = text;
    // 聚合所有来源：全局 + 当前角色级 + 所有预设（已勾选的跨预设累积）
    const all = getAllScripts({ avatar });
    for (const item of all) {
      if (!enabled.has(item.key) && !enabled.has(item.script.id)) continue;
      try {
        out = runRegexScript(item.script, out);
      } catch (err) {
        console.warn("[NovelReader] 正则执行失败:", item.script.scriptName, err);
      }
    }
    return out;
  }

  /** 是否启用了任何正则 */
  function hasEnabled() {
    return getEnabledIds().length > 0;
  }

  return {
    getEnabledIds,
    setEnabled,
    getAllScripts,
    getAllPresets,
    getPresetScripts,
    runRegexOnText,
    hasEnabled,
  };
}
