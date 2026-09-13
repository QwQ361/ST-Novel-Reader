// features/reader/chapters.js
// 分章纯函数：把完整消息数组按「user+char 合并」规则切成章。
// 规则（用户明确指定）：
//   1. 一个角色(char)的连续对话为 1 章
//   2. 若 char 前面紧跟 user 对话，两者合并为 1 章
// 示例：
//   char1, user2, char2, user3, char3     → 第1章[char1] 第2章[user2,char2] 第3章[user3,char3]
//   user1, char1, user2, char2            → 第1章[user1,char1] 第2章[user2,char2]
//   user1, char1, user2, char2, user3     → 第1章[user1,char1] 第2章[user2,char2] 第3章[user3]
// 系统消息不特殊对待：按 is_user 正常参与分章（部分聊天把剧情正文标记为 is_system，
// 若把系统消息一律归并进当前章会导致大量轮次挤进一章）。
// 隐藏 user 回复（showUserReplies=false）：
//   先过滤掉全部 is_user 消息，剩余消息按「每条 char 单独成章」切分（system 也保留为独立章）。

/**
 * 将消息数组按分章规则切成章节。
 * @param {Array<object>} messages 完整消息数组（ST 原始消息：mes/is_user/is_system/name）
 * @param {object} [options]
 * @param {boolean} [options.showUserReplies=true] 是否保留 user 消息（false 时过滤 user，每条 char 单独成章）
 * @returns {Array<{index: number, messages: Array<object>}>} 章节数组（index 从 1 开始）
 */
export function splitChapters(messages, options = {}) {
  const { showUserReplies = true } = options;
  const chapters = [];
  let current = [];

  /** 封章：当前章非空则推入 chapters */
  const flush = () => {
    if (current.length) {
      chapters.push({ index: chapters.length + 1, messages: current });
      current = [];
    }
  };

  for (const mes of messages) {
    if (!mes) continue;
    const isUser = Boolean(mes.is_user);

    // 隐藏 user 回复：user 消息直接跳过
    if (!showUserReplies && isUser) continue;

    if (current.length === 0) {
      current.push(mes);
      continue;
    }

    const last = current[current.length - 1];
    const lastIsUser = Boolean(last.is_user);

    if (isUser) {
      // user 消息：若当前章最后已是 char（连续角色结束）→ 封章，user 前置到新章
      if (!lastIsUser) flush();
      current.push(mes);
    } else {
      // char 消息：若当前章最后已是 user → 合并（user+char 一章）；否则封章开新章
      if (lastIsUser) {
        current.push(mes);
      } else {
        flush();
        current.push(mes);
      }
    }
  }

  flush();
  return chapters;
}

/**
 * 从消息正文中提取自定义标签内的文字（用于「自动识别标题」）。
 * 例如 tag="zj" 时，`xxx<zj>第1章 序章</zj>yyy` → `第1章 序章`。
 * 规则：
 *   - 只取第一次出现的标签内容；标签名大小写不敏感
 *   - 支持标签带属性（如 <zj class="x">）
 *   - 找不到标签 → 返回空字符串（调用方回退到默认标题）
 *   - 标签内容两侧空白会被 trim，内容按原样保留（后续 escapeHtml 输出）
 * @param {string} text 消息正文（原始 Markdown/HTML 字符串）
 * @param {string} [tag="zj"] 标签名（不含尖括号）
 * @returns {string} 标签内文字；未匹配返回空字符串
 */
