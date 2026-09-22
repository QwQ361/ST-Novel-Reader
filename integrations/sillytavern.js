// integrations/sillytavern.js
// SillyTavern 集成层：集中管理与 ST 核心的交互。
// - getStContext()：获取 ST 上下文
// - loadStCoreModules()：动态导入 ST 核心模块（幂等），缓存模块命名导出
// - 函数访问器：getPastCharacterChatsFunc / openCharacterChatFunc / messageFormattingFunc / getRequestHeaders
//
// ⚠️ 关键：现代 ST 是 ESM，getPastCharacterChats / openCharacterChat / messageFormatting /
// getRequestHeaders 等函数是 script.js 的**命名导出，不挂在 window 上**。
// 必须从 import() 返回的模块命名空间对象上取值，否则拿不到（CFM 同款写法）。

/**
 * 获取 SillyTavern 上下文对象。
 * @returns {object|null} SillyTavern.getContext() 的结果，不可用时返回 null
 */
export function getStContext() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch (err) {
    console.warn("[NovelReader] getStContext 失败:", err);
    return null;
  }
}

// ---- 模块导出缓存（由 loadStCoreModules 填充，访问器直接读取）----
let _scriptModule = null; // public/script.js 的模块命名空间
let _chatsModule = null; // public/scripts/chats.js 的模块命名空间
let _presetManagerModule = null; // public/scripts/preset-manager.js 的模块命名空间
let _loaded = false;

/**
 * 加载 ST 核心模块（幂等，可多次调用）。
 * script.js 位于 public/ 根目录，需要 5 级 .. 跳出插件目录。
 * @returns {Promise<boolean>} 是否加载完成
 */
export async function loadStCoreModules() {
  if (_loaded) return true;
  const results = await Promise.all([
    importScriptModule(),
    importChatsModule(),
    importPresetManagerModule(),
    importModule("../../../../personas.js"),
    importModule("../../../../utils.js"),
    importModule("../../../../popup.js"),
  ]);
  _loaded = results.some(Boolean);
  return _loaded;
}

/** 导入 public/script.js 并缓存其模块命名空间（converter / getRequestHeaders / 聊天 API 都在这里） */
async function importScriptModule() {
  try {
    _scriptModule = await import(/* @vite-ignore */ "../../../../../script.js");
    console.log(
      "[NovelReader] script.js 模块已加载，导出:",
      Object.keys(_scriptModule).filter((k) =>
        /converter|getRequestHeaders|getPastCharacterChats|openCharacterChat|getCharacters|selectCharacterById|messageFormatting/i.test(
          k,
        ),
      ),
    );
    return true;
  } catch (err) {
    console.warn("[NovelReader] 动态导入 script.js 失败:", err);
    return null;
  }
}

/** 导入 public/scripts/chats.js 并缓存（encodeStyleTags / decodeStyleTags 用于安全渲染管线） */
async function importChatsModule() {
  try {
    _chatsModule = await import(/* @vite-ignore */ "../../../../chats.js");
    return true;
  } catch (err) {
    console.warn("[NovelReader] 动态导入 chats.js 失败:", err);
    return null;
  }
}

/** 导入 public/scripts/preset-manager.js 并缓存（getPresetManager 用于读取各预设的 regex_scripts） */
async function importPresetManagerModule() {
  try {
    _presetManagerModule = await import(
      /* @vite-ignore */ "../../../../preset-manager.js"
    );
    return true;
  } catch (err) {
    console.warn("[NovelReader] 动态导入 preset-manager.js 失败:", err);
    return null;
  }
}

/**
 * 动态导入单个 ST 核心脚本（非 script.js / chats.js 的其他模块）。
 * 这些脚本是 ESM，import 后取所需导出；这里只保证其副作用执行。
 * @param {string} relativePath 相对当前文件的导入路径
 * @returns {Promise<boolean|null>}
 */
async function importModule(relativePath) {
  try {
    await import(/* @vite-ignore */ relativePath);
    return true;
  } catch (err) {
    console.warn("[NovelReader] 动态导入失败:", relativePath, err);
    return null;
  }
}

/**
 * 取「某角色的全部聊天列表」函数（script.js 命名导出）。
 * @returns {Function|null} getPastCharacterChats(charIdx) => Promise<Array>
 */
