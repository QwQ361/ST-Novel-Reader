// integrations/topbar-icon.js
// 顶栏按钮图标美化适配（参考 CFM ui/toolbar/buttons.js + integrations/theme-observer.js 精简版）：
//   检测邻居按钮（用户设定管理 #persona-management-button）的实际图标样式，
//   若美化主题用图片替换了邻居按钮图标，则让本插件顶栏按钮保持一致。
// 仅自动检测与适配（无设置面板）：用户无需干预，保持与其它顶栏按钮视觉统一。

/**
 * 判断 computed background-image 是否为真正的图片图标（排除 linear-gradient 等）。
 * @param {string} bgImage
 * @returns {boolean}
 */
export function isImageIconBackgroundCore(bgImage) {
  if (!bgImage || bgImage === "none" || bgImage === "") return false;
  return /\b(?:url|image-set)\(/i.test(bgImage);
}

/**
 * 从 CSS url(...) 字符串中提取原始 URL。
 * 兼容 url(https://a.png)、url("https://a.png")、url('https://a.png') 三种写法。
 * @param {string} cssUrl
 * @returns {string}
 */
export function extractUrlFromCssCore(cssUrl) {
  return String(cssUrl || "")
    .replace(/^url\(["']?/, "")
    .replace(/["']?\)$/, "");
}

/**
 * 将原始 URL 转为 CSS url(...) 字符串。
 * @param {string} url
 * @returns {string}
 */
export function toCssUrlCore(url) {
  return `url("${url}")`;
}

/**
 * 检测邻居按钮的实际图标样式（computed style，不解析 CSS 规则）。
 * 兼容三种实现：.drawer-icon 元素本身 / .drawer-toggle / ::before 伪元素。
 * @param {object} deps { document, window, isImageIconBackground }
 * @returns {{ cssUrl: string, target: string, styles: Object }|null}
 */
export function detectNeighborIconCore(deps) {
  for (const cls of [".drawer-icon", ".drawer-toggle"]) {
    const neighborIcon = deps.document.querySelector(
      `#persona-management-button ${cls}`,
    );
    if (!neighborIcon) continue;
    // 跳过打开状态的邻居按钮图标（openIcon 样式不同）
    if (cls === ".drawer-icon" && neighborIcon.classList.contains("openIcon")) {
      continue;
    }

    // 1) 元素本身的 background-image
    const computed = deps.window.getComputedStyle(neighborIcon);
    const bgImage = computed.backgroundImage;
    if (deps.isImageIconBackground(bgImage)) {
      const extraStyles = {};
      if (cls === ".drawer-toggle") {
        const w = computed.width;
        const h = computed.height;
        const bgSize = computed.backgroundSize;
        const bgRepeat = computed.backgroundRepeat;
        const bgPos = computed.backgroundPosition;
        const display = computed.display;
        const color = computed.color;
        if (w) extraStyles.width = w;
        if (h) extraStyles.height = h;
        if (bgSize) extraStyles.backgroundSize = bgSize;
        if (bgRepeat) extraStyles.backgroundRepeat = bgRepeat;
        if (bgPos) extraStyles.backgroundPosition = bgPos;
        if (display) extraStyles.display = display;
        if (color) extraStyles.color = color;
      }
      return { cssUrl: bgImage, target: cls, styles: extraStyles };
    }

    // 2) ::before 伪元素的 background-image
    const beforeComputed = deps.window.getComputedStyle(
      neighborIcon,
      "::before",
    );
    const beforeBgImage = beforeComputed.backgroundImage;
    if (deps.isImageIconBackground(beforeBgImage)) {
      const extraStyles = {};
      const w = beforeComputed.width;
      const h = beforeComputed.height;
      const bgSize = beforeComputed.backgroundSize;
      const bgRepeat = beforeComputed.backgroundRepeat;
      const bgPos = beforeComputed.backgroundPosition;
      if (w) extraStyles.width = w;
      if (h) extraStyles.height = h;
      if (bgSize) extraStyles.backgroundSize = bgSize;
      if (bgRepeat) extraStyles.backgroundRepeat = bgRepeat;
      if (bgPos) extraStyles.backgroundPosition = bgPos;
      return {
        cssUrl: beforeBgImage,
        target: cls + "::before",
        styles: extraStyles,
      };
    }
  }
  return null;
}

/**
 * 应用自定义图标到顶栏按钮（三种模式，先清理旧模式残留）。
 * @param {string} cssUrl CSS url() 格式图标
 * @param {string} [targetCls] ".drawer-icon" / ".drawer-toggle" / 含 "::before"
 * @param {Object} [extraStyles] 需复制的额外样式
 * @param {object} deps { $ }
 */
export function applyCustomIconCore(cssUrl, targetCls, extraStyles, deps) {
  const $ = deps.$;
  const icon = $("#novel-topbar-button .drawer-icon");
  if (icon.length === 0) return;

  // ★ 先统一清理旧模式残留
  icon.removeClass("novel-custom-icon-before");
  $("#novel-dynamic-icon-style").remove();
  icon.css("background-image", "");
  const toggle = $("#novel-topbar-button .drawer-toggle");
  if (toggle.length > 0) {
    toggle.removeClass("novel-custom-toggle-icon");
    toggle.css({
      "background-image": "",
      "background-repeat": "",
      "background-position": "",
      "background-size": "",
      width: "",
      height: "",
      color: "",
    });
  }

  icon.addClass("novel-custom-icon");
  const isPseudoBefore = targetCls && targetCls.includes("::before");

  if (isPseudoBefore) {
    // ::before 模式：注入动态 <style>，尺寸等属性由美化主题通用规则自然生效
    icon.addClass("novel-custom-icon-before");
    const styleEl = $(
      `<style id="novel-dynamic-icon-style">
          #novel-topbar-button .drawer-icon.novel-custom-icon-before::before {
            content: '' !important;
            display: block !important;
            background-image: ${cssUrl} !important;
          }
        </style>`,
    );
    $("head").append(styleEl);
  } else if (targetCls === ".drawer-toggle" && extraStyles) {
    // .drawer-toggle 模式：应用到 toggle 元素并复制尺寸/背景属性
    if (toggle.length > 0) {
      toggle.addClass("novel-custom-toggle-icon");
      if (!toggle.attr("title")) toggle.attr("title", "酒馆小说阅读器");
      toggle.css({
        "background-image": cssUrl,
        "background-repeat": extraStyles.backgroundRepeat || "no-repeat",
        "background-position": extraStyles.backgroundPosition || "center",
        "background-size": extraStyles.backgroundSize || "contain",
        width: extraStyles.width || "27px",
        height: extraStyles.height || "27px",
        color: "transparent",
      });
    }
  } else {
    // .drawer-icon 元素本身模式
    icon.css("background-image", cssUrl);
  }
}

/**
 * 清除自定义图标（恢复默认 FA 图标）。
 * @param {object} deps { $ }
 */
export function clearCustomIconCore(deps) {
  const $ = deps.$;
  const icon = $("#novel-topbar-button .drawer-icon");
  if (icon.length === 0) return;

  icon.removeClass("novel-custom-icon novel-custom-icon-before");
  icon.css("background-image", "");
  $("#novel-dynamic-icon-style").remove();
  const toggle = $("#novel-topbar-button .drawer-toggle");
  if (toggle.length > 0) {
    toggle.removeClass("novel-custom-toggle-icon");
    toggle.css({
      "background-image": "",
      "background-repeat": "",
      "background-position": "",
      "background-size": "",
      width: "",
      height: "",
      color: "",
    });
  }
}

/**
 * 扫描 styleSheets 收集美化主题注入的 URL 图标（供设置面板下拉选择）。
 * 策略1：遍历内联 <style> 规则（跳过外部 <link> 避免跨域异常）；
 * 策略2：computed style 检测所有已知顶栏按钮（兜底）。
 * @param {object} deps { document, window, isImageIconBackground }
 * @returns {{ icons: Object<string,string>, uniqueUrls: string[] }}
 *   icons: 按钮 id → url("...") 形式的 CSS 字符串
 *   uniqueUrls: 去重后的 CSS url 列表（下拉项预览用）
 */
export function detectThemeIconsCore(deps) {
  const iconMap = {};
  const gDoc = deps.document || document;
  const gWin = deps.window || window;

  // --- 策略1: 遍历内联 <style> 规则 ---
  for (const sheet of gDoc.styleSheets) {
    try {
      if (
        !sheet.ownerNode ||
        sheet.ownerNode.tagName?.toUpperCase() !== "STYLE"
      )
        continue;
      for (const rule of sheet.cssRules) {
        if (!rule.selectorText || !rule.style) continue;
        if (!deps.isImageIconBackground(rule.style.backgroundImage)) continue;
        const matches = rule.selectorText.matchAll(
          /#([\w-]+)(?:\s+|.*?)(?:\.drawer-icon|\.drawer-toggle)(?:::before)?/g,
        );
        for (const match of matches) {
          iconMap[match[1]] = rule.style.backgroundImage;
        }
      }
    } catch (e) {
      // 跨域样式表，跳过
    }
  }

  // --- 策略2: computed style 兜底检测已知顶栏按钮 ---
  const knownButtons = [
    "user-settings-button",
    "persona-management-button",
    "ai-config-button",
    "character-management-button",
    "world-info-button",
  ];
  for (const btnId of knownButtons) {
    if (iconMap[btnId]) continue;
    for (const cls of [".drawer-icon", ".drawer-toggle"]) {
      const iconEl = gDoc.querySelector(`#${btnId} ${cls}`);
      if (!iconEl) continue;
      if (cls === ".drawer-icon" && iconEl.classList.contains("openIcon")) {
        continue;
      }
      const computed = gWin.getComputedStyle(iconEl);
      const bgImage = computed.backgroundImage;
      if (deps.isImageIconBackground(bgImage)) {
        iconMap[btnId] = bgImage;
        break;
      }
      const beforeComputed = gWin.getComputedStyle(iconEl, "::before");
      const beforeBgImage = beforeComputed.backgroundImage;
      if (deps.isImageIconBackground(beforeBgImage)) {
        iconMap[btnId] = beforeBgImage;
        break;
      }
    }
  }

  const uniqueUrls = [...new Set(Object.values(iconMap))];
  return { icons: iconMap, uniqueUrls };
}

/**
 * 顶栏图标应用优先级编排：手动指定 URL > 自动检测邻居 > 默认 FA 图标。
 * @param {object} deps
 *   getSavedIcon: () => string  读取已保存的纯 URL（无则空串）
 *   detectNeighborIcon, applyCustomIcon, clearCustomIcon, toCssUrl
 */
export function applyTopbarIconFromConfigCore(deps) {
  const saved = deps.getSavedIcon?.() || "";
  if (saved) {
    // 用户手动指定了 URL → 包回 url("...") 后应用（直接应用到元素本身）
    deps.applyCustomIcon(deps.toCssUrl(saved));
    return true;
  }
  const result = deps.detectNeighborIcon();
  if (result) {
    deps.applyCustomIcon(result.cssUrl, result.target, result.styles);
    return true;
  }
  deps.clearCustomIcon();
  return false;
}

/**
 * 顶栏图标美化适配编排：初始检测应用 + 三策略自动监听（支持手动 URL 优先）。
 * @param {object} deps
 *   $, isImageIconBackground, detectNeighborIcon, applyCustomIcon, clearCustomIcon,
 *   applyTopbarIconFromConfig（可选，手动优先编排；缺省回退到纯自动检测）
 * @returns {{ start: Function, destroy: Function, detectAndApply: Function }}
 */
export function createTopbarIconAdaptorCore(deps) {
  let lastNeighborBg = null;
  let themeCheckTimer = null;

  /** 检测并应用（手动 URL 优先；无编排函数则纯自动） */
  function detectAndApply() {
    if (deps.applyTopbarIconFromConfig) {
      deps.applyTopbarIconFromConfig();
      return;
    }
    const result = deps.detectNeighborIcon();
    lastNeighborBg = result ? result.cssUrl : null;
    if (result) {
      deps.applyCustomIcon(result.cssUrl, result.target, result.styles);
    } else {
      deps.clearCustomIcon();
    }
  }

  /** 样式变化回调（邻居面板打开时跳过，避免读取打开态样式） */
  function onThemeStyleChange() {
    const neighborDrawerIcon = document.querySelector(
      "#persona-management-button .drawer-icon",
    );
    if (
      neighborDrawerIcon &&
      neighborDrawerIcon.classList.contains("openIcon")
    ) {
      return;
    }
    detectAndApply();
  }

  /** 启动自动监听（三大策略） */
  function setupThemeChangeObserver() {
    // 原生浏览器对象/方法必须用全局引用调用（deps 传入的会在跨模块传递时丢失 this）
    const gWin = window;
    const gDoc = document;
    const MutationObserverCtor = gWin.MutationObserver || gDoc.MutationObserver;
    const setTimeoutFn = (fn, ms) => gWin.setTimeout(fn, ms);
    const setIntervalFn = (fn, ms) => gWin.setInterval(fn, ms);
    const clearIntervalFn = (id) => gWin.clearInterval(id);

    // --- 策略1: MutationObserver 监听 <head> 中 STYLE/LINK 增删与内容变化 ---
    const headObserver = new MutationObserverCtor((mutations) => {
      let styleChanged = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of [
            ...mutation.addedNodes,
            ...mutation.removedNodes,
          ]) {
            if (
              node.nodeType === gDoc.defaultView?.Node?.ELEMENT_NODE ||
              node.nodeType === 1 /* Node.ELEMENT_NODE */
            ) {
              if (node.tagName === "STYLE" || node.tagName === "LINK") {
                styleChanged = true;
                break;
              }
            }
          }
        }
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode?.tagName === "STYLE"
        ) {
          styleChanged = true;
        }
      }
      if (styleChanged) {
        // 延迟执行，等浏览器完成样式计算
        setTimeoutFn(() => onThemeStyleChange(), 300);
      }
    });
    headObserver.observe(gDoc.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // --- 策略2: 监听 #custom-style 内容变化 ---
    const customStyle = gDoc.getElementById("custom-style");
    if (customStyle) {
      const customObserver = new MutationObserverCtor(() => {
        setTimeoutFn(() => onThemeStyleChange(), 300);
      });
      customObserver.observe(customStyle, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    // --- 策略3: 每 2s 轮询邻居按钮样式（兜底） ---
    detectAndApply();
    themeCheckTimer = setIntervalFn(() => {
      if (deps.applyTopbarIconFromConfig) {
        // 手动优先编排：内部读取已保存 URL，非空则不覆盖用户选择
        detectAndApply();
        return;
      }
      const neighborDrawerIcon = gDoc.querySelector(
        "#persona-management-button .drawer-icon",
      );
      if (
        neighborDrawerIcon &&
        neighborDrawerIcon.classList.contains("openIcon")
      ) {
        return; // 邻居面板打开中，跳过
      }
      const result = deps.detectNeighborIcon();
      const currentBg = result ? result.cssUrl : null;
      if (currentBg !== lastNeighborBg) {
        lastNeighborBg = currentBg;
        onThemeStyleChange();
      }
    }, 2000);
  }

  /** 启动（延迟 500ms 等美化主题样式加载完成） */
  function start() {
    window.setTimeout(() => {
      setupThemeChangeObserver();
    }, 500);
  }

  function destroy() {
    if (themeCheckTimer) {
      window.clearInterval(themeCheckTimer);
      themeCheckTimer = null;
    }
  }

  return { start, destroy, detectAndApply };
}
