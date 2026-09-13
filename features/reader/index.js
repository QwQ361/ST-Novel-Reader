// features/reader/index.js
// 小说阅读器功能聚合入口：读取完整消息数组 + 分章 + 按章安全渲染。
// 依赖注入 deps：
//   getChatMessages(avatar, fileName)  读完整消息数组（由 bookshelf 提供）
//   renderMarkdown(markdown)           Markdown 安全渲染管线（由 integrations 提供）

import {
  filterTitleText,
  getChapterTitle,
  splitChapters,
  stripChapterNumberPrefix,
} from "./chapters.js";
import { renderMessage, renderMessagesBatched } from "./render.js";

/**
 * 创建小说阅读器核心。
 * @param {object} deps 依赖注入
 * @returns {object} reader API
 */
export function createReaderCore(deps) {

  // 当前正在渲染的聊天标识（用于并发竞态防护）
  let currentRequest = { avatar: "", fileName: "" };
  // 缓存：当前已加载聊天的消息数组 + 章节列表（换聊天时重建）
  let chatCache = null;

  /**
   * 加载某聊天的完整消息并分章（不渲染正文）。
   * @param {object} options
   * @param {string} options.avatar 角色头像文件名
   * @param {string} options.fileName 聊天文件名（带 .jsonl）
   * @returns {Promise<{messages: Array, chapters: Array}|null>}
   *   null 表示加载失败或已切换；chapters 元素为 {index, messages, title}
   */
  async function loadChat(options = {}) {
    const { avatar, fileName } = options;
    currentRequest = { avatar, fileName };

    const messages = await deps.getChatMessages(avatar, fileName);
    // 竞态防护：加载期间用户切换了聊天
    if (
      currentRequest.avatar !== avatar ||
      currentRequest.fileName !== fileName
    ) {
      return null;
    }

    // 分章；是否显示 user 回复：设置页「显示用户回复」开关（默认开）
    const showUserReplies = deps.getShowUserReplies
      ? deps.getShowUserReplies()
      : true;
    // 自动识别标题：设置页「自动识别标题」开关 + 标签名（空 = 关闭）
    const titleTag = deps.getChapterTitleTag ? deps.getChapterTitleTag() : "";
    // 标题过滤文字（多行，每行一条）+ 是否剥离章号前缀（如「第一章：」）
    const titleFilters = deps.getChapterTitleFilters
      ? deps.getChapterTitleFilters()
      : [];
    const stripPrefix = deps.getStripChapterPrefix
      ? deps.getStripChapterPrefix()
      : true;
    const chapters = splitChapters(messages, { showUserReplies }).map((ch) => {
      // 标签识别开启时，若章节标题来自标签（而非说话人），标记 titleSource="tag"
      let titleSource = "speaker";
      let title = "";
      if (titleTag) {
        const extracted = getChapterTitle(ch, {
          userName: deps.userName,
          tag: titleTag,
        });
        // 仅当提取结果非空且与说话人兜底不同，才视为标签标题
        const speaker = getChapterTitle(ch, { userName: deps.userName });
        title = extracted;
        if (extracted && extracted !== speaker) titleSource = "tag";
        else title = speaker;
      } else {
        title = getChapterTitle(ch, { userName: deps.userName });
      }
      // 标签标题二次处理：剥离章号前缀（「第一章：」）+ 移除用户指定的过滤文字
      if (titleSource === "tag") {
        if (stripPrefix) title = stripChapterNumberPrefix(title);
        title = filterTitleText(title, titleFilters);
      }
      return { ...ch, title, titleSource };
    });

    chatCache = { avatar, fileName, messages, chapters };
    return chatCache;
  }

  /**
   * 渲染指定章节到正文容器（只渲染本章消息，性能好）。
   * @param {HTMLElement} container 正文滚动容器（.novel-reader-scroll）
   * @param {number} chapterIndex 章节索引（从 1 开始）
   * @param {object} [options]
   * @param {Function} [options.onRendered] 渲染完成回调
   * @returns {Promise<number>} 本章消息条数
   */
  async function renderChapter(container, chapterIndex, options = {}) {
    const { onRendered, highlightOffset = null } = options;
    if (!chatCache) return 0;
    const chapter = chatCache.chapters[chapterIndex - 1];
    if (!chapter) return 0;

    container.innerHTML = `<div class="novel-loading">加载章节…</div>`;

    // 构建章标题：第一行「N / 总章数」，第二行「第N章 章节名」
    // （仅当标题来自标签识别时附带章节名，否则只显示「第N章」，与目录一致）
    const titleEl = document.createElement("h2");
    titleEl.className = "novel-chapter-title";
    titleEl.textContent = `${chapter.index} / ${chatCache.chapters.length}`;

    let subtitleText = `第${chapter.index}章`;
    if (chapter.titleSource === "tag" && chapter.title) {
      subtitleText += ` ${chapter.title}`;
    }
    const subtitleEl = document.createElement("div");
    subtitleEl.className = "novel-chapter-subtitle";
    subtitleEl.textContent = subtitleText;

    const inner = document.createElement("div");
    inner.className = "novel-reader-inner";
    inner.appendChild(titleEl);
    inner.appendChild(subtitleEl);

    const body = document.createElement("div");
    body.className = "novel-msg-list";
    inner.appendChild(body);

    container.innerHTML = "";
    container.appendChild(inner);

    await renderMessagesBatched(
      { ...deps, renderMarkdown: deps.renderMarkdown },
      body,
      chapter.messages,
      {
        batchSize: 200,
        userName: deps.userName,
        avatar: chatCache.avatar,
      },
    );

    // 定位到指定消息（从搜索结果跳转时）：按章内偏移滚动定位 + 高亮
    if (highlightOffset != null) {
      const target = body.children[highlightOffset];
      if (target) {
        requestAnimationFrame(() => {
          target.scrollIntoView({ block: "center" });
          target.classList.add("novel-msg-highlight");
          // 2.5s 后移除高亮
          setTimeout(
            () => target.classList.remove("novel-msg-highlight"),
            2500,
          );
        });
      }
    } else {
      container.scrollTop = 0;
    }
    onRendered?.(container);
    return chapter.messages.length;
  }

  /**
   * 全聊天内搜索（关键词 → 章节定位）。
   * @param {string} query 关键词（不区分大小写）
   * @returns {Array<{chapterIndex:number, msgOffset:number, name:string, snippet:string}>}
   *   最多返回 200 条；msgOffset = 消息在本章内的偏移（用于渲染后定位 body.children[msgOffset]）
   */
  function searchMessages(query) {
    if (!chatCache) return [];
    const q = String(query || "")
      .toLowerCase()
      .trim();
    if (!q) return [];
    const results = [];
    const chapters = chatCache.chapters;
    for (let c = 0; c < chapters.length; c += 1) {
      const ch = chapters[c];
      for (let i = 0; i < ch.messages.length; i += 1) {
        const mes = ch.messages[i];
        const text = String(mes.mes || "").toLowerCase();
        if (text.includes(q)) {
          results.push({
            chapterIndex: ch.index,
            msgOffset: i,
            name: mes.name || (mes.is_user ? deps.userName : "?"),
            snippet: String(mes.mes || "").slice(0, 120),
          });
          if (results.length >= 200) return results;
        }
      }
    }
    return results;
  }

  /** 获取当前聊天信息（章节数/标题等） */
  function getChatInfo() {
    if (!chatCache) return null;
    return {
      avatar: chatCache.avatar,
      fileName: chatCache.fileName,
      chapters: chatCache.chapters,
      totalChapters: chatCache.chapters.length,
    };
  }

  /** 获取指定章节 */
  function getChapter(chapterIndex) {
    if (!chatCache) return null;
    return chatCache.chapters[chapterIndex - 1] ?? null;
  }

  /**
   * 取消当前渲染（供关闭弹窗时调用）。
   * 注意：不清空 chatCache —— 完整消息数组已由内容缓存兜底，保留内存中的
   * 章节缓存可让「关闭后重开」秒进目录/正文，无需重新分章。
   * 换聊天时 loadChat 会自然重建 chatCache。
   */
  function abort() {
    currentRequest = { avatar: "", fileName: "" };
  }

  return {
    loadChat,
    renderChapter,
    getChatInfo,
    getChapter,
    searchMessages,
    renderMessage,
    abort,
  };
}