export function getPastCharacterChatsFunc() {
  return (
    _scriptModule?.getPastCharacterChats ?? window.getPastCharacterChats ?? null
  );
}

/**
 * 取「打开指定聊天」函数（script.js 命名导出）。
 * @returns {Function|null} openCharacterChat(fileNameWithoutExt) => Promise
 */
export function openCharacterChatFunc() {
  return _scriptModule?.openCharacterChat ?? window.openCharacterChat ?? null;
}

/**
 * 取「删除指定角色的聊天」函数（script.js 命名导出）。
 * @returns {Function|null} deleteCharacterChatByName(characterId, fileName) => Promise
 *   注意：characterId 为角色索引字符串，fileName 不含 .jsonl 扩展名
 */
export function deleteCharacterChatByNameFunc() {
  return (
    _scriptModule?.deleteCharacterChatByName ??
    window.deleteCharacterChatByName ??
    null
  );
}

/**
 * 取「重命名聊天」函数（script.js 命名导出）。
 * @returns {Function|null} renameGroupOrCharacterChat({characterId, groupId, oldFileName, newFileName, loader}) => Promise
 *   注意：old/newFileName 不含 .jsonl 扩展名
 */
export function renameGroupOrCharacterChatFunc() {
  return (
    _scriptModule?.renameGroupOrCharacterChat ??
    window.renameGroupOrCharacterChat ??
    null
  );
}

/**
 * 取「新建聊天」函数（script.js 命名导出）。
 * @returns {Function|null} doNewChat({deleteCurrentChat}) => Promise
 */
export function doNewChatFunc() {
  return _scriptModule?.doNewChat ?? window.doNewChat ?? null;
}

/**
 * 取「Markdown 消息渲染」函数（官方管线：showdown + sanitize）。
 * @returns {Function|null} messageFormatting(mes, ch_name, isSystem, isUser, messageId, sanitizerOverrides)
 */
export function messageFormattingFunc() {
  return _scriptModule?.messageFormatting ?? window.messageFormatting ?? null;
}

/**
 * 取「隐藏/恢复消息」函数（chats.js 命名导出；番外标注用）。
 * @returns {Function|null} hideChatMessageRange(startIndex, endIndex, unhide)
 *   将 chat 数组 [startIndex, endIndex] 区间的消息设为 is_system（从 AI 上下文排除），
 *   unhide=true 时反向恢复。startIndex/endIndex 为 chat 数组索引（含端点）。
 */
export function hideChatMessageRangeFunc() {
  return (
    _chatsModule?.hideChatMessageRange ?? window.hideChatMessageRange ?? null
  );
}

/**
 * 取「保存聊天」函数（script.js 命名导出；番外标注后持久化隐藏与标记）。
 * @returns {Function|null} saveChatConditional()
 */
export function saveChatConditionalFunc() {
  return (
    _scriptModule?.saveChatConditional ?? window.saveChatConditional ?? null
  );
}

/**
 * 取「预设管理器」函数（preset-manager.js 命名导出 getPresetManager）。
 * 优先用 ST 上下文自带的（SillyTavern.getContext().getPresetManager，st-context.js 已挂载），
 * 再兜底动态导入的模块命名空间。
 * @returns {Function|null} getPresetManager(apiId?) => PresetManager | null
 */
export function getPresetManagerFunc() {
  try {
    const ctx = getStContext();
    if (typeof ctx?.getPresetManager === "function")
      return ctx.getPresetManager;
    return (
      _presetManagerModule?.getPresetManager ?? window.getPresetManager ?? null
    );
  } catch (err) {
    console.warn("[NovelReader] getPresetManagerFunc 失败:", err);
    return null;
  }
}

// ---- Markdown 安全渲染管线 ----
// ⚠️ ST 的 messageFormatting 严重依赖全局 chat 数组与正则替换（chat.map / getRegexedString /
// chat[messageId]?.extra?.type），只能渲染「当前打开的聊天」；渲染非当前聊天时结果为空或错乱。
// 小说阅读器渲染「任意聊天」必须用 ST 暴露的底层组件组装独立管线：
//   converter（ST 已配置的 showdown）→ encodeStyleTags → DOMPurify.sanitize → decodeStyleTags
// 完全不触碰全局 chat，无 XSS 风险。

