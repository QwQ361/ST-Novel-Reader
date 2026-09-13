// 时间与文件大小格式化工具。

/**
 * 解析角色对象的创建时间，兼容多种可能的字段名。
 * @param {object} char 角色对象
 * @returns {number} 时间戳（毫秒），解析失败返回 0
 */
export function parseCharTime(char) {
  if (!char) return 0;
  const candidates = [
    char.create_date,
    char.created_at,
    char.create_time,
    char.date_created,
    char.date_modified,
    char.last_mes_at,
    char.timestamp,
  ];
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (!Number.isNaN(n)) return n;
    const d = new Date(String(c));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

/**
 * 格式化文件大小为人类可读的字符串。
 * @param {number} bytes 字节数
 * @returns {string} 如 "1.2 MB"
 */
export function formatFileSize(bytes) {
  if (bytes === undefined || bytes === null || Number.isNaN(Number(bytes)))
    return "";
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 将时间戳格式化为 "YYYY-MM-DD HH:mm"。
 * 使用 ST 的 timestampToMoment 时由调用方传入格式化函数；这里提供独立实现作为兜底。
 * @param {number} ts 时间戳（毫秒）
 * @returns {string} 格式化字符串，无效输入返回 ""
 */
export function formatTimestamp(ts) {
  if (!ts || Number.isNaN(Number(ts))) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

