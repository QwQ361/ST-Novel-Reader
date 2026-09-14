// utils/theme.js
// 主题色采样：从 ST 主界面实际 DOM 采样背景/文字色，
// 让弹窗（尤其正文阅读页）跟随酒馆美化主题的实际渲染效果。
//
// 背景：美化主题通常把颜色直接作用于 body / #chat / .mes 等具体元素，
// 不一定更新 --SmartTheme* 变量。若弹窗只用 var(--SmartTheme*)，
// 在未覆盖这些变量的美化主题下会显示默认色，与主题不协调。
// 因此从真实 DOM 采样 computed style，写入 CSS 变量 --novel-bg / --novel-fg，
// style.css 各元素优先用这组变量（带 --SmartTheme* 回退）。

/**
 * 判断颜色是否完全不透明。
 * - "#hex" / "rgb(...)" / 命名色 → 视为不透明
 * - "rgba(...)" / "hsla(...)" → 解析 alpha，仅当 ≥0.999 视为不透明
 * 半透明背景（如玻璃拟态主题）会被跳过，避免采样到半透明色导致悬浮窗窗口透底。
 */
function isOpaqueColor(c) {
  if (!c || c === "transparent") return false;
  if (c.startsWith("rgba") || c.startsWith("hsla")) {
    const m = c.match(/[\d.]+\)\s*$/);
    if (!m) return false;
    return parseFloat(m[0]) >= 0.999;
  }
  return true;
}

/** 从元素及其祖先中取第一个完全不透明背景色（rgba 字符串） */
function firstOpaqueBg(el) {
  let node = el;
  while (node && node !== document.documentElement) {
    try {
      const c = getComputedStyle(node).backgroundColor;
      if (isOpaqueColor(c)) return c;
    } catch (err) {
      // 忽略样式读取异常
    }
    node = node.parentElement;
  }
  return "";
}

/** 取元素的文字色（rgba 字符串），失败/透明则返回空 */
function firstColor(el) {
  try {
    const c = getComputedStyle(el).color;
    if (c && c !== "transparent") return c;
  } catch (err) {
    // 忽略样式读取异常
  }
  return "";
}

/**
 * 采样 ST 主界面实际渲染色。
 * @returns {{ bg: string, fg: string } | null}
 *   bg 页面背景色（#chat → body 链式查找），fg 页面文字色（#chat → body）
 */
export function sampleStThemeCore() {
  const doc = document;
  const chat = doc.querySelector("#chat");
  const body = doc.body;

  // 背景：优先 #chat 及其祖先链的第一个非透明背景；兜底 body 背景
  let bg = chat ? firstOpaqueBg(chat) : "";
  if (!bg) bg = firstOpaqueBg(body);

  // 文字色：优先 #chat，兜底 body
  let fg = chat ? firstColor(chat) : "";
  if (!fg) fg = firstColor(body);

  if (!bg && !fg) return null;
  return { bg, fg };
}

/**
 * 返回一个「保证不透明」的背景色：
 * 优先用传入色，其次 ST 主题不透明变量，最后默认暗色。
 * 用于悬浮窗/弹窗在跟随酒馆时避免透底（半透明背景会被跳过）。
 * @param {string|undefined} sampledBg 采样到的背景色
 * @returns {string}
 */
export function resolveOpaqueBg(sampledBg) {
  if (isOpaqueColor(sampledBg)) return sampledBg;
  try {
    const st = getComputedStyle(document.body)
      .getPropertyValue("--SmartThemeBlurTintColor")
      .trim();
    if (isOpaqueColor(st)) return st;
  } catch (err) {
    // 忽略样式读取异常
  }
  return "#14161a";
}

/**
 * 将采样主题色写入目标元素的 CSS 变量（--novel-bg / --novel-fg）。
 * @param {HTMLElement|null} target 应用目标（如 .novel-dialog）
 * @param {{ bg: string, fg: string } | null} colors 采样结果
 */
export function applyThemeCore(target, colors) {
  if (!target) return;
  const t = target.style;
  if (colors?.bg) {
    t.setProperty("--novel-bg", colors.bg);
  } else {
    t.removeProperty("--novel-bg");
  }
  if (colors?.fg) {
    t.setProperty("--novel-fg", colors.fg);
  } else {
    t.removeProperty("--novel-fg");
  }
}