/**
 * 将 Markdown 文本安全渲染为 HTML（独立管线，可渲染任意聊天的消息）。
 * @param {string} markdown 原始 Markdown 文本
 * @returns {string} 已 sanitize 的 HTML（失败时返回空字符串）
 */
export function renderMarkdownCore(markdown) {
  try {
    const converter = _scriptModule?.converter;
    if (converter) {
      // ST 官方 showdown 部分（与 messageFormatting 一致）
      // 引号 → <q>：ST 在 makeHtml 之前把成对引号（"…" “…” «…» 「…」 『…』 ＂…＂）替换为 <q>…</q>，
      // 正则会先跳过 <style> 与代码块。桥接的主题样式 .novel-msg-body q { color: var(--SmartThemeQuoteColor) }
      // 依赖这个 <q> 元素，缺了它引号就吃不到主题色。
      let html = String(markdown ?? "");
      // 保护 HTML 标签属性内的双引号（与 ST 官方 encode_tags=false 分支一致）：
      // 引号转 q 正则会把 <span style="color:red"> 里成对的 " 误判为引用文本并包成 <q>，
      // 导致标签属性被破坏。先把标签内 " 换成 \ufffe 占位，转 q 完成后还原。
      html = html.replace(/<([^>]+)>/g, function (_, contents) {
        return "<" + contents.replace(/"/g, "\ufffe") + ">";
      });
      html = html.replace(
        /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
        function (match, p1, p2, p3, p4, p5, p6) {
          if (p1) {
            // English double quotes
            return `<q>"${p1.slice(1, -1)}"</q>`;
          } else if (p2) {
            // Curly double quotes “ ”
            return `<q>“${p2.slice(1, -1)}”</q>`;
          } else if (p3) {
            // Guillemets « »
            return `<q>«${p3.slice(1, -1)}»</q>`;
          } else if (p4) {
            // Corner brackets 「 」
            return `<q>「${p4.slice(1, -1)}」</q>`;
          } else if (p5) {
            // White corner brackets 『 』
            return `<q>『${p5.slice(1, -1)}』</q>`;
          } else if (p6) {
            // Fullwidth quotes ＂ ＂
            return `<q>＂${p6.slice(1, -1)}＂</q>`;
          } else {
            // Return the original match if no quotes are found
            return match;
          }
        },
      );
      // 还原 HTML 标签属性内的双引号（与 ST 官方一致）
      html = html.replace(/\ufffe/g, '"');
      html = converter.makeHtml(html);
      // 处理代码块换行（与 ST 一致：修复 Firefox <br> 问题）
      html = html.replace(/<code(.*)>[\s\S]*?<\/code>/g, (match) =>
        match.replace(/\n/gm, "\u0000"),
      );
      html = html.replace(/\u0000/g, "\n");
      // sanitize 管线（encode → DOMPurify → decode）
      const encode = _chatsModule?.encodeStyleTags ?? window.encodeStyleTags;
      const decode = _chatsModule?.decodeStyleTags ?? window.decodeStyleTags;
      const purify = window.DOMPurify;
      let cleaned = html;
      if (typeof encode === "function") cleaned = encode(cleaned);
      if (purify) {
        cleaned = purify.sanitize(cleaned, { ADD_TAGS: ["custom-style"] });
      }
      if (typeof decode === "function") cleaned = decode(cleaned);
      return cleaned;
    }
    // 兜底：无 converter 时只转义纯文本
    return String(markdown ?? "")
      .replace(/&/g, "&")
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, "\x26quot;");
  } catch (err) {
    console.warn("[NovelReader] renderMarkdownCore 失败:", err);
    return "";
  }
}

/**
 * 取「选中指定角色」函数（script.js 命名导出）。
 * @returns {Function|null} selectCharacterById(charIdx) => void
 */
export function selectCharacterByIdFunc() {
  return (
    _scriptModule?.selectCharacterById ?? window.selectCharacterById ?? null
  );
}

/**
 * 取 ST 的 API 请求头（含 CSRF，script.js 命名导出）。
 * @returns {object} 请求头对象
 */
export function getRequestHeaders() {
  try {
    const fn = _scriptModule?.getRequestHeaders ?? window.getRequestHeaders;
    return typeof fn === "function" ? fn() : {};
  } catch (err) {
    console.warn("[NovelReader] getRequestHeaders 失败:", err);
    return {};
  }
}
