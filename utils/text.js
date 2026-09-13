// 文本工具层：承接 escapeHtml、名称规范化、聊天文件名处理等无业务语义的文本辅助函数。

/**
 * HTML 转义，防止 XSS。用于任何插入 DOM 的动态文本内容。
 * @param {string} str 原始文本
 * @returns {string} 转义后的安全文本
 */
export function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\x26quot;");
}

/**
 * 去掉聊天文件名的 .jsonl 扩展名。
 * @param {string} fileName 聊天文件名（如 "chat-123.jsonl"）
 * @returns {string} 不带扩展名的文件名（如 "chat-123"）
 */
export function splitChatlogFileName(fileName) {
  return String(fileName || "").replace(/\.jsonl$/i, "");
}

/**
 * 截断过长的文本，用于列表展示。
 * @param {string} str 原始文本
 * @param {number} maxLen 最大长度
 * @returns {string} 截断后的文本（尾部加 …）
 */
export function truncateText(str, maxLen = 60) {
  if (!str) return "";
  const s = String(str);
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}