export function extractTagTitle(text, tag = "zj") {
  const t = String(text || "");
  if (!t) return "";
  const tagName = String(tag || "")
    .trim()
    .replace(/[<>\/]/g, ""); // 容错：去掉可能误输入的 < > /
  if (!tagName) return "";
  // 标签名转义正则元字符（如用户输入 b.t 之类），并忽略大小写
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 开标签允许属性；结束标签严格匹配；不跨行（. 不含 \n，正文中标签通常单行）
  const re = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${esc}>`, "i");
  const m = t.match(re);
  if (!m) return "";
  const inner = m[1] || "";
  return inner.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ""); // 去首尾空白/全角空格
}

// 数字通配：阿拉伯 / 全角 / 汉字数字（含 百千万亿 等位词）
const NUM_TOKEN = "[\\d０-９一二三四五六七八九十百千万零〇两]+";

/**
 * 把单条过滤模板转成正则（仅供 filterTitleText 内部使用）。
 * 模板规则：
 *   - 独立大写 N（两侧不是字母/数字/下划线）→ 任意数字通配（匹配 1 / 10 / 一百 / １２３）
 *   - 模板中的空白序列 → \s+（容忍标题里多个/不同类型的空白）
 *   - 其余字符按字面匹配（正则元字符已转义）
 * @param {string} template 单条过滤模板
 * @returns {RegExp|null} 内容为空或编译失败返回 null
 */
function templateToRegex(template) {
  const s = String(template || "").trim();
  if (!s) return null;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "N") {
      const prev = i > 0 ? s[i - 1] : "";
      const next = i < s.length - 1 ? s[i + 1] : "";
      if ((!prev || !/\w/.test(prev)) && (!next || !/\w/.test(next))) {
        out += NUM_TOKEN;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      out += "\\s+";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(out, "g");
  } catch {
    return null;
  }
}

/**
 * 从标题中移除指定文字（过滤文字，可多条，支持模板匹配）。
 * 每条规则：
 *   - 含「独立大写 N」→ 模板匹配：N 视为任意数字通配符（阿拉伯/全角/汉字数字），
 *     如 "Chapter N" 可过滤 "Chapter 1"、"Chapter 100"、"Chapter 一百"；
 *   - 不含 N → 保持纯字面删除（向后兼容）。
 * 过滤完成后统一清理多余空格，过滤结果为空时返回原标题（避免空副标题）。
 * @param {string} title 原始标题
 * @param {Array<string>} [filters=[]] 过滤规则列表（如 ["第一章：", "Chapter N"]）
 * @returns {string} 过滤后的标题
 */
export function filterTitleText(title, filters = []) {
  let t = String(title || "");
  if (!t) return t;
  const original = t;
  for (const f of filters) {
    const s = String(f || "").trim();
    if (!s) continue;
    if (/\bN\b/.test(s)) {
      // 模板含独立大写 N：按「任意数字」通配匹配并删除
      const re = templateToRegex(s);
      if (re) t = t.replace(re, "");
    } else {
      // 纯字面删除
      t = t.split(s).join("");
    }
  }
  // 清理过滤残留的多余空格；全部被删则保留原标题
  t = t.replace(/ +/g, " ").trim();
  return t || original;
}

/**
 * 剥离标题开头的「章号前缀」（如「第一章：」「第1章 」「第 100 章-」）。
 * 解决识别标题自带「第一章：章节名」与目录自带「第N章」重复的问题：
 * 无论章节数字是阿拉伯数字、全角数字还是汉字数字，均自动识别并剥离。
 * 例：
 *   「第一章：序章」        → 「序章」
 *   「第1章 风云起」        → 「风云起」
 *   「第 100 章-归途」      → 「归途」
 *   「第一百二十回·重逢」   → 「重逢」（章词含 回/卷/节/部/集）
 * 剥离后为空（标题只有「第一章」无后文）时返回原标题，避免空标题。
 * @param {string} title 识别出的标题
 * @returns {string} 剥离前缀后的标题
 */
export function stripChapterNumberPrefix(title) {
  const t = String(title || "").trim();
  if (!t) return t;
  // 第 + 数字（阿拉伯/全角/汉字）+ 章词 + 可选分隔符（冒号/点/空格/横线等）
  const re =
    /^第\s*[\d０-９一二三四五六七八九十百千万零〇两]+\s*[章回卷节部集][\s:：.。、\-—–|丨]*/;
  const stripped = t.replace(re, "").trim();
  return stripped || t;
}

/**
 * 生成章节显示标题（取章内第一条角色消息的说话人；无角色则取首条说话人）。
 * 若 options.tag 提供且章内消息正文包含该标签，则优先用标签内文字作为标题。
 * @param {{messages: Array<object>}} chapter 章节对象
 * @param {object} [options]
 * @param {string} [options.userName="你"] 用户显示名（说话人标签兜底）
 * @param {string} [options.fallback="无标题"] 无任何消息时的标题
 * @param {string} [options.tag=""] 自动识别标题标签名（空 = 不启用）；启用时优先取章内
 *   第一条角色消息正文中 <tag>...</tag> 内的文字作为标题
 * @returns {string} 章节标题（不含「第 N 章」前缀，前缀由调用方拼接）
 */
export function getChapterTitle(chapter, options = {}) {
  const { userName = "你", fallback = "无标题", tag = "" } = options;

  // 自动识别标题：从章内第一条「非 user 消息」的正文提取标签文字
  if (tag) {
    const firstTextMsg = chapter.messages.find(
      (m) => !m.is_user && String(m.mes || "").trim(),
    );
    if (firstTextMsg) {
      const extracted = extractTagTitle(firstTextMsg.mes, tag);
      if (extracted) return extracted;
    }
  }

  const firstChar = chapter.messages.find((m) => !m.is_user && !m.is_system);
  const first = chapter.messages[0];
  if (firstChar) return firstChar.name || fallback;
  if (first) return first.name || userName || fallback;
  return fallback;
}
