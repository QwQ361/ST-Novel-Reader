// index.js —— 酒馆小说阅读器 薄入口
// 职责：
//   1) jQuery async 启动
//   2) 依赖组装（deps 依赖注入到各 Core）
//   3) 顶栏按钮注入
//   4) 事件订阅（CHAT_CHANGED / CHARACTER_RENAMED）
//   5) 全屏状态机 UI（书架首页 → 聊天列表 → 目录 → 正文）
//   6) 暴露全局 API（window.NovelReader）
// 业务逻辑一律不放这里，都在 features/ 与 utils/ 中。

import { createBookmarksCore } from "./features/bookmarks/index.js";
import { createBookshelfCore } from "./features/bookshelf/index.js";
import {
  createCfmBridgeCore,
  createCfmFolderPanel,
} from "./features/cfm-bridge/index.js";
import { createProgressCore } from "./features/progress/index.js";
import { createReaderCore } from "./features/reader/index.js";
import { createRegexCore } from "./features/regex/index.js";
import {
  getPastCharacterChatsFunc,
  getPresetManagerFunc,
  getRequestHeaders,
  getStContext,
  loadStCoreModules,
  renderMarkdownCore,
} from "./integrations/sillytavern.js";
import { createThemeTextBridgeCore } from "./integrations/theme-text.js";
import {
  applyCustomIconCore,
  applyTopbarIconFromConfigCore,
  clearCustomIconCore,
  createTopbarIconAdaptorCore,
  detectNeighborIconCore,
  detectThemeIconsCore,
  extractUrlFromCssCore,
  isImageIconBackgroundCore,
  toCssUrlCore,
} from "./integrations/topbar-icon.js";
import { createOverlayDialog, makeDraggable } from "./ui/modal/index.js";
import {
  applyThemeCore,
  resolveOpaqueBg,
  sampleStThemeCore,
} from "./utils/theme.js";

const EXT_NAME = "ST-Novel-Reader";

// 默认字号分设备：移动端（≤900px）14px、PC 端 16px
// 与 style.css 移动端媒体查询 max-width: 900px 保持一致
function getDefaultFontSize() {
  return window.innerWidth <= 900 ? 14 : 16;
}

// 阅读器内置主题：∅（id:""）= 跟随酒馆美化；其余为独立配色主题。
// 每套主题的背景色在 style.css 的 .novel-theme-{id} 中通过 CSS 变量定义，
// 这里只维护 id/显示名/预览色（面板色板用）。
const READER_THEMES = [
  { id: "", name: "跟随酒馆", bg: "", fg: "" },
  { id: "warmpaper", name: "暖纸", bg: "#f5f0e6", fg: "#4a3f35" },
  { id: "midnight", name: "墨夜", bg: "#14161a", fg: "#7fd1c0" },
  { id: "tealink", name: "青简", bg: "#0f1b1d", fg: "#a8e6cf" },
  { id: "rose", name: "蔷薇", bg: "#241a1e", fg: "#f0a6b8" },
  { id: "forest", name: "森语", bg: "#141c15", fg: "#a3d9a5" },
  { id: "ocean", name: "深蓝", bg: "#101826", fg: "#7fb5ff" },
];

// 收藏图标（SVG，描边风格；激活态由 CSS 填充实心）
const BOOKMARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';

// 置顶图标（SVG，描边风格，与收藏一致；激活态由 CSS 高亮）
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

