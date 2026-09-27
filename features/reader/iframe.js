// features/reader/iframe.js
// 小说正文内的「HTML 应用」渲染：把 AI 生成的 ```html 代码块以隔离 iframe 方式渲染，
// 支持复杂交互（脚本/事件/样式），且与主程序完全隔离（sandbox 不开放同源）。
//
// 原理：
//   1. renderTextBody 在 Markdown 渲染前调用 preprocessHtmlApps(text)：
//      提取 ```html ... ``` 代码块 → 替换为纯文本占位符（@@NOVEL_HTML_APP_0@@）。
//      占位符是纯字母数字，可穿透 showdown + DOMPurify 而不会被改动。
//   2. renderMarkdown 渲染 + sanitize 后调用 postprocessHtmlApps(html, apps)：
//      把占位符替换为 <div class="novel-html-app"><iframe sandbox="allow-scripts" srcdoc="...">。
//      srcdoc 内嵌「运行时主题同步」脚本：加载后向父页面 postMessage 汇报 ready + 自身高度。
//   3. bindHtmlAppMessages() 绑定窗口 message 监听：
//      收到 ready → 从阅读器根元素读取当前主题变量回传（bg/fg/accent/字号）；
//      收到高度 → 写回对应 iframe 的 height。
//      定位目标 iframe 一律用 e.source === frame.contentWindow 精确匹配
//      （多条消息的 data-html-app-id 会重复，不能用 id 全局查询）。
//   4. refreshHtmlAppThemes(rootEl) 在主题变化时（applyReaderStyles 后）向所有 iframe 广播新主题，
//      iframe 界面实时跟随阅读器主题，无需重载。
//
// 安全模型：
//   - iframe sandbox="allow-scripts"（无 allow-same-origin / allow-top-navigation）：
//     脚本可运行，但子页面是不透明源，无法读取/修改父页面 DOM，也无法读写父页面存储。
//     即使用户代码是恶意的，也最多只能在自己的 iframe 内捣乱，不影响主程序。
//   - srcdoc 内容经 escapeHtmlFallback 转义后写入属性，避免属性逃逸注入。

// 占位符前缀：纯字母数字 + 下划线，确保 showdown/DOMPurify 原样保留
const PLACEHOLDER_PREFIX = "@@NOVEL_HTML_APP_";

/** 转义 HTML 特殊字符（属性安全） */
function escapeHtmlFallback(str) {
  const AMP = "&" + "amp;";
  const QUOT = "&" + "quot;";
  return String(str ?? "")
    .replace(/&/g, AMP)
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, QUOT);
}

/**
 * 把 ```html ... ``` 代码块提取为占位符，返回 { text, apps }。
 * 占位符形式：@@NOVEL_HTML_APP_<n>@@（n 为序号）。
 * 只有标记为 html 的代码块会被提取；其它代码块（js/css 等）保持原样。
 * @param {string} text 原始 Markdown 文本
 * @returns {{ text: string, apps: Array<{code: string}> }}
 */
export function preprocessHtmlApps(text) {
  const apps = [];
  const processed = String(text ?? "").replace(
    /```\s*html[ \t]*\r?\n([\s\S]*?)(?:```|$)/gi,
    (match, code) => {
      const idx = apps.length;
      apps.push({ code });
      return `\n${PLACEHOLDER_PREFIX}${idx}@@\n`;
    },
  );
  return { text: processed, apps };
}

/**
 * 把占位符替换为 iframe 应用 HTML（在 sanitize 之后调用）。
 * 主题变量不在字符串阶段注入（此时 DOM 未挂载），改为运行时由
 * bindHtmlAppMessages 收到子页面 ready 后动态回传。
 * @param {string} html 已 sanitize 的正文 HTML
 * @param {Array<{code: string}>} apps preprocessHtmlApps 提取的代码块数组
 * @returns {string} 替换后的 HTML
 */
export function postprocessHtmlApps(html, apps) {
  if (!Array.isArray(apps) || apps.length === 0) return html;
  return String(html ?? "").replace(
    /<p>?\s*@@NOVEL_HTML_APP_(\d+)@@\s*<\/p>?|@@NOVEL_HTML_APP_(\d+)@@/g,
    (match, idx1, idx2) => {
      const idx = idx1 != null ? Number(idx1) : Number(idx2);
      const app = apps[idx];
      if (!app) return match;
      return buildIframeHtml(app.code, idx);
    },
  );
}

/**
 * 生成单个 HTML 应用的 iframe 片段。
 * srcdoc 内嵌运行时脚本：
 *   - 加载后向父页面 postMessage：{ type:"novel-html-app", id, action:"ready" }（随后汇报高度）
 *   - 监听父页面主题广播：{ type:"novel-html-app-theme", bg, fg, accent, fontSize } → 写入 :root CSS 变量
 *   - resize / 内容尺寸变化时重新汇报高度
 * @param {string} code 用户提供的 HTML/JS/CSS 源码
 * @param {number} id 应用序号（仅供日志/调试；消息定位按 e.source）
 * @returns {string} iframe HTML 字符串
 */
function buildIframeHtml(code, id) {
  // 子页面脚本：注意 </script> 必须写成 <\/script>，否则会提前闭合外层 srcdoc 属性字符串
  const runtimeScript = `
    (function () {
      var APP_ID = ${id};
      var lastReportedH = 0;
      function report(action) {
        var h = Math.ceil(document.documentElement.scrollHeight) + 2;
        // 高度变化小于阈值（4px）视为抖动/反馈循环，不重复汇报
        if (action === "height" && Math.abs(h - lastReportedH) < 4 && lastReportedH > 0) return;
        lastReportedH = h;
        parent.postMessage({ type: "novel-html-app", id: APP_ID, action: action || "height", height: h }, "*");
      }
      function applyTheme(t) {
        if (!t) return;
        var root = document.documentElement;
        if (t.bg) root.style.setProperty("--novel-bg", t.bg);
        if (t.fg) root.style.setProperty("--novel-fg", t.fg);
        if (t.accent) root.style.setProperty("--novel-accent", t.accent);
        if (t.fontSize) root.style.setProperty("--novel-font-size", t.fontSize);
      }
      window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d) return;
        if (d.type === "novel-html-app-theme") {
          applyTheme(d);
          report("height");
        } else if (d.type === "novel-html-app-poll") {
          report("height");
        }
      });
      window.addEventListener("load", function () {
        report("ready");
        setTimeout(function () { report("height"); }, 60);
      });
      window.addEventListener("resize", function () { report("height"); });
      if (document.readyState !== "loading") {
        setTimeout(function () { report("ready"); }, 30);
      }
      // 观察内容尺寸变化（子页面内 DOM 变化导致高度改变时自动同步）
      if (typeof ResizeObserver === "function") {
        try {
          var ro = new ResizeObserver(function () { report("height"); });
          ro.observe(document.body);
        } catch (err) {}
      }
    })();
  `;

  // 用户代码原样内联在 <body> 中，不要替换 </script。
  // 原因：把 </script 改成 <\/script 会破坏 HTML 解析器的脚本闭合识别
  // （<\/script 不是有效闭合标签），脚本区会延伸到 runtimeScript 末尾，
  // 用户 JS 与 runtime 合并成一个含非法 token 的大脚本，导致全部不执行。
  // srcdoc 属性层面已由 escapeHtmlFallback 转义（< > & "），属性逃逸已防护；
  // 解码后的文档中用户 <script>...</script> 正常配对，浏览器正确执行。
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --novel-bg: transparent;
    --novel-fg: inherit;
    --novel-accent: #7fb3a8;
    --novel-font-size: 16px;
  }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--novel-bg, transparent);
    color: var(--novel-fg, inherit);
    font-size: var(--novel-font-size, 16px);
    line-height: 1.6;
    /* 防止高度反馈循环：body 高度不跟随 iframe 高度联动 */
    overflow: clip;
  }
  * { box-sizing: border-box; }