jQuery(async () => {
  console.log("[NovelReader] 启动中…");

  // ---- 1. 加载 ST 核心模块（失败不阻断） ----
  try {
    await loadStCoreModules();
  } catch (err) {
    console.warn("[NovelReader] ST 核心模块加载异常:", err);
  }

  const ctx = getStContext();
  if (!ctx) {
    console.warn("[NovelReader] 无法获取 ST 上下文，插件未激活。");
    return;
  }

  // ---- 2. 依赖组装 ----
  const deps = {
    extName: EXT_NAME,
    getStContext,
    getRequestHeaders,
    getPastCharacterChatsFunc,
    getPresetManagerFunc,
    userName: ctx.userName || "你",
    // 头像 URL（ST 提供，自动带缓存参数；type 固定 "avatar"，file 传 char.avatar）
    getThumbnailUrl: (type, file) => {
      try {
        return ctx.getThumbnailUrl?.(type, file) ?? "";
      } catch (err) {
        console.warn("[NovelReader] getThumbnailUrl 失败:", err);
        return "";
      }
    },
    // Markdown 安全渲染管线（converter → encodeStyleTags → DOMPurify → decodeStyleTags）
    // 可渲染任意聊天的消息，不依赖全局 chat（ST 的 messageFormatting 做不到）
    renderMarkdown: renderMarkdownCore,
    getSettings: () => ctx.extensionSettings || {},
    saveSettings: () => ctx.saveSettingsDebounced?.(),
    // 是否显示 user 回复（设置页开关，默认 true）
    getShowUserReplies: () => getGlobalSettings().showUserReplies,
    // 自动识别标题：返回识别标签（空 = 关闭；非空 = 启用，如 "zj"）
    getChapterTitleTag: () => {
      const g = getGlobalSettings();
      return g.autoChapterTitle ? g.chapterTitleTag || "" : "";
    },
    // 标题过滤文字列表（识别标题的二次清理：剥离章号前缀 + 移除指定文字）
    getChapterTitleFilters: () => {
      const g = getGlobalSettings();
      if (!g.autoChapterTitle) return [];
      return Array.isArray(g.chapterTitleFilters)
        ? g.chapterTitleFilters
            .map((s) => String(s || "").trim())
            .filter(Boolean)
        : [];
    },
    // 是否剥离识别标题开头的章号前缀（如「第一章：」；默认剥离）
    getStripChapterPrefix: () => {
      const g = getGlobalSettings();
      return g.stripChapterPrefix !== false;
    },
  };

  const bookshelf = createBookshelfCore({
    ...deps,
    getCharacters: () => ctx.characters,
  });

  // CFM 数据桥接：检测 CFM 是否安装 + 读取其文件夹树/归属映射（仅同时安装 CFM 的用户可用）
  const cfmBridge = createCfmBridgeCore({
    ...deps,
    getExtensionSettings: () => ctx.extensionSettings || {},
    getAllChars: () => (Array.isArray(ctx.characters) ? ctx.characters : []),
  });

  // 正则过滤：让用户把酒馆正则应用到小说阅读（勾选状态存 extension_settings）
  const regexCore = createRegexCore({
    ...deps,
    getStContext: () => getStContext(),
  });

  const reader = createReaderCore({
    ...deps,
    getChatMessages: (avatar, fileName) =>
      bookshelf.getChatMessages(avatar, fileName),
    // 正则过滤：渲染正文前先应用用户勾选的酒馆正则
    regexFilter: (text, avatar) => regexCore.runRegexOnText(text, { avatar }),
  });

  const progress = createProgressCore({ ...deps });

  // 书签：收藏章节 + 收藏列表（数据存 extension_settings，按 角色+聊天 维度）
  const bookmarks = createBookmarksCore({ ...deps });

  // 主题文本样式桥接：让美化主题的引号/星号特殊效果同样作用于阅读器正文
  const themeTextBridge = createThemeTextBridgeCore({ document });

  // ---- 3. 全局设置（extension_settings 持久化） ----
  function getGlobalSettings() {
    const s = deps.getSettings();
    if (!s[EXT_NAME]) s[EXT_NAME] = {};
    const g = s[EXT_NAME];
    g.chaptersPerPage = Number(g.chaptersPerPage) || 100; // 目录每页 N 章，默认 100
    if (!g.readerSettings) g.readerSettings = {}; // 字号/主题
    const defaultFontSize = getDefaultFontSize();
    if (!g.readerSettings.fontSize) {
      g.readerSettings.fontSize = defaultFontSize;
    } else if (g.readerSettings.fontSize === 18) {
      // 旧版默认 18（未分设备）→ 迁移为新设备默认
      g.readerSettings.fontSize = defaultFontSize;
    }
    if (g.readerSettings.textColor) delete g.readerSettings.textColor; // 旧字段（被主题取代）
    if (g.readerSettings.bgColor) delete g.readerSettings.bgColor; // 旧字段（被主题取代）
    if (!g.readerSettings.themeId) g.readerSettings.themeId = ""; // 阅读器主题（"" = 跟随酒馆）
    // 阅读窗口模式："fullscreen" = 全屏（默认），"floating" = 可拖动/可缩放的悬浮窗
    if (!g.windowMode) g.windowMode = "fullscreen";
    // 悬浮窗上次的大小与位置 {w,h,x,y}（关闭→重开恢复）
    if (g.floatingRect === undefined) g.floatingRect = null;
    // 悬浮窗置顶状态：置顶后点击弹窗外不再自动关闭（仅悬浮窗模式生效）
    if (g.floatingPinned === undefined) g.floatingPinned = false;
    if (!g.customTopbarIcon) g.customTopbarIcon = ""; // 自定义顶栏图标 URL（空 = 自动检测）
    if (g.showUserReplies === undefined) g.showUserReplies = true; // 是否显示 user 回复（默认显示）
    // 打开阅读器时显示哪个页面："last" = 上次关闭的页面（默认），"home" = 首页（书架）
    if (!g.startPage) g.startPage = "last";
    // 自动识别标题：从章节正文提取自定义标签内的文字作为目录标题（默认关闭）
    if (g.autoChapterTitle === undefined) g.autoChapterTitle = false;
    // 识别标签名（不含尖括号；仅在 autoChapterTitle 开启时生效；旧默认值为 "bt"，统一迁移为 "zj"）
    if (!g.chapterTitleTag) g.chapterTitleTag = "zj";
    else if (g.chapterTitleTag === "bt") g.chapterTitleTag = "zj";
    // 标题过滤文字：从识别出的标题中移除指定文字（多行，每行一条）
    if (!Array.isArray(g.chapterTitleFilters)) g.chapterTitleFilters = [];
    // 是否剥离识别标题开头的章号前缀（如「第一章：」；默认开启）
    if (g.stripChapterPrefix === undefined) g.stripChapterPrefix = true;
    return g;
  }

  // ---- 4. UI 引用（全屏弹窗：顶部栏 + 内容区 + 底部栏）----
  let dialogRef = null;
  let topbarEl = null;
  let bodyEl = null;
  let bottombarEl = null;
  let searchInputEl = null;
  let readerScrollEl = null; // 正文滚动容器（.novel-reader-scroll）
  let settingsPanelEl = null; // 界面设置子面板

  // 会话内是否已打开过一次阅读器（纯内存标记，刷新页面后自动归零）。
  // 用于「打开时显示=首页」：该设置只在刷新酒馆后的第一次打开生效，
  // 同一次会话内正常关闭再打开（不刷新）仍恢复上次位置。
  let sessionOpenedOnce = false;

  // CFM 文件夹过滤当前选中值（"__all__" = 全部；仅同时安装 CFM 时生效）
  let charFolderFilter = "__all__";

  // 当前导航状态
  const state = {
    page: "bookshelf", // bookshelf | chats | toc | reader
    currentChar: null, // 当前选中的角色对象
    currentCharIdx: 0, // 当前选中的角色索引
    currentChat: null, // 当前选中的聊天对象
    currentChats: null, // 当前角色的聊天列表（缓存，供筛选）
    currentChapter: 0, // 当前章节索引（1 起）
    tocPage: 0, // 目录分页页码（0 起）
    pendingHighlightOffset: null, // 待定位的消息章内偏移（搜索结果跳转）
  };
  let searchPanelEl = null; // 小说内检索结果面板
  let topbarIconAdaptor = null; // 顶栏图标美化适配器（设置弹窗内改图标后重置轮询签名用）

  let saveTimer = 0;

  /**
   * 打开主界面弹窗（全屏）。
   */
  function openReaderDialog() {
    if (dialogRef) return;

    const g0 = getGlobalSettings();
    const dlg = createOverlayDialog({
      title: "",
      showClose: false,
      floating: g0.windowMode === "floating",
      // 悬浮窗：恢复上次大小/位置；拖动/缩放结束时持久化
      floatingRect: g0.floatingRect,
      onFloatingRect: (rect) => {
        const g = getGlobalSettings();
        g.floatingRect = rect;
        deps.saveSettings();
      },
    });
    dialogRef = dlg;
    // 悬浮窗置顶：置顶时点击遮罩不再自动关闭（仅悬浮窗模式有遮罩点击关闭）
    if (g0.windowMode === "floating" && g0.floatingPinned) {
      dlg.setPinned(true);
    }
    dlg.onClose = () => {
      saveLastView(); // 记住关闭前的页面（角色/聊天/章节）
      charFolderPanel?.close(); // 关闭可能打开的角色文件夹过滤面板（独立挂 body）
      reader.abort();
      dialogRef = null;
    };

    // 应用阅读器样式（主题：∅跟随酒馆采样 / 内置主题 class + 桥接开关；字号）
    // applyReaderStyles 内部按 readerSettings.themeId 决定分支：
    //   ∅ → 采样酒馆主题色写内联变量 + 开启桥接（引号/星号跟随美化）
    //   内置 → dialog/overlay 加 novel-theme-{id} class + 关闭桥接（引号/星号用主题配色）
    try {
      applyReaderStyles();
      // 美化主题样式可能延迟加载：∅ 模式下稍后重采样一次，弹窗仍打开才应用
      // （内置主题不受影响：class 自带变量，内联采样只会覆盖它，故跳过）
      setTimeout(() => {
        if (dialogRef !== dlg) return;
        const g2 = getGlobalSettings();
        if (!g2.readerSettings?.themeId) {
          // 与 applyReaderStyles 的 ∅ 分支保持一致：采样 + 悬浮窗不透明兜底
          const sampled = sampleStThemeCore();
          applyThemeCore(dlg.dialog, sampled);
          if (dlg.dialog.classList.contains("novel-dialog-floating")) {
            const sampledBg = sampled?.bg;
            if (!sampledBg || /^rgba\(|^hsla\(/.test(sampledBg)) {
              dlg.dialog.style.background = resolveOpaqueBg(sampledBg);
            }
          }
          themeTextBridge.refresh();
        }
      }, 300);
    } catch (err) {
      console.warn("[NovelReader] 主题应用失败:", err);
    }

    const content = dlg.content;
    content.className = "novel-shell";

    // ---- 顶部栏（全局设置，常显） ----
    topbarEl = document.createElement("div");
    topbarEl.className = "novel-topbar";
    topbarEl.innerHTML = `
      <div class="novel-topbar-back">
        <button class="novel-icon-btn" data-action="back" title="返回">←</button>
      </div>
      <div class="novel-topbar-title">酒馆小说阅读器</div>
      <div class="novel-topbar-search">
        <input type="text" placeholder="搜索角色 / 聊天…" />
        ${
          g0.windowMode === "floating"
            ? ""
            : '<button type="button" class="novel-cfm-folder-btn novel-cfm-char-filter" title="文件夹过滤" style="display:none"><i class="fa-solid fa-folder-tree"></i></button>'
        }
      </div>
      <div class="novel-topbar-settings">
        ${
          g0.windowMode === "floating"
            ? `
        <button type="button" class="novel-cfm-folder-btn novel-cfm-char-filter" title="文件夹过滤" style="display:none"><i class="fa-solid fa-folder-tree"></i></button>
        <button class="novel-icon-btn novel-pin-btn" data-action="pin" title="置顶：点击弹窗外不自动关闭">${PIN_SVG}</button>`
            : ""
        }
        <button class="novel-icon-btn" data-action="settings" title="全局设置">⚙</button>
        <button class="novel-icon-btn novel-icon-close" data-action="close" title="关闭">×</button>
      </div>`;
    content.appendChild(topbarEl);

    // 置顶按钮：初始状态高亮（读取持久化置顶状态）
    if (g0.windowMode === "floating" && g0.floatingPinned) {
      topbarEl
        .querySelector('[data-action="pin"]')
        ?.classList.add("novel-pin-active");
    }

    // 悬浮窗模式：顶部栏作为拖动柄（无 header；拖动时排除按钮/输入框等交互元素）
    if (g0.windowMode === "floating") {
      topbarEl.classList.add("novel-dialog-float-drag");
      makeDraggable(dlg.dialog, topbarEl);
    }

    // ---- 内容区（状态机切换） ----
    bodyEl = document.createElement("div");
    bodyEl.className = "novel-body";
    content.appendChild(bodyEl);

    // ---- 底部栏（小说设置，仅正文页显示） ----
    bottombarEl = document.createElement("div");
    bottombarEl.className = "novel-bottombar";
    bottombarEl.innerHTML = `
      <button class="novel-btn" data-action="home" title="回到书架">首页</button>
      <button class="novel-btn" data-action="toc">目录</button>
      <button class="novel-btn" data-action="prev">上一章</button>
      <button class="novel-btn" data-action="next">下一章</button>
      <button class="novel-btn" data-action="bookmark" title="收藏当前章节">书签</button>
      <button class="novel-btn" data-action="reader-settings">界面</button>`;
    content.appendChild(bottombarEl);

    // 搜索框引用
    searchInputEl = topbarEl.querySelector(".novel-topbar-search input");

    // ---- 事件绑定 ----
    bindTopbarEvents();
    bindBottombarEvents();

    // ---- CFM 文件夹过滤（仅同时安装 CFM 时启用）----
    initCfmCharFilter();

    // 初始渲染：恢复上次关闭前的页面（无记录则书架首页）
    restoreLastView();
  }

  /**
   * 初始化顶栏「角色文件夹过滤」按钮 + 浮动面板。
   * 仅当 CFM 已安装时显示；每次打开阅读器时重读 CFM 数据（实时反映）。
   */
  let charFolderPanel = null;

  function initCfmCharFilter() {
    const btn = topbarEl.querySelector(".novel-cfm-char-filter");
    if (!btn) return;
    if (!cfmBridge.isCfmInstalled()) {
      charFolderFilter = "__all__";
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    // 每次打开阅读器重建面板（重读 CFM 数据）
    charFolderPanel?.close();
    charFolderPanel = createCfmFolderPanel({
      anchorEl: btn,
      type: "chars",
      getBridge: () => cfmBridge,
      currentFilter: charFolderFilter,
      onSelect: (folderId) => {
        charFolderFilter = folderId;
        if (state.page === "bookshelf") {
          renderBookshelfGrid(searchInputEl.value);
        }
      },
    });
    btn.onclick = (e) => {
      e.stopPropagation();
      charFolderPanel.toggle();
    };
  }

  /** 关闭主界面弹窗 */
  function closeReaderDialog() {
    dialogRef?.close();
  }

  // ============ 关闭位置记忆（重新打开恢复原页面） ============

  /** 保存当前浏览位置到 extension_settings */
  function saveLastView() {
    const g = getGlobalSettings();
    g.lastView = {
      page: state.page,
      charIdx: state.currentCharIdx ?? null,
      charAvatar: state.currentChar?.avatar ?? null,
      charName: state.currentChar?.name ?? null,
      chatFileName: state.currentChat?.file_name ?? null,
      chapter: state.currentChapter || null,
      tocPage: state.tocPage ?? 0,
    };
    deps.saveSettings();
  }

  /** 打开弹窗后按上次记录恢复页面（角色列表变化时按 avatar/name 兜底） */
  async function restoreLastView() {
    const g = getGlobalSettings();
    // 设置项「打开时显示」= 首页：仅在会话内第一次打开时生效
    // （刷新酒馆后首次打开 → 回书架；之后关闭再打开 → 恢复上次位置）
    if (g.startPage === "home" && !sessionOpenedOnce) {
      sessionOpenedOnce = true;
      showBookshelf();
      return;
    }
    // 会话内已打开过 → 之后一律恢复上次位置（该标记同时防止
    // startPage="last" 时重复触发；置 true 仅用于记录，无副作用）
    sessionOpenedOnce = true;
    const last = g.lastView;
    if (!last || !last.page) {
      showBookshelf();
      return;
    }

    // 上次在书架页关闭 → 直接显示书架（不残留 currentChar 走目录/正文分支）
    if (last.page === "bookshelf") {
      showBookshelf();
      return;
    }

    // 恢复失败（聊天被删 / 加载异常等）一律降级回书架，避免空白页
    try {
      await restoreLastViewInner(last);
    } catch (err) {
      console.warn("[NovelReader] 恢复上次视图失败，降级回书架:", err);
      showBookshelf();
    }
  }

  /** restoreLastView 的实际恢复逻辑（异常由外层兜底） */
  async function restoreLastViewInner(last) {
    const g = getGlobalSettings();
    const chars = bookshelf.getCharacters();
    // 优先按 avatar 匹配（角色顺序可能变化），再按索引、最后按名称
    let char = null;
    let charIdx = -1;
    if (last.charAvatar) {
      charIdx = chars.findIndex((c) => c.avatar === last.charAvatar);
      if (charIdx >= 0) char = chars[charIdx];
    }
    if (!char && last.charIdx != null && chars[last.charIdx]) {
      char = chars[last.charIdx];
      charIdx = last.charIdx;
    }
    if (!char && last.charName) {
      charIdx = chars.findIndex((c) => c.name === last.charName);
      if (charIdx >= 0) char = chars[charIdx];
    }
    if (!char) {
      showBookshelf();
      return;
    }

    // 聊天列表页：直接打开该角色聊天列表
    if (last.page === "chats") {
      await openChatList(charIdx, char);
      return;
    }

    // 目录 / 正文页：需要聊天对象（file_name 匹配）
    // 注意：此处不能检查 state.currentChar !== char——
    // 首次打开（页面刷新后）state.currentChar 恒为 null，openToc 内部才赋值，
    // 若检查会导致恢复 reader/toc 页面时静默 return → 空白弹窗。
    // 改为检查弹窗是否仍打开（等待期间用户可能已关闭），openToc 自带并发保护。
    const chats = await bookshelf.getCharChats(charIdx, char.avatar);
    if (!dialogRef) return; // 等待期间弹窗已关闭
    const chat = (chats || []).find((c) => c.file_name === last.chatFileName);
    if (!chat) {
      // 聊天已被删除 → 显示该角色的聊天列表
      state.currentChats = chats || [];
      setPage("chats");
      topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
        char.name || "未命名",
      );
      renderChatListGrid("");
      return;
    }

    await openToc(char, chat);
    state.tocPage = last.tocPage ?? 0;
    if (last.page === "reader" && last.chapter) {
      // 正文页：直接进入上次章节（滚动位置由 progress 自动恢复）
      await openChapter(last.chapter);
    } else if ((last.tocPage ?? 0) > 0) {
      // 目录页：重渲染当前页以应用记忆的页码
      const container = bodyEl.querySelector(".novel-page");
      if (container) renderTocPage(container);
    }
  }

  // ============ 页面状态机 ============

  /** 设置当前页（清空内容区 + 更新顶栏返回按钮 + 搜索框占位/模式） */
  function setPage(page) {
    state.page = page;
    bodyEl.innerHTML = "";
    const backBtn = topbarEl.querySelector('[data-action="back"]');
    const backActions = {
      bookshelf: "close", // 书架页：返回按钮 = 关闭阅读器（退出到 ST 主界面）
      chats: "bookshelf",
      toc: "chats",
      reader: "toc",
    };
    backBtn.dataset.backTarget = backActions[page] || "";
    backBtn.style.display = backActions[page] ? "" : "none";
    // 返回按钮提示：书架页为「退出」，其余页为「返回」
    backBtn.title = page === "bookshelf" ? "退出" : "返回";
    // 正文页：显示底部栏；其余页隐藏
    bottombarEl.style.display = page === "reader" ? "" : "none";
    // 非正文页恢复顶栏显示（正文页可能被点击隐藏）
    topbarEl.style.display = "";
    bodyEl.classList.remove("novel-chrome-hidden");
    // 搜索框模式：书架/聊天列表 = 列表筛选；目录/正文 = 小说内检索
    searchInputEl.placeholder =
      page === "toc" || page === "reader"
        ? "搜索本章小说内容…"
        : "搜索角色 / 聊天…";
    searchInputEl.dataset.mode =
      page === "toc" || page === "reader" ? "chat" : "list";
    if (page === "toc" || page === "reader") {
      searchInputEl.value = "";
    }
    // CFM 角色文件夹过滤按钮：仅书架页显示（其余页隐藏，并关闭可能打开的面板）
    const cfmCharBtn = topbarEl.querySelector(".novel-cfm-char-filter");
    if (cfmCharBtn) {
      cfmCharBtn.style.display =
        page === "bookshelf" && cfmBridge.isCfmInstalled() ? "" : "none";
    }
    if (page !== "bookshelf") charFolderPanel?.close();
    // 关闭可能打开的设置子面板 + 检索结果面板
    closeSettingsPanel();
    closeSearchPanel();
  }

  /** 返回上一页 / 书架页则退出阅读器 */
  function goBack() {
    const backActions = {
      bookshelf: closeReaderDialog, // 书架页：关闭弹窗（退出到 ST 主界面）
      chats: showBookshelf,
      toc: showChats,
      reader: showToc,
    };
    const fn = backActions[state.page];
    if (fn) fn();
  }

  /** 从目录返回聊天列表（用 state.currentChar 重建） */
  async function showChats() {
    if (!state.currentChar) {
      showBookshelf();
      return;
    }
    const idx = state.currentCharIdx ?? 0;
    await openChatList(idx, state.currentChar);
  }

  // ============ 书架首页（角色卡片网格） ============

  /** 底部栏「首页」：回到书架页（清空当前角色/聊天选择） */
  function goHome() {
    state.currentChar = null;
    state.currentCharIdx = 0;
    state.currentChat = null;
    state.currentChats = null;
    state.currentChapter = 0;
    showBookshelf();
  }

  function showBookshelf() {
    setPage("bookshelf");
    searchInputEl.value = "";
    topbarEl.querySelector(".novel-topbar-title").textContent = "书架";
    renderBookshelfGrid("");
  }

  /** 渲染书架角色卡片网格（支持按名称实时筛选） */
  function renderBookshelfGrid(query) {
    const q = (query || "").toLowerCase().trim();
    bodyEl.querySelector(".novel-page")?.remove();

    const page = document.createElement("div");
    page.className = "novel-page";
    const chars = bookshelf.getCharacters();
    if (!chars.length) {
      page.innerHTML = `<div class="novel-empty">暂无角色</div>`;
      bodyEl.appendChild(page);
      return;
    }

    let filtered = q
      ? chars.filter((c) =>
          String(c.name || "")
            .toLowerCase()
            .includes(q),
        )
      : chars;

    // CFM 文件夹过滤：选中非「全部」时，仅保留属于该文件夹（含子文件夹）的角色
    if (charFolderFilter !== "__all__" && cfmBridge.isCfmInstalled()) {
      const allowed = cfmBridge.getItemsInFolder("chars", charFolderFilter);
      if (allowed) filtered = filtered.filter((c) => allowed.has(c.avatar));
    }

    if (!filtered.length) {
      page.innerHTML = `<div class="novel-empty">无匹配角色</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "novel-grid";
    // 预建 avatar 索引 Map：避免 filtered.forEach 内逐项 chars.indexOf（O(n²)）
    const charIdxMap = new Map();
    for (let i = 0; i < chars.length; i += 1) charIdxMap.set(chars[i], i);
    filtered.forEach((c) => {
      const origIdx = charIdxMap.get(c) ?? 0;
      const card = document.createElement("div");
      card.className = "novel-card novel-char-card";
      card.dataset.charIdx = String(origIdx);
      const version = c.char_version ? String(c.char_version) : "";
      // 头像 URL：走 ST getThumbnailUrl，失败/缺失时 onerror 兜底默认图
      const thumbUrl = deps.getThumbnailUrl?.("avatar", c.avatar) || "";
      card.innerHTML = `
        <div class="novel-card-avatar">
          <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(c.name || "")}" loading="lazy" onerror="this.onerror=null;this.src='/img/ai4.png'">
        </div>
        <div class="novel-card-title">${escapeHtml(c.name || "未命名")}</div>
        ${version ? `<div class="novel-card-meta">${escapeHtml(version)}</div>` : ""}`;
      card.addEventListener("click", () => openChatList(origIdx, c));
      grid.appendChild(card);
    });

    page.appendChild(grid);
    bodyEl.appendChild(page);
  }

  // ============ 聊天列表页 ============

  async function openChatList(charIdx, char) {
    state.currentChar = char;
    state.currentCharIdx = charIdx;
    setPage("chats");
    state.currentChats = null;
    topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
      char.name || "未命名",
    );

    const page = document.createElement("div");
    page.className = "novel-page";
    page.innerHTML = `<div class="novel-loading">加载聊天列表…</div>`;
    bodyEl.appendChild(page);

    const chats = await bookshelf.getCharChats(charIdx, char.avatar);
    if (state.page !== "chats" || state.currentChar !== char) return; // 已切换

    state.currentChats = chats;
    renderChatListGrid(searchInputEl.value);
  }

  /** 渲染聊天卡片网格（支持按文件名/预览实时筛选） */
  function renderChatListGrid(query) {
    const q = (query || "").toLowerCase().trim();
    bodyEl.querySelector(".novel-page")?.remove();

    const page = document.createElement("div");
    page.className = "novel-page";
    const chats = state.currentChats || [];
    if (!chats.length) {
      page.innerHTML = `<div class="novel-empty">暂无聊天记录</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const filtered = q
      ? chats.filter((chat) => {
          const fileName = String(chat.file_name || "").toLowerCase();
          const preview = String(chat.last_mes || "").toLowerCase();
          return fileName.includes(q) || preview.includes(q);
        })
      : chats;

    if (!filtered.length) {
      page.innerHTML = `<div class="novel-empty">无匹配聊天</div>`;
      bodyEl.appendChild(page);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "novel-grid";
    filtered.forEach((chat) => {
      const fileName = chat.file_name || "";
      const card = document.createElement("div");
      card.className = "novel-card novel-chat-card";
      // meta 行只拼接非空字段段，段间用「 · 」连接，避免出现悬空点
      const metaParts = [chat.chat_items ?? chat.message_count ?? ""]
        .map((v) => String(v).trim())
        .filter(Boolean);
      // 预览行：若最后一条消息是纯 ISO 时间戳（导入日志常见，如 2026-09-12T07:30:09.524Z），
      // 无阅读价值，跳过不显示
      const preview = String(chat.last_mes || "").trim();
      const isIsoStamp =
        /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?$/.test(preview);
      card.innerHTML = `
        <div class="novel-card-title">${escapeHtml(String(fileName).replace(/\.jsonl$/i, ""))}</div>
        ${preview && !isIsoStamp ? `<div class="novel-card-preview">${escapeHtml(preview)}</div>` : ""}
        ${metaParts.length ? `<div class="novel-card-meta">${metaParts.map((v) => escapeHtml(v)).join(" · ")}</div>` : ""}`;
      card.addEventListener("click", () =>
        openToc(state.currentChar, { file_name: fileName }),
      );
      grid.appendChild(card);
    });
    page.appendChild(grid);
    bodyEl.appendChild(page);
  }

  // ============ 目录页（分页章节列表） ============

  async function openToc(char, chat) {
    state.currentChar = char;
    state.currentChat = chat;
    state.tocPage = 0;
    setPage("toc");
    topbarEl.querySelector(".novel-topbar-title").textContent = escapeHtml(
      String(chat.file_name || "").replace(/\.jsonl$/i, ""),
    );

    const page = document.createElement("div");
    page.className = "novel-page";
    page.innerHTML = `<div class="novel-loading">加载章节…</div>`;
    bodyEl.appendChild(page);

    const info = await reader.loadChat({
      avatar: char.avatar,
      fileName: chat.file_name,
    });
    if (state.page !== "toc" || state.currentChat !== chat) return; // 已切换

    if (!info || !info.chapters.length) {
      page.innerHTML = `<div class="novel-empty">该聊天暂无内容</div>`;
      return;
    }

    renderTocPage(page);
  }

  /** 渲染目录分页（每页 N 章） */
  function renderTocPage(container) {
    const g = getGlobalSettings();
    const perPage = g.chaptersPerPage;
    const info = reader.getChatInfo();
    if (!info) return;
    const chapters = info.chapters;
    const total = chapters.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = state.tocPage * perPage;
    const pageChapters = chapters.slice(start, start + perPage);

    container.innerHTML = "";
    const toc = document.createElement("div");
    toc.className = "novel-toc";
    toc.innerHTML = `
      <div class="novel-toc-head">
        <h2>目录</h2>
        <span class="novel-toc-sub">${escapeHtml(String(total))} 章</span>
        <button class="novel-toc-bookmark-btn" title="查看收藏章节" data-action="bookmarks">${BOOKMARK_SVG}<span>收藏</span></button>
      </div>
      <div class="novel-toc-list"></div>`;

    // 目录头最右侧书签按钮：打开当前聊天的收藏列表
    toc
      .querySelector('[data-action="bookmarks"]')
      .addEventListener("click", (e) => {
        e.stopPropagation();
        openBookmarksDialog();
      });

    const list = toc.querySelector(".novel-toc-list");
    pageChapters.forEach((ch) => {
      const item = document.createElement("div");
      item.className = "novel-toc-item";
      // 自动识别标题开启且本章标题来自标签时，在「第N章」后附加副标题
      const tagTitle = ch.titleSource === "tag" ? ch.title : "";
      item.innerHTML = `
        <span class="novel-toc-item-title">${escapeHtml("第" + String(ch.index) + "章")}</span>
        ${
          tagTitle
            ? `<span class="novel-toc-item-sub">${escapeHtml(String(tagTitle))}</span>`
            : ""
        }`;
      item.addEventListener("click", () => openChapter(ch.index));
      list.appendChild(item);
    });

    // 分页控件
    if (totalPages > 1) {
      const pager = document.createElement("div");
      pager.className = "novel-pager";
      const prevBtn = document.createElement("button");
      prevBtn.className = "novel-icon-btn";
      prevBtn.textContent = "←";
      prevBtn.disabled = state.tocPage <= 0;
      prevBtn.addEventListener("click", () => {
        state.tocPage -= 1;
        renderTocPage(container);
      });
      const infoEl = document.createElement("span");
      infoEl.className = "novel-pager-info";
      infoEl.textContent = `${state.tocPage + 1} / ${totalPages}`;
      const nextBtn = document.createElement("button");
      nextBtn.className = "novel-icon-btn";
      nextBtn.textContent = "→";
      nextBtn.disabled = state.tocPage >= totalPages - 1;
      nextBtn.addEventListener("click", () => {
        state.tocPage += 1;
        renderTocPage(container);
      });
      pager.appendChild(prevBtn);
      pager.appendChild(infoEl);
      pager.appendChild(nextBtn);
      toc.appendChild(pager);
    }

    container.appendChild(toc);
  }

  // ============ 正文阅读页（按章渲染） ============

  /**
   * 打开章节并可定位到指定消息（搜索结果跳转）。
   * @param {number} chapterIndex 章节号（从 1 开始）
   * @param {number} [msgOffset] 章内消息偏移（存在则滚动定位并高亮）
   */
  async function openChapterAtMessage(chapterIndex, msgOffset) {
    state.currentChapter = chapterIndex;
    setPage("reader");
    if (msgOffset != null) state.pendingHighlightOffset = msgOffset;

    const page = document.createElement("div");
    page.className = "novel-reader-page";
    const scroll = document.createElement("div");
    scroll.className = "novel-reader-scroll";
    readerScrollEl = scroll;
    page.appendChild(scroll);
    bodyEl.appendChild(page);

    // 滚动保存进度（防抖；闭包捕获本章号，避免切章后旧滚动保存错章节）
    scroll.addEventListener("scroll", () => {
      if (!state.currentChar || !state.currentChat) return;
      clearTimeout(saveTimer);
      const chapter = chapterIndex;
      const charAvatar = state.currentChar.avatar;
      const chatFileName = state.currentChat.file_name;
      saveTimer = setTimeout(() => {
        progress.save(charAvatar, chatFileName, {
          chapter,
          scrollTop: scroll.scrollTop,
          updatedAt: Date.now(),
        });
      }, 400);
    });

    // 点击正文（非交互元素）切换顶/底栏显隐（悬浮窗模式禁用：顶栏即拖动柄，不可隐藏）
    scroll.addEventListener("click", (e) => {
      if (getGlobalSettings().windowMode === "floating") {
        return;
      }
      if (
        e.target.closest(".novel-reader-inner") &&
        !e.target.closest("a,img,button,input,.novel-msg-name")
      ) {
        bodyEl.classList.toggle("novel-chrome-hidden");
      }
    });

    await reader.renderChapter(scroll, chapterIndex, {
      highlightOffset: msgOffset ?? null,
      onRendered: () => {
        applyReaderStyles();
        const saved = progress.load(
          state.currentChar.avatar,
          state.currentChat.file_name,
        );
        if (
          state.pendingHighlightOffset == null &&
          saved &&
          saved.chapter === chapterIndex &&
          saved.scrollTop &&
          scroll.scrollTop === 0
        ) {
          requestAnimationFrame(() => {
            scroll.scrollTop = saved.scrollTop;
          });
        }
        state.pendingHighlightOffset = null;
      },
    });

    updateBottomButtons();
  }

  async function openChapter(chapterIndex) {
    state.currentChapter = chapterIndex;
    setPage("reader");

    const page = document.createElement("div");
    page.className = "novel-reader-page";

    const scroll = document.createElement("div");
    scroll.className = "novel-reader-scroll";
    readerScrollEl = scroll;
    page.appendChild(scroll);
    bodyEl.appendChild(page);

    // 滚动保存进度（防抖；闭包捕获本章号，避免切章后旧滚动保存错章节）
    scroll.addEventListener("scroll", () => {
      if (!state.currentChar || !state.currentChat) return;
      clearTimeout(saveTimer);
      const chapter = chapterIndex;
      const charAvatar = state.currentChar.avatar;
      const chatFileName = state.currentChat.file_name;
      saveTimer = setTimeout(() => {
        progress.save(charAvatar, chatFileName, {
          chapter,
          scrollTop: scroll.scrollTop,
          updatedAt: Date.now(),
        });
      }, 400);
    });

    // 点击正文（非交互元素）切换顶/底栏显隐（悬浮窗模式禁用：顶栏即拖动柄，不可隐藏）
    scroll.addEventListener("click", (e) => {
      if (getGlobalSettings().windowMode === "floating") {
        return;
      }
      if (
        e.target.closest(".novel-reader-inner") &&
        !e.target.closest("a,img,button,input,.novel-msg-name")
      ) {
        bodyEl.classList.toggle("novel-chrome-hidden");
      }
    });

    await reader.renderChapter(scroll, chapterIndex, {
      onRendered: () => {
        // 应用用户阅读器界面样式（字号/文字色/背景色）
        applyReaderStyles();
        // 恢复进度：若从目录点击则滚动到顶部（已由 renderChapter 完成）
        const saved = progress.load(
          state.currentChar.avatar,
          state.currentChat.file_name,
        );
        if (
          saved &&
          saved.chapter === chapterIndex &&
          saved.scrollTop &&
          scroll.scrollTop === 0
        ) {
          requestAnimationFrame(() => {
            scroll.scrollTop = saved.scrollTop;
          });
        }
      },
    });

    updateBottomButtons();
  }

  /** 更新底部栏按钮可用态 */
  function updateBottomButtons() {
    if (!bottombarEl) return;
    const info = reader.getChatInfo();
    const total = info?.totalChapters || 0;
    const cur = state.currentChapter;
    const prev = bottombarEl.querySelector('[data-action="prev"]');
    const next = bottombarEl.querySelector('[data-action="next"]');
    if (prev) prev.disabled = cur <= 1;
    if (next) next.disabled = cur >= total;
    // 书签按钮：当前章节已收藏则高亮（标实心），未收藏为描边
    const bmBtn = bottombarEl.querySelector('[data-action="bookmark"]');
    if (bmBtn) {
      const hasBm =
        state.currentChar &&
        state.currentChat &&
        bookmarks.has(
          state.currentChar.avatar,
          state.currentChat.file_name,
          cur,
        );
      bmBtn.classList.toggle("novel-bookmark-active", !!hasBm);
      bmBtn.title = hasBm ? "取消收藏当前章节" : "收藏当前章节";
    }
  }

  // ============ 书签（收藏章节） ============

  /** 底部栏「书签」：收藏 / 取消收藏当前章节 */
  function toggleBookmark() {
    if (!state.currentChar || !state.currentChat || !state.currentChapter) {
      return;
    }
    const avatar = state.currentChar.avatar;
    const fileName = state.currentChat.file_name;
    const chapter = state.currentChapter;

    if (bookmarks.has(avatar, fileName, chapter)) {
      bookmarks.remove(avatar, fileName, chapter);
    } else {
      const ch = reader.getChapter(chapter);
      bookmarks.add(avatar, fileName, {
        chapter,
        title: ch?.title || "",
        size: ch?.messages?.length || 0,
      });
    }
    updateBottomButtons();
  }

  /**
   * 打开收藏列表弹窗（当前聊天全部书签，按章节大小降序）。
   * 点击条目 → 跳转到对应章节；每条右侧删除按钮 → 删除书签。
   */
  function openBookmarksDialog() {
    if (!state.currentChar || !state.currentChat) return;
    const avatar = state.currentChar.avatar;
    const fileName = state.currentChat.file_name;

    const dlg = createOverlayDialog({
      title: "收藏章节",
      compact: true,
    });
    const content = dlg.content;

    /** 渲染收藏列表到弹窗内容（删除后调用以刷新） */
    function renderItems() {
      const items = bookmarks.list(avatar, fileName);
      content.innerHTML = "";
      const title = content
        .closest(".novel-dialog")
        ?.querySelector(".novel-dialog-title");
      if (title) title.textContent = `收藏章节（${items.length}）`;

      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "novel-empty";
        empty.textContent = "暂无收藏章节";
        content.appendChild(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "novel-bookmark-list";
      items.forEach((bm) => {
        const item = document.createElement("div");
        item.className = "novel-bookmark-item";
        item.innerHTML = `
          <div class="novel-bookmark-info">
            <div class="novel-bookmark-title">${escapeHtml("第" + String(bm.chapter) + "章")}</div>
            <div class="novel-bookmark-meta">${escapeHtml(String(bm.size))} 条消息</div>
          </div>
          <button class="novel-bookmark-del" title="删除书签">×</button>`;
        // 点击条目 → 跳转到该章节
        item.addEventListener("click", () => {
          dlg.close();
          openChapter(bm.chapter);
        });
        // 删除按钮：阻止冒泡（不触发跳转），删除后刷新列表
        const delBtn = item.querySelector(".novel-bookmark-del");
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          bookmarks.remove(avatar, fileName, bm.chapter);
          updateBottomButtons();
          renderItems();
        });
        list.appendChild(item);
      });
      content.appendChild(list);
    }

    renderItems();
  }

  /** 上一章 / 下一章 */
  async function goChapter(delta) {
    const nextChapter = state.currentChapter + delta;
    const info = reader.getChatInfo();
    if (!info) return;
    if (nextChapter < 1 || nextChapter > info.totalChapters) return;
    await openChapter(nextChapter);
  }

  // ============ 顶部栏事件 ============

  function bindTopbarEvents() {
    // 返回按钮
    topbarEl
      .querySelector('[data-action="back"]')
      .addEventListener("click", goBack);
    // 全局设置按钮（每页 N 章）
    topbarEl
      .querySelector('[data-action="settings"]')
      .addEventListener("click", () => {
        openGlobalSettings();
      });
    // 置顶按钮（仅悬浮窗模式存在）：置顶后点击弹窗外不再自动关闭
    topbarEl
      .querySelector('[data-action="pin"]')
      ?.addEventListener("click", () => {
        const g = getGlobalSettings();
        const pinned = !g.floatingPinned;
        g.floatingPinned = pinned;
        deps.saveSettings();
        dialogRef?.setPinned(pinned);
        topbarEl
          .querySelector('[data-action="pin"]')
          ?.classList.toggle("novel-pin-active", pinned);
      });
    // 关闭按钮（×）：关闭阅读器，下次打开恢复原页面
    topbarEl
      .querySelector('[data-action="close"]')
      .addEventListener("click", closeReaderDialog);
    // 搜索框：书架/聊天列表 = 实时筛选；目录/正文 = 小说内检索
    // 小说内检索是全聊天遍历（所有章节 × 所有消息 × toLowerCase），
    // 每次按键即时执行会明显卡顿，加 250ms 防抖合并连续输入。
    let chatSearchTimer = 0;
    searchInputEl.addEventListener("input", () => {
      const q = searchInputEl.value.trim().toLowerCase();
      if (state.page === "bookshelf") {
        renderBookshelfGrid(q);
      } else if (state.page === "chats") {
        renderChatListGrid(q);
      } else if (state.page === "toc" || state.page === "reader") {
        clearTimeout(chatSearchTimer);
        chatSearchTimer = setTimeout(() => runInChatSearch(q), 250);
      }
    });
    // Esc 清空搜索并恢复
    searchInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        clearTimeout(chatSearchTimer); // 取消挂起的防抖搜索
        searchInputEl.value = "";
        if (state.page === "bookshelf") renderBookshelfGrid("");
        else if (state.page === "chats") renderChatListGrid("");
        else if (state.page === "toc" || state.page === "reader") {
          closeSearchPanel();
        }
      }
    });
  }

  /** 小说内检索：目录页/正文页输入关键词 → 弹出结果面板（章节 + 说话人 + 片段） */
  function runInChatSearch(q) {
    if (!q) {
      closeSearchPanel();
      return;
    }
    const results = reader.searchMessages(q);
    const panel = searchPanelEl || createSearchPanel();
    const listEl = panel.querySelector(".novel-search-list");
    listEl.innerHTML = "";

    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "novel-search-empty";
      empty.textContent = "无匹配内容";
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    results.forEach((r) => {
      const item = document.createElement("div");
      item.className = "novel-search-item";
      item.innerHTML = `
        <div class="novel-search-item-head">
          <span class="novel-search-item-ch">${escapeHtml("第" + String(r.chapterIndex) + "章")}</span>
          <span class="novel-search-item-name">${escapeHtml(String(r.name))}</span>
        </div>
        <div class="novel-search-item-snippet">${escapeHtml(String(r.snippet))}</div>`;
      item.addEventListener("click", () => {
        closeSearchPanel();
        openChapterAtMessage(r.chapterIndex, r.msgOffset);
      });
      frag.appendChild(item);
    });
    listEl.appendChild(frag);
  }

  /** 创建检索结果面板（浮在 body 上方） */
  function createSearchPanel() {
    const panel = document.createElement("div");
    panel.className = "novel-search-panel";
    panel.innerHTML = `<div class="novel-search-list"></div>`;
    bodyEl.appendChild(panel);
    searchPanelEl = panel;
    return panel;
  }

  /** 关闭检索结果面板 */
  function closeSearchPanel() {
    searchPanelEl?.remove();
    searchPanelEl = null;
  }

  /** 全局设置弹窗：每页 N 章（紧凑弹窗） */
  function openGlobalSettings() {
    const g = getGlobalSettings();
    const dlg = createOverlayDialog({
      title: "阅读器选项",
      compact: true,
    });
    const content = dlg.content;

    // ---- 检测美化主题图标（供下拉选择 / 状态提示） ----
    let themeIcons = { icons: {}, uniqueUrls: [] };
    try {
      themeIcons = detectThemeIconsCore({
        document,
        window,
        isImageIconBackground: isImageIconBackgroundCore,
      });
    } catch (err) {
      console.warn("[NovelReader] 检测美化主题图标失败:", err);
    }
    const hasTheme = themeIcons.uniqueUrls.length > 0;
    const savedIconUrl = g.customTopbarIcon || "";

    // 下拉项 HTML（用纯 URL 预览背景图）
    const dropdownItemsHtml = themeIcons.uniqueUrls
      .map((cssUrl, idx) => {
        const pureUrl = extractUrlFromCssCore(cssUrl);
        const selected =
          savedIconUrl && cssUrl.includes(savedIconUrl)
            ? " novel-icon-selected"
            : "";
        return `<div class="novel-icon-dropdown-item${selected}" data-url="${escapeHtml(
          pureUrl,
        )}" title="${escapeHtml(pureUrl)}">
          <span class="novel-icon-preview" style="background-image: url('${escapeHtml(
            pureUrl,
          )}')"></span>
          <span class="novel-icon-name">${escapeHtml(
            "主题图标" + " " + (idx + 1),
          )}</span>
        </div>`;
      })
      .join("");

    content.innerHTML = `
      <div class="novel-settings-row">
        <div class="novel-settings-label">目录每页章数</div>
        <input type="range" min="10" max="500" step="10" value="${Number(g.chaptersPerPage) || 100}" />
        <div class="novel-settings-value"></div>
      </div>
      <div class="novel-settings-row">
        <div class="novel-settings-hint">用于目录页的分页显示，修改后立即生效。</div>
      </div>

      <div class="novel-settings-row">
        <div class="novel-settings-label">阅读窗口模式</div>
        <select class="novel-window-mode-select">
          <option value="fullscreen" ${
            g.windowMode !== "floating" ? "selected" : ""
          }>全屏</option>
          <option value="floating" ${
            g.windowMode === "floating" ? "selected" : ""
          }>悬浮窗</option>
        </select>
        <div class="novel-settings-hint">全屏：阅读器占满整个屏幕；悬浮窗：小窗口显示，可拖动标题栏移动位置，拖动右下角调整大小。</div>
      </div>

      <div class="novel-settings-row">
        <div class="novel-settings-label">显示用户回复</div>
        <label class="novel-switch">
          <input type="checkbox" class="novel-show-user-input" ${
            g.showUserReplies ? "checked" : ""
          } />
          <span class="novel-switch-track"></span>
          <span class="novel-switch-thumb"></span>
        </label>
        <div class="novel-settings-hint">开启时 user 回复与角色消息合并为一章；关闭后不显示 user 回复，每条角色消息作为单独一章。</div>
      </div>

      <div class="novel-settings-row">
        <div class="novel-settings-label">打开时显示</div>
        <select class="novel-start-page-select">
          <option value="last" ${g.startPage !== "home" ? "selected" : ""}>上次关闭的页面</option>
          <option value="home" ${g.startPage === "home" ? "selected" : ""}>首页（书架）</option>
        </select>
        <div class="novel-settings-hint">刷新酒馆后第一次打开阅读器时显示的页面；之后正常关闭再打开（不刷新）会回到上次位置。</div>
      </div>

      <div class="novel-settings-row novel-chapter-title-section">
        <div class="novel-settings-label">自动识别标题</div>
        <label class="novel-switch">
          <input type="checkbox" class="novel-auto-chapter-title" ${
            g.autoChapterTitle ? "checked" : ""
          } />
          <span class="novel-switch-track"></span>
          <span class="novel-switch-thumb"></span>
        </label>
        <div class="novel-settings-hint">从每章正文中提取自定义标签内的文字，作为该章的标题附加在目录中。不勾选则保持现状（第N章）。</div>
        <div class="novel-chapter-title-tag-row">
          <span class="novel-settings-label">识别标签</span>
          <input type="text" class="novel-chapter-title-tag" value="${escapeHtml(
            g.chapterTitleTag || "zj",
          )}" placeholder="zj" spellcheck="false" />
          <span class="novel-settings-hint">仅当「自动识别标题」开启时生效，修改后需重新打开聊天。</span>
        </div>
        <div class="novel-chapter-title-strip-row">
          <span class="novel-settings-label">剥离章号前缀</span>
          <label class="novel-switch">
            <input type="checkbox" class="novel-chapter-title-strip" ${
              g.stripChapterPrefix !== false ? "checked" : ""
            } />
            <span class="novel-switch-track"></span>
            <span class="novel-switch-thumb"></span>
          </label>
          <span class="novel-settings-hint">自动去掉标题开头的「第一章：」等前缀，避免与目录自带「第N章」重复（支持汉字/阿拉伯/全角数字）。</span>
        </div>
        <div class="novel-chapter-title-filter-row">
          <span class="novel-settings-label">过滤文字</span>
          <textarea class="novel-chapter-title-filter" rows="2" spellcheck="false" placeholder="每行一条，将从识别标题中移除。&#10;其中大写 N 代表任意数字。&#10;例如：&#10;第零章&#10;Chapter N">${escapeHtml(
            (g.chapterTitleFilters || []).join("\n"),
          )}</textarea>
          <span class="novel-settings-hint">逐条移除标题中的指定文字（可多条）。填「Chapter N」可匹配 Chapter 1 / Chapter 100 等任意数字；不含 N 的条目按字面删除。配合「剥离章号前缀」使用。</span>
        </div>
      </div>

      <div class="novel-settings-row novel-icon-config-section">
        <div class="novel-settings-label">自定义顶栏图标</div>
        <div class="novel-icon-input-row">
          <input type="text" class="novel-icon-url-input"
                 placeholder="${
                   hasTheme
                     ? "已自动检测美化主题图标"
                     : "输入图标URL（留空使用默认图标）"
                 }"
                 value="${escapeHtml(savedIconUrl)}" />
          ${
            hasTheme
              ? `<button class="novel-icon-dropdown-btn" title="从美化主题中选择图标"><i class="fa-solid fa-caret-down"></i></button>
                 <div class="novel-icon-dropdown-menu">${dropdownItemsHtml}</div>`
              : ""
          }
          <button class="novel-icon-clear-btn" title="清除自定义图标"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="novel-icon-status">
          <span class="novel-icon-status-dot ${
            savedIconUrl ? "novel-status-active" : "novel-status-inactive"
          }"></span>
          <span class="novel-icon-status-text">${
            savedIconUrl
              ? "使用自定义图标"
              : hasTheme
                ? "自动使用美化主题图标"
                : "使用默认图标"
          }</span>
        </div>
        <div class="novel-settings-hint">${
          hasTheme
            ? `检测到 ${themeIcons.uniqueUrls.length} 个美化主题图标，可从下拉菜单选择或手动输入URL`
            : "未检测到美化主题图标替换。启用美化主题后会自动检测并适配"
        }</div>
      </div>

      <div class="novel-settings-row novel-regex-section">
        <div class="novel-regex-active-summary"></div>
        <div class="novel-regex-label-row">
          <div class="novel-settings-label">全局正则</div>
          <button type="button" class="novel-regex-toggle-all" data-scope="base">全选</button>
        </div>
        <div class="novel-settings-hint">从酒馆中启用正则：全局正则自动跟随酒馆中你当前勾选的正则；角色正则仅在该角色的聊天中生效。勾选后，正文渲染时会先按勾选的正则处理消息内容（隐藏 OOC 指令、去敏感词等）。</div>
        <div class="novel-regex-list"></div>
      </div>

      <div class="novel-settings-row novel-regex-preset-section">
        <div class="novel-regex-label-row">
          <div class="novel-settings-label">预设正则</div>
          <button type="button" class="novel-regex-toggle-all" data-scope="preset">全选</button>
        </div>
        <div class="novel-settings-hint">从 API 预设中启用正则：先选择预设，再勾选其中的正则。切换查看其他预设时，已勾选的正则依然生效（跨预设累积）。</div>
        <div class="novel-regex-preset-search-row">
          <input
            type="text"
            class="novel-regex-preset-search"
            placeholder="搜索预设名称…"
            autocomplete="off"
          />
          <button type="button" class="novel-cfm-folder-btn novel-cfm-preset-filter" title="文件夹过滤" style="display:none">
            <i class="fa-solid fa-folder-tree"></i>
          </button>
        </div>
        <select class="novel-regex-preset-select"></select>
        <div class="novel-regex-preset-list"></div>
      </div>`;

    // ---- 目录每页章数 ----
    const range = content.querySelector("input[type='range']");
    const valueEl = content.querySelector(".novel-settings-value");
    valueEl.textContent = `${range.value} 章/页`;
    range.addEventListener("input", () => {
      valueEl.textContent = `${range.value} 章/页`;
      g.chaptersPerPage = Number(range.value);
      deps.saveSettings();
      // 若当前在目录页，实时刷新分页（保持当前页号不越界）
      if (state.page === "toc") {
        const info = reader.getChatInfo();
        if (info) {
          const totalPages = Math.max(
            1,
            Math.ceil(info.chapters.length / g.chaptersPerPage),
          );
          if (state.tocPage >= totalPages) state.tocPage = totalPages - 1;
        }
        const container = bodyEl.querySelector(".novel-page");
        if (container) renderTocPage(container);
      }
    });

    // ---- 打开时显示：切换后保存设置（立即生效，下次打开阅读器时应用） ----
    const startPageInput = content.querySelector(".novel-start-page-select");
    startPageInput?.addEventListener("change", () => {
      g.startPage = startPageInput.value;
      deps.saveSettings();
    });

    // ---- 阅读窗口模式：切换后保存设置（下次打开阅读器时生效） ----
    const windowModeInput = content.querySelector(".novel-window-mode-select");
    windowModeInput?.addEventListener("change", () => {
      g.windowMode = windowModeInput.value;
      deps.saveSettings();
    });

    // ---- 显示用户回复：切换后保存设置 + 若在目录/正文页则重新加载当前聊天 ----
    const showUserInput = content.querySelector(".novel-show-user-input");
    showUserInput?.addEventListener("change", async () => {
      g.showUserReplies = showUserInput.checked;
      deps.saveSettings();
      // 重新分章需要重新读取当前聊天（若正处于目录/正文页）
      if (state.page === "toc" || state.page === "reader") {
        const char = state.currentChar;
        const chat = state.currentChat;
        if (!char || !chat) return;
        const info = await reader.loadChat({
          avatar: char.avatar,
          fileName: chat.file_name,
        });
        if (state.page === "toc") {
          state.tocPage = 0;
          const container = bodyEl.querySelector(".novel-page");
          if (container) {
            if (info && info.chapters.length) {
              renderTocPage(container);
            } else {
              container.innerHTML = `<div class="novel-empty">该聊天暂无内容</div>`;
            }
          }
        } else if (state.page === "reader") {
          // 正文页：重新打开第 1 章（章节结构已变）
          await openChapter(1);
        }
      }
    });

    // ---- 自动识别标题：开关 + 标签名 + 剥离章号前缀 + 过滤文字（保存后若在目录/正文页则重新加载当前聊天） ----
    const autoTitleInput = content.querySelector(".novel-auto-chapter-title");
    const tagInput = content.querySelector(".novel-chapter-title-tag");
    const stripInput = content.querySelector(".novel-chapter-title-strip");
    const filterInput = content.querySelector(".novel-chapter-title-filter");
    let titleTagTimer = null;

    /** 保存当前标题识别配置 + 重新加载当前聊天以应用新标题 */
    async function applyChapterTitleConfig() {
      g.autoChapterTitle = autoTitleInput.checked;
      g.chapterTitleTag = (tagInput.value || "zj").trim() || "zj";
      g.stripChapterPrefix = stripInput ? stripInput.checked : true;
      g.chapterTitleFilters = (filterInput?.value || "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      deps.saveSettings();
      if (state.page === "toc" || state.page === "reader") {
        const char = state.currentChar;
        const chat = state.currentChat;
        if (!char || !chat) return;
        const info = await reader.loadChat({
          avatar: char.avatar,
          fileName: chat.file_name,
        });
        if (state.page === "toc") {
          state.tocPage = 0;
          const container = bodyEl.querySelector(".novel-page");
          if (container) {
            if (info && info.chapters.length) {
              renderTocPage(container);
            } else {
              container.innerHTML = `<div class="novel-empty">该聊天暂无内容</div>`;
            }
          }
        } else if (state.page === "reader") {
          await openChapter(state.currentChapter || 1);
        }
      }
    }

    autoTitleInput?.addEventListener("change", () => {
      applyChapterTitleConfig();
    });
    tagInput?.addEventListener("input", () => {
      // 防抖：停止输入 400ms 后保存（避免频繁重载聊天）
      clearTimeout(titleTagTimer);
      titleTagTimer = setTimeout(() => {
        applyChapterTitleConfig();
      }, 400);
    });
    stripInput?.addEventListener("change", () => {
      applyChapterTitleConfig();
    });
    filterInput?.addEventListener("input", () => {
      // 防抖：停止输入 400ms 后保存
      clearTimeout(titleTagTimer);
      titleTagTimer = setTimeout(() => {
        applyChapterTitleConfig();
      }, 400);
    });

    // ---- 自定义顶栏图标：下拉选择 / 手动输入 / 清除 ----
    const iconSection = content.querySelector(".novel-icon-config-section");
    const urlInput = content.querySelector(".novel-icon-url-input");
    const statusText = content.querySelector(".novel-icon-status-text");
    const statusDot = content.querySelector(".novel-icon-status-dot");
    const dropdownMenu = content.querySelector(".novel-icon-dropdown-menu");
    const dropdownBtn = content.querySelector(".novel-icon-dropdown-btn");

    /** 刷新状态提示 */
    function updateIconStatus() {
      const cur = g.customTopbarIcon || "";
      const active = !!cur;
      statusDot.classList.toggle("novel-status-active", active);
      statusDot.classList.toggle("novel-status-inactive", !active);
      statusText.textContent = cur
        ? "使用自定义图标"
        : hasTheme
          ? "自动使用美化主题图标"
          : "使用默认图标";
    }

    /** 应用当前配置到顶栏图标 */
    function applyIconConfig() {
      applyTopbarIconFromConfigCore({
        getSavedIcon: () => g.customTopbarIcon,
        detectNeighborIcon: () =>
          detectNeighborIconCore({
            document,
            window,
            isImageIconBackground: isImageIconBackgroundCore,
          }),
        applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
          applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
        clearCustomIcon: () => clearCustomIconCore({ $ }),
        toCssUrl: toCssUrlCore,
      });
      // 手动改动图标配置后重置 2s 轮询签名，让轮询立即感知最新配置（避免去重跳过应用）
      topbarIconAdaptor?.resetSignature();
    }

    // 下拉按钮：开合菜单
    dropdownBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle("novel-dropdown-open");
    });
    // 点击其它区域关闭下拉
    document.addEventListener("click", (e) => {
      if (dropdownMenu && !e.target.closest(".novel-icon-input-row")) {
        dropdownMenu.classList.remove("novel-dropdown-open");
      }
    });
    // 下拉选择主题图标 → 保存 + 立即应用
    dropdownMenu
      ?.querySelectorAll(".novel-icon-dropdown-item")
      .forEach((item) => {
        item.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const url = item.dataset.url;
          urlInput.value = url;
          g.customTopbarIcon = url;
          deps.saveSettings();
          applyIconConfig();
          updateIconStatus();
          dropdownMenu.classList.remove("novel-dropdown-open");
          dropdownMenu
            .querySelectorAll(".novel-icon-dropdown-item")
            .forEach((i) => i.classList.remove("novel-icon-selected"));
          item.classList.add("novel-icon-selected");
        });
      });
    // 手动输入 URL（回车/失焦触发 change）→ 保存 + 应用；清空 → 回自动检测
    urlInput?.addEventListener("change", () => {
      const url = urlInput.value.trim();
      g.customTopbarIcon = url;
      deps.saveSettings();
      if (url) {
        applyIconConfig();
      } else {
        // 清空 → 回到自动检测模式（手动编排内部会走检测分支）
        applyIconConfig();
      }
      updateIconStatus();
    });
    // 清除按钮：清空输入 + 设置 + 回自动检测
    content
      .querySelector(".novel-icon-clear-btn")
      ?.addEventListener("click", () => {
        urlInput.value = "";
        g.customTopbarIcon = "";
        deps.saveSettings();
        applyIconConfig();
        updateIconStatus();
        dropdownMenu
          ?.querySelectorAll(".novel-icon-dropdown-item")
          .forEach((i) => i.classList.remove("novel-icon-selected"));
      });

    // ---- 正则过滤：列出酒馆正则（全局 + 当前角色级），勾选后应用到小说阅读 ----
    const regexListEl = content.querySelector(".novel-regex-list");
    const regexActiveEl = content.querySelector(".novel-regex-active-summary");
    const regexPresetSectionEl = content.querySelector(
      ".novel-regex-preset-section",
    );
    const avatarForRegex = state.currentChar?.avatar || "";
    // 全局/角色列表不包含预设正则（预设单独在下方子区块列出）
    const regexScripts = regexCore.getAllScripts({
      avatar: avatarForRegex,
      presetNames: [],
    });

    // 勾选变化后：持久化 + 若在阅读/目录页则立即重新渲染当前章
    function applyRegexToggle(item, checked) {
      regexCore.setEnabledState(item, checked);
      deps.saveSettings();
      if (state.page === "reader") {
        const ch = state.currentChapter;
        if (ch) openChapter(ch);
      } else if (state.page === "toc") {
        const container = bodyEl.querySelector(".novel-page");
        if (container) renderTocPage(container);
      }
      // 同步下方列表 + 概览 + 当前预设列表的勾选状态
      renderRegexBaseList();
      renderRegexActiveSummary();
      if (presetSelectEl) renderPresetRegexList(presetSelectEl.value);
      updateToggleAllLabels();
    }

    // 全选/取消全选按钮文案刷新：根据当前区块勾选状态切换「全选/取消全选」
    function updateToggleAllLabels() {
      content.querySelectorAll(".novel-regex-toggle-all").forEach((btn) => {
        const scope = btn.dataset.scope;
        let items = [];
        if (scope === "base") {
          items = regexScripts;
        } else if (scope === "preset" && presetSelectEl) {
          items = regexCore
            .getAllScripts({ presetNames: [presetSelectEl.value] })
            .filter((item) => item.source === "preset");
        }
        if (!items.length) {
          btn.textContent = "全选";
          return;
        }
        const allOn = items.every((item) => regexCore.isEnabled(item));
        btn.textContent = allOn ? "取消全选" : "全选";
      });
    }

    // 全选/取消全选：先统一勾选/取消当前区块全部正则，再同步渲染
    function toggleAllRegex(scope) {
      let items = [];
      if (scope === "base") {
        items = regexScripts;
      } else if (scope === "preset" && presetSelectEl) {
        items = regexCore
          .getAllScripts({ presetNames: [presetSelectEl.value] })
          .filter((item) => item.source === "preset");
      }
      if (!items.length) return;
      const allOn = items.every((item) => regexCore.isEnabled(item));
      items.forEach((item) => regexCore.setEnabledState(item, !allOn));
      deps.saveSettings();
      if (state.page === "reader") {
        const ch = state.currentChapter;
        if (ch) openChapter(ch);
      } else if (state.page === "toc") {
        const container = bodyEl.querySelector(".novel-page");
        if (container) renderTocPage(container);
      }
      renderRegexBaseList();
      renderRegexActiveSummary();
      if (presetSelectEl) renderPresetRegexList(presetSelectEl.value);
      updateToggleAllLabels();
    }

    /** 渲染一条正则勾选行（checkbox + 徽标 + 名称），change 时同步状态 */
    function renderRegexItem(row, item, badgeText) {
      const checked = regexCore.isEnabled(item);
      row.innerHTML = `
        <input type="checkbox" data-key="${escapeHtml(item.key)}" ${checked ? "checked" : ""} />
        <span class="novel-regex-badge">${badgeText}</span>
        <span class="novel-regex-name">${escapeHtml(
          String(item.script.scriptName || item.script.id || "未命名"),
        )}</span>`;
      row.addEventListener("change", (e) =>
        applyRegexToggle(item, e.target.checked),
      );
    }

    /** 下方全局/角色正则列表 */
    function renderRegexBaseList() {
      regexListEl.innerHTML = "";
      if (!regexScripts.length) {
        const empty = document.createElement("div");
        empty.className = "novel-regex-empty";
        empty.textContent =
          "没有可用的全局/角色正则。可先在下方选择 API 预设并勾选其中的预设正则。";
        regexListEl.appendChild(empty);
        return;
      }
      regexScripts.forEach((item) => {
        const row = document.createElement("label");
        row.className = "novel-regex-item";
        renderRegexItem(row, item, item.source === "global" ? "全局" : "角色");
        regexListEl.appendChild(row);
      });
    }

    // 已启用正则概览（位于全局正则上方）：显示全局 + 用户已勾选的各预设，
    // 默认收起，点击分组标题可展开查看并取消勾选
    function renderRegexActiveSummary() {
      regexActiveEl.innerHTML = "";
      const allItems = regexCore.getAllScripts({ avatar: avatarForRegex });
      const active = allItems.filter(
        (item) => regexCore.isEnabled(item) && item.source !== "character",
      );
      if (!active.length) {
        const empty = document.createElement("div");
        empty.className = "novel-regex-empty";
        empty.textContent =
          "当前没有启用的正则。勾选下方或预设中的正则后，会显示在这里。";
        regexActiveEl.appendChild(empty);
        return;
      }
      const groups = [];
      const globalItems = active.filter((item) => item.source === "global");
      if (globalItems.length)
        groups.push({ type: "global", name: "全局", items: globalItems });
      const presetNames = [
        ...new Set(
          active.filter((i) => i.source === "preset").map((i) => i.presetName),
        ),
      ];
      for (const pn of presetNames) {
        const items = active.filter((i) => i.presetName === pn);
        if (items.length)
          groups.push({
            type: "preset",
            presetName: pn,
            name: `预设 · ${pn}`,
            items,
          });
      }
      if (groups.length) {
        const tip = document.createElement("div");
        tip.className = "novel-regex-summary-tip";
        tip.textContent =
          "已勾选的正则：点击分组标题可展开查看，点击右侧定位按钮可快速跳转到对应位置。";
        regexActiveEl.appendChild(tip);
      }
      groups.forEach((group) => {
        const groupEl = document.createElement("div");
        groupEl.className = "novel-regex-group";
        const head = document.createElement("div");
        head.className = "novel-regex-group-head";
        head.innerHTML = `
          <span class="novel-regex-group-arrow">▸</span>
          <span class="novel-regex-group-name">${escapeHtml(group.name)}</span>
          <span class="novel-regex-group-count">${group.items.length}</span>
          <button class="novel-regex-group-locate" type="button" title="定位到对应位置">
            <i class="fa-solid fa-location-crosshairs"></i>
          </button>`;
        const list = document.createElement("div");
        list.className = "novel-regex-group-list";
        list.style.display = "none"; // 默认收起
        group.items.forEach((item) => {
          const row = document.createElement("label");
          row.className = "novel-regex-item";
          renderRegexItem(
            row,
            item,
            item.source === "global" ? "全局" : "预设",
          );
          list.appendChild(row);
        });
        // 点击分组标题：仅展开/收起列表（跳转交给右侧定位按钮）
        head.addEventListener("click", () => {
          const expanded = list.style.display !== "none";
          list.style.display = expanded ? "none" : "";
          head.classList.toggle("novel-regex-group-open", !expanded);
        });
        // 定位按钮：跳转到对应位置
        //  - 全局分组 → 滚动到下方全局/角色正则列表
        //  - 预设分组 → 自动切换下拉框到该预设并渲染其正则列表，再滚动到预设区块
        const locateBtn = head.querySelector(".novel-regex-group-locate");
        locateBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (group.type === "preset" && presetSelectEl) {
            // 若目标预设不在当前下拉选项（搜索/CFM 文件夹过滤排除了它），
            // 先重置过滤条件再重新渲染选项，确保能切换到该预设
            if (
              ![...presetSelectEl.options].some(
                (o) => o.value === group.presetName,
              )
            ) {
              presetSearchEl.value = "";
              if (
                presetFolderFilter !== "__all__" &&
                presetFolderBtn &&
                cfmBridge.isCfmInstalled()
              ) {
                presetFolderFilter = "__all__";
                presetFolderPanel?.setFilter("__all__");
                presetFolderPanel?.close();
              }
              renderPresetOptions("");
            }
            presetSelectEl.value = group.presetName;
            renderPresetRegexList(group.presetName);
          }
          const scrollTarget =
            group.type === "global" ? regexListEl : regexPresetSectionEl;
          if (scrollTarget) {
            requestAnimationFrame(() => {
              try {
                scrollTarget.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              } catch {
                scrollTarget.scrollIntoView(true);
              }
            });
          }
        });
        groupEl.appendChild(head);
        groupEl.appendChild(list);
        regexActiveEl.appendChild(groupEl);
      });
    }

    renderRegexActiveSummary();
    renderRegexBaseList();

    // 全选按钮事件绑定（作用域：base = 全局/角色列表；preset = 当前选中预设）
    content.querySelectorAll(".novel-regex-toggle-all").forEach((btn) => {
      btn.addEventListener("click", () => toggleAllRegex(btn.dataset.scope));
    });

    // ---- 预设正则：先选预设，再勾选该预设中的正则（跨预设累积生效） ----
    const presetSelectEl = content.querySelector(".novel-regex-preset-select");
    const presetListEl = content.querySelector(".novel-regex-preset-list");
    const presetSearchEl = content.querySelector(".novel-regex-preset-search");
    const presetFolderBtn = content.querySelector(".novel-cfm-preset-filter");
    const presetOptions = regexCore.getAllPresets();

    // 初始刷新全选按钮文案（需在 presetSelectEl 声明之后调用，避免 TDZ）
    updateToggleAllLabels();

    // CFM 预设文件夹过滤：仅同时安装 CFM 时显示；选中后仅展示该文件夹下的预设。
    // 面板控制器在下方 else 块内创建（需拿到 renderPresetOptions 供 onSelect 调用）。
    let presetFolderFilter = "__all__";
    let presetFolderPanel = null;
    if (presetFolderBtn && cfmBridge.isCfmInstalled()) {
      presetFolderBtn.style.display = "";
    }

    function renderPresetRegexList(presetName) {
      presetListEl.innerHTML = "";
      if (!presetName) {
        const empty = document.createElement("div");
        empty.className = "novel-regex-empty";
        const kw = (presetSearchEl?.value || "").trim();
        empty.textContent = kw
          ? `没有匹配「${escapeHtml(kw)}」的预设。`
          : "请先在上方选择一个预设。";
        presetListEl.appendChild(empty);
        updateToggleAllLabels();
        return;
      }
      const items = regexCore
        .getAllScripts({ presetNames: [presetName] })
        .filter((item) => item.source === "preset");
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "novel-regex-empty";
        empty.textContent = "该预设中没有正则脚本。";
        presetListEl.appendChild(empty);
        updateToggleAllLabels();
        return;
      }
      items.forEach((item) => {
        const row = document.createElement("label");
        row.className = "novel-regex-item";
        renderRegexItem(row, item, "预设");
        presetListEl.appendChild(row);
      });
      updateToggleAllLabels();
    }

    if (!presetOptions.length) {
      presetSearchEl.style.display = "none";
      if (presetFolderBtn) presetFolderBtn.style.display = "none";
      const empty = document.createElement("div");
      empty.className = "novel-regex-empty";
      empty.textContent = "当前 API 没有可用的预设。";
      presetSelectEl.parentElement?.appendChild(empty);
      presetSelectEl.style.display = "none";
    } else {
      // 按关键词过滤预设选项（匹配预设名，忽略大小写）
      function renderPresetOptions(filter) {
        const kw = (filter || "").trim().toLowerCase();
        presetSelectEl.innerHTML = "";
        let matched = presetOptions.filter(
          (p) => !kw || p.name.toLowerCase().includes(kw),
        );
        // CFM 文件夹过滤：选中非「全部」时，仅保留属于该文件夹（含子文件夹）的预设
        if (presetFolderFilter !== "__all__" && cfmBridge.isCfmInstalled()) {
          const allowed = cfmBridge.getItemsInFolder(
            "presets",
            presetFolderFilter,
          );
          if (allowed) {
            matched = matched.filter((p) => allowed.has(p.name));
          }
        }
        matched.forEach((p) => {
          const option = document.createElement("option");
          option.value = p.name;
          option.textContent = p.count ? `${p.name}（${p.count}）` : p.name;
          presetSelectEl.appendChild(option);
        });
        return matched;
      }

      // CFM 预设文件夹过滤：创建浮动面板 + 按钮点击开合（需在 renderPresetOptions 定义后）
      if (presetFolderBtn && cfmBridge.isCfmInstalled()) {
        presetFolderPanel = createCfmFolderPanel({
          anchorEl: presetFolderBtn,
          type: "presets",
          getBridge: () => cfmBridge,
          currentFilter: presetFolderFilter,
          onSelect: (folderId) => {
            presetFolderFilter = folderId;
            const m = renderPresetOptions(presetSearchEl.value);
            if (m.length) {
              presetSelectEl.value = m[0].name;
              renderPresetRegexList(presetSelectEl.value);
            } else {
              renderPresetRegexList(null);
            }
          },
        });
        presetFolderBtn.onclick = (e) => {
          e.stopPropagation();
          presetFolderPanel.toggle();
        };
      }

      const matched = renderPresetOptions(presetSearchEl.value);
      if (matched.length) {
        // 默认选中第一个匹配预设并渲染其正则列表
        presetSelectEl.value = matched[0].name;
        renderPresetRegexList(presetSelectEl.value);
      } else {
        renderPresetRegexList(null);
      }
      presetSelectEl.addEventListener("change", () =>
        renderPresetRegexList(presetSelectEl.value),
      );
      presetSearchEl.addEventListener("input", () => {
        const m = renderPresetOptions(presetSearchEl.value);
        if (m.length) {
          presetSelectEl.value = m[0].name;
          renderPresetRegexList(presetSelectEl.value);
        } else {
          renderPresetRegexList(null);
        }
      });
    }

    // 设置弹窗关闭：清理预设文件夹过滤面板（独立挂 body 的浮动层不会随弹窗自动移除）
    dlg.onClose = () => {
      presetFolderPanel?.close();
    };
  }

  // ============ 底部栏事件（小说设置） ============

  function bindBottombarEvents() {
    bottombarEl
      .querySelector('[data-action="home"]')
      .addEventListener("click", () => goHome());
    bottombarEl
      .querySelector('[data-action="toc"]')
      .addEventListener("click", showToc);
    bottombarEl
      .querySelector('[data-action="prev"]')
      .addEventListener("click", () => goChapter(-1));
    bottombarEl
      .querySelector('[data-action="next"]')
      .addEventListener("click", () => goChapter(1));
    bottombarEl
      .querySelector('[data-action="bookmark"]')
      .addEventListener("click", () => toggleBookmark());
    bottombarEl
      .querySelector('[data-action="reader-settings"]')
      .addEventListener("click", () => toggleReaderSettings());
  }

  /** 返回目录页 */
  function showToc() {
    if (!state.currentChat) return;
    setPage("toc");
    const page = document.createElement("div");
    page.className = "novel-page";
    bodyEl.appendChild(page);
    renderTocPage(page);
  }

  // ============ 界面设置子面板（正文页底部栏「界面」按钮） ============

  /** 界面设置：字号 / 文字颜色 / 背景色（实时应用 + 持久化） */
  function toggleReaderSettings() {
    if (settingsPanelEl) {
      closeSettingsPanel();
      return;
    }
    const g = getGlobalSettings();
    const rs = g.readerSettings;

    const panel = document.createElement("div");
    panel.className = "novel-settings-panel";
    settingsPanelEl = panel;
    // 面板弹出在底部栏上方（.novel-settings-panel bottom:100% 相对 bottombar 定位）
    bottombarEl.appendChild(panel);

    // 字号
    const fontRow = document.createElement("div");
    fontRow.className = "novel-settings-row";
    const fontLabel = document.createElement("div");
    fontLabel.className = "novel-settings-label";
    fontLabel.textContent = "字号";
    const fontRange = document.createElement("input");
    fontRange.type = "range";
    fontRange.min = "14";
    fontRange.max = "26";
    fontRange.step = "1";
    fontRange.value = String(rs.fontSize || getDefaultFontSize());
    const fontValue = document.createElement("div");
    fontValue.className = "novel-settings-value";
    fontValue.textContent = `${fontRange.value}px`;
    fontRange.addEventListener("input", () => {
      rs.fontSize = Number(fontRange.value);
      fontValue.textContent = `${fontRange.value}px`;
      applyReaderStyles();
      deps.saveSettings();
    });
    fontRow.appendChild(fontLabel);
    fontRow.appendChild(fontRange);
    fontRow.appendChild(fontValue);
    panel.appendChild(fontRow);

    // 主题选择：∅ = 跟随酒馆美化；其余 = 内置独立配色主题
    const themeRow = document.createElement("div");
    themeRow.className = "novel-settings-row";
    const themeLabel = document.createElement("div");
    themeLabel.className = "novel-settings-label";
    themeLabel.textContent = "主题";
    const themeSwatches = document.createElement("div");
    themeSwatches.className = "novel-swatches";
    READER_THEMES.forEach((theme) => {
      // 每个主题 = 色块 + 底部名字标注，等距铺满
      const item = document.createElement("div");
      item.className = "novel-swatch-item";
      const sw = document.createElement("div");
      sw.className =
        "novel-swatch" +
        (rs.themeId === theme.id ? " active" : "") +
        (theme.bg === "" ? " novel-swatch-palette" : "");
      // 纯背景色块；∅ 用调色板样式示意「跟随酒馆」（样式在 style.css 定义）
      if (theme.bg !== "") sw.style.background = theme.bg;
      sw.title = theme.name;
      sw.dataset.themeId = theme.id;
      sw.addEventListener("click", () => {
        rs.themeId = theme.id;
        applyReaderStyles();
        deps.saveSettings();
        themeSwatches
          .querySelectorAll(".novel-swatch")
          .forEach((s) => s.classList.remove("active"));
        sw.classList.add("active");
      });
      item.appendChild(sw);
      const swName = document.createElement("div");
      swName.className = "novel-swatch-name";
      swName.textContent = theme.name;
      item.appendChild(swName);
      themeSwatches.appendChild(item);
    });
    themeRow.appendChild(themeLabel);
    themeRow.appendChild(themeSwatches);
    panel.appendChild(themeRow);

    // 提示：内置主题的引号/星号配色独立于酒馆美化
    const themeHint = document.createElement("div");
    themeHint.className = "novel-settings-hint";
    themeHint.textContent =
      "∅ 跟随酒馆美化；内置主题自带正文配色，引号/星号不再跟随酒馆。";
    panel.appendChild(themeHint);
  }

  /** 关闭设置子面板 */
  function closeSettingsPanel() {
    settingsPanelEl?.remove();
    settingsPanelEl = null;
  }

  /** 应用阅读器界面样式：主题（∅跟随酒馆 / 内置主题）+ 字号 */
  function applyReaderStyles() {
    if (!dialogRef) return;
    const g = getGlobalSettings();
    const rs = g.readerSettings;
    const dialogEl = dialogRef.dialog;

    // 字号：只作用于正文容器
    if (readerScrollEl) {
      const inner = readerScrollEl.querySelector(".novel-reader-inner");
      if (inner)
        inner.style.fontSize = `${rs.fontSize || getDefaultFontSize()}px`;
    }

    const themeId = rs.themeId || "";
    const isBuiltin = READER_THEMES.some((t) => t.id && t.id === themeId);
    const overlayEl = dialogRef.overlay;

    // 清除旧主题 class，再加当前主题 class（dialog + overlay 同步）
    READER_THEMES.forEach((t) => {
      if (!t.id) return;
      dialogEl.classList.remove(`novel-theme-${t.id}`);
      overlayEl?.classList.remove(`novel-theme-${t.id}`);
    });
    if (isBuiltin) {
      dialogEl.classList.add(`novel-theme-${themeId}`);
      overlayEl?.classList.add(`novel-theme-${themeId}`);
      // 清除采样内联变量（内置主题 class 自带 --novel-bg/--novel-fg 定义）
      dialogEl.style.removeProperty("--novel-bg");
      dialogEl.style.removeProperty("--novel-fg");
      // 关闭桥接：引号/星号不再跟随酒馆，改用主题自带特效变量
      themeTextBridge.setEnabled(false);
    } else {
      // ∅ 跟随酒馆：重新采样恢复主题色
      dialogEl.style.background = "";
      dialogEl.style.removeProperty("--novel-fg");
      try {
        const sampled = sampleStThemeCore();
        applyThemeCore(dialogEl, sampled);
        // 悬浮窗：美化主题为半透明/渐变/图片时采样不到不透明背景，
        // 直接写死不透明兜底色避免窗口透底（全屏因遮罩+窗口双倍叠加不明显）
        if (dialogEl.classList.contains("novel-dialog-floating")) {
          const sampledBg = sampled?.bg;
          if (!sampledBg || /^rgba\(|^hsla\(/.test(sampledBg)) {
            dialogEl.style.background = resolveOpaqueBg(sampledBg);
          }
        }
      } catch (err) {
        // 采样失败则保持现状
      }
      // 恢复桥接：引号/星号继续跟随酒馆美化
      themeTextBridge.setEnabled(true);
    }
    dialogEl.style.color = "";
  }

  // ============ 事件订阅 ============

  function subscribeEvents() {
    const events = ctx.eventSource;
    const types = ctx.eventTypes;
    if (!events || !types) return;

    // 聊天切换：清缓存（弹窗内按需刷新）+ 正则脚本列表缓存失效
    events.on(types.CHAT_CHANGED, () => {
      setTimeout(() => bookshelf.clearCache(), 300);
      regexCore.invalidateScriptCache();
    });

    // 角色重命名：清缓存 + 正则脚本列表缓存失效（avatar 键可能变化）
    events.on(types.CHARACTER_RENAMED, () => {
      setTimeout(() => bookshelf.clearCache(), 300);
      regexCore.invalidateScriptCache();
    });
  }

  // ============ 顶栏按钮注入（ST 主界面） ============

  function injectTopbarButton() {
    const btn = document.createElement("div");
    btn.id = "novel-topbar-button";
    btn.className = "drawer";
    btn.innerHTML = `
      <div class="drawer-toggle drawer-header" title="酒馆小说阅读器">
        <div class="drawer-icon closedIcon fa-solid fa-book interactable" title="酒馆小说阅读器" tabindex="0" role="button"></div>
      </div>`;
    btn.addEventListener("click", (e) => {
      // 无论点击 icon 还是覆盖其上的 toggle（url 图标模式），都打开阅读器
      if (e.target.closest("#novel-topbar-button")) openReaderDialog();
    });
    $("#rightNavHolder").before(btn);

    // 顶栏图标美化适配：检测美化主题图标并自动保持一致（延迟等主题样式加载）
    // 优先级：手动指定 URL > 自动检测邻居 > 默认 FA 图标
    try {
      const adaptor = createTopbarIconAdaptorCore({
        $,
        isImageIconBackground: isImageIconBackgroundCore,
        // 2s 轮询去重签名用：读取用户手动保存的图标 URL（无则空串 → 走邻居检测）
        getSavedIcon: () => getGlobalSettings().customTopbarIcon,
        detectNeighborIcon: () =>
          detectNeighborIconCore({
            document,
            window,
            isImageIconBackground: isImageIconBackgroundCore,
          }),
        applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
          applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
        clearCustomIcon: () => clearCustomIconCore({ $ }),
        applyTopbarIconFromConfig: () =>
          applyTopbarIconFromConfigCore({
            getSavedIcon: () => getGlobalSettings().customTopbarIcon,
            detectNeighborIcon: () =>
              detectNeighborIconCore({
                document,
                window,
                isImageIconBackground: isImageIconBackgroundCore,
              }),
            applyCustomIcon: (cssUrl, targetCls, extraStyles) =>
              applyCustomIconCore(cssUrl, targetCls, extraStyles, { $ }),
            clearCustomIcon: () => clearCustomIconCore({ $ }),
            toCssUrl: toCssUrlCore,
          }),
      });
      topbarIconAdaptor = adaptor;
      adaptor.start();
    } catch (err) {
      console.warn("[NovelReader] 顶栏图标适配初始化失败:", err);
    }
  }

  // ============ 启动 ============

  injectTopbarButton();
  subscribeEvents();

  // 启动主题文本样式桥接（美化主题引号/星号特效 → 阅读器正文）
  try {
    themeTextBridge.start();
  } catch (err) {
    console.warn("[NovelReader] 主题文本桥接启动失败:", err);
  }

  // ============ 暴露全局 API ============

  window.NovelReader = {
    extName: EXT_NAME,
    open: openReaderDialog,
    close: closeReaderDialog,
    bookshelf,
    reader,
    progress,
    bookmarks,
  };

  console.log("[NovelReader] 已就绪，点击顶栏书图标打开。");
});

// ============ 工具函数 ============

/** HTML 转义（纯文本安全输出） */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