</style>
</head>
<body>
${String(code ?? "")}
<script>${runtimeScript}<\/script>
</body>
</html>`;

  // srcdoc 属性必须转义（尤其双引号，防止属性逃逸）
  return `<div class="novel-html-app" data-html-app-id="${id}"><iframe
    class="novel-html-app-frame"
    sandbox="allow-scripts"
    srcdoc="${escapeHtmlFallback(srcdoc)}"></iframe></div>`;
}

/**
 * 读取阅读器根元素的当前主题变量（供回传给 iframe 子页面）。
 * @param {HTMLElement|null} rootEl 阅读器根元素（.novel-dialog）
 * @returns {{bg:string,fg:string,accent:string,fontSize:string}}
 */
function readThemeVars(rootEl) {
  const theme = { bg: "", fg: "", accent: "", fontSize: "" };
  if (rootEl) {
    try {
      // 字号实际应用在正文容器 .novel-reader-inner 上（applyReaderStyles 设置），
      // 优先从正文容器读取；主题变量（--novel-bg/--novel-fg/--novel-accent）定义在 dialog 上。
      const inner = rootEl.querySelector(".novel-reader-inner");
      const fontSizeEl = inner || rootEl;
      const cs = window.getComputedStyle(fontSizeEl);
      theme.fontSize = cs.fontSize;
      const csRoot = window.getComputedStyle(rootEl);
      theme.bg = csRoot.getPropertyValue("--novel-bg").trim();
      theme.fg = csRoot.getPropertyValue("--novel-fg").trim();
      theme.accent = csRoot.getPropertyValue("--novel-accent").trim();
    } catch (err) {
      // 忽略样式读取异常
    }
  }
  return theme;
}

/** 通过 e.source 精确定位发消息的 iframe 及其容器（避免 id 全局冲突）。 */
function findFrameBySource(source) {
  if (!source) return null;
  let found = null;
  document.querySelectorAll(".novel-html-app-frame").forEach((frame) => {
    if (!found && frame.contentWindow === source) found = frame;
  });
  return found;
}

/**
 * 向容器内所有 iframe 广播新主题（主题变化后调用，iframe 实时跟随）。
 * @param {HTMLElement|null} rootEl 阅读器根元素（读取主题变量用）
 * @param {HTMLElement|Document|null} scope 限定广播范围（默认整个文档）
 */
export function refreshHtmlAppThemes(rootEl, scope) {
  const theme = readThemeVars(rootEl);
  const root = scope || document;
  if (!root) return;
  root.querySelectorAll(".novel-html-app-frame").forEach((frame) => {
    try {
      frame.contentWindow?.postMessage(
        { type: "novel-html-app-theme", ...theme },
        "*",
      );
    } catch (err) {
      // 忽略跨域访问异常
    }
  });
}

/**
 * 绑定窗口 message 监听，处理 iframe 子页面回传的 ready / 高度消息。
 * 全局只绑一次。
 * @param {Window} win 目标窗口（默认当前 window）
 * @param {() => HTMLElement|null} getRootEl 返回阅读器根元素的函数（主题回传用）
 */
export function bindHtmlAppMessages(win, getRootEl) {
  const w = win || window;
  if (w._novelHtmlAppBound === true) return;
  w._novelHtmlAppBound = true;

  w.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || data.type !== "novel-html-app") return;
    // 按来源精确定位 iframe（多条消息的 data-html-app-id 会重复，不能用 id 全局查询）
    const frame = findFrameBySource(e.source);
    if (!frame) return;
    const container = frame.closest(".novel-html-app");
    if (!container) return;

    if (data.action === "ready") {
      // 子页面就绪：回传当前主题（触发首次高度同步）
      container.classList.add("novel-html-app-ready");
      const theme = readThemeVars(getRootEl ? getRootEl() : null);
      try {
        frame.contentWindow?.postMessage(
          { type: "novel-html-app-theme", ...theme },
          "*",
        );
      } catch (err) {
        // 忽略跨域访问异常
      }
      return;
    }

    // 高度回写：与当前值差异小于阈值（4px）视为反馈循环抖动，不重复写，
    // 避免触发子页面 ResizeObserver 再次汇报 → 无限循环。
    const height = Number(data.height);
    if (!Number.isFinite(height)) return;
    const target = Math.max(40, Math.ceil(height));
    const current = parseInt(frame.style.height, 10) || 0;
    if (current > 0 && Math.abs(target - current) < 4) return;
    frame.style.height = `${target}px`;
    container.classList.add("novel-html-app-ready");
  });
}

/**
 * 水合指定容器内所有 HTML 应用：确保全局 message 监听已绑定，
 * 并向已加载的 iframe 发送轮询（触发一次高度同步）。
 * @param {HTMLElement|null} root 容器（可为空）
 * @param {() => HTMLElement|null} getRootEl 返回阅读器根元素的函数
 */
export function hydrateHtmlApps(root, getRootEl) {
  bindHtmlAppMessages(window, getRootEl);
  if (root) {
    root.querySelectorAll(".novel-html-app-frame").forEach((frame) => {
      try {
        frame.contentWindow?.postMessage({ type: "novel-html-app-poll" }, "*");
      } catch (err) {
        // 忽略跨域访问异常
      }
    });
  }
}

/**
 * 判断一段文本是否包含 HTML 应用代码块（供设置开关预检）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasHtmlAppBlocks(text) {
  return /```\s*html[ \t]*\r?\n[\s\S]*?(?:```|$)/i.test(String(text ?? ""));
}
