// integrations/theme-text.js
// 主题文本样式桥接：让美化主题对引号/星号等特殊文字效果（em/strong/引号伪元素/blockquote 等）
// 同样作用于小说阅读器的正文（.novel-msg-body）。
//
// 原理：美化主题把特殊效果写在 CSS 选择器里，作用于 ST 聊天区（#chat .mes .mes_text em 等）。
// 小说阅读器用自有 class（.novel-msg-body），主题选择器不命中 → 效果丢失。
// 本模块扫描美化主题注入的内联 <style> 规则，把「命中聊天文本元素」的选择器改写为
// .novel-msg-body 对应结构，动态注入 <style id="novel-theme-text-bridge">，
// 并监听主题变化自动刷新（复用顶栏图标的 MutationObserver 策略）。
//
// 安全：只复制「选择器 + 声明块」，且只改写聊天文本上下文；不解析/执行任何 JS。

/**
 * 判断选择器是否命中 ST 聊天区文本元素。
 * 命中条件（满足其一）：
 *   1) 选择器含聊天文本上下文：.mes_text / .mes-text / .mes__text / #chat .mes / .mes p / .mes
 *   2) 选择器尾部目标是聊天文本元素：em / strong / blockquote / q / code / .quote / .ql-editor
 *
 * 注意：尾部 em / strong 等只有在选择器**已含聊天文本上下文**时才可信。
 * 例如 #chat .mes_swipe em（滑动按钮）尾部是 em 但不含 .mes_text，
 * 其 .mes 上下文其实是 .mes_swipe，不应桥接 → 需要上下文已命中。
 * 而 .ql-editor / .quote 这类专属于聊天文本的尾部元素，无上下文也可桥接。
 * @param {string} selector
 * @returns {boolean}
 */
export function isChatTextSelectorCore(selector) {
  if (!selector) return false;
  // 聊天文本容器标记（词边界避免 .mes_text_button / .mes_swipe 误伤）
  const chatCtx =
    /(?:\.mes_text(?![-\w])|\.mes-text(?![-\w])|\.mes__text(?![-\w])|\.mes(?!sage|_)\b)/.test(
      selector,
    );
  // 专属聊天文本的尾部元素（q / .ql-editor / .quote 仅在聊天文本中出现）
  const exclusiveTail =
    /(?:^|[\s>+~])(?:q|\.quote|\.ql-editor)(?:::before|::after|:before|:after)?(?:\s|,|$)/.test(
      selector,
    );
  // em / strong / blockquote / code 需要聊天文本上下文才可信
  const commonTail =
    chatCtx &&
    /(?:^|[\s>+~])(?:em|strong|blockquote|code)(?:::before|::after|:before|:after)?(?:\s|,|$)/.test(
      selector,
    );
  return chatCtx || exclusiveTail || commonTail;
}

/**
 * 判断选择器尾部是否为聊天文本元素（em / strong / blockquote / q / code / .quote / .ql-editor，
 * 含 ::before / ::after 伪元素）。用于区分「内联文字特效」规则与「容器级基础样式」规则。
 * 与 isChatTextSelectorCore 共用语义：仅当聊天文本上下文已命中时才判定为「内联特效」。
 * @param {string} selector
 * @returns {boolean}
 */
export function isTailChatTextElementCore(selector) {
  if (!selector) return false;
  if (
    !isChatTextSelectorCore(selector) &&
    !/(?:\.mes_text(?![-\w])|\.mes-text(?![-\w])|\.mes__text(?![-\w])|\.mes(?!sage|_)\b)/.test(
      selector,
    )
  ) {
    return false;
  }
  return /(?:^|[\s>+~])(?:em|strong|blockquote|q|code|\.quote|\.ql-editor)(?:::before|::after|:before|:after)?(?:\s|,|$)/.test(
    selector,
  );
}

/**
 * 去掉声明块中与阅读器主题冲突的容器级样式（color / background / background-color）。
 * 仅用于「容器级基础样式」规则（如 .mes_text { color: ... }）；内联特效规则保留全部声明。
 * @param {string} cssText 如 "color: white; font-family: serif;"
 * @returns {string} 过滤后的声明块（可能为空串）
 */
export function stripConflictingDeclsCore(cssText) {
  const kept = String(cssText)
    .split(";")
    .map((d) => d.trim())
    .filter(
      (d) =>
        d &&
        !/^color\s*:/i.test(d) &&
        !/^background(-color)?\s*:/i.test(d),
    );
  // 与浏览器 cssText 输出一致：保留末尾分号
  return kept.length ? kept.join("; ") + ";" : "";
}

/**
 * 将 ST 聊天区选择器改写为 .novel-msg-body 对应结构。
 * 替换规则（按优先级）：
 *   #chat .mes .mes_text → .novel-msg-body
 *   .mes_text / .mes-text / .mes__text → .novel-msg-body
 *   #chat .mes → .novel-msg-body
 *   .mes → .novel-msg-body
 * 替换后保留尾部元素选择器（em/em::before 等）。
 * @param {string} selector
 * @returns {string} 改写后的选择器（可能含多个，以逗号分隔）
 */
export function rewriteSelectorCore(selector) {
  return String(selector)
    .split(",")
    .map((part) => {
      let s = part.trim();
      // 1) 完整上下文链 #chat .mes .mes_text（含 .mes__text / .mes-text 变体）
      s = s.replace(
        /#chat\s+\.mes[^\s,>+~]*\s+\.mes_text/g,
        ".novel-msg-body",
      );
      s = s.replace(
        /#chat\s+\.mes[^\s,>+~]*\s+\.mes-text/g,
        ".novel-msg-body",
      );
      // 2) 独立 .mes_text / .mes-text / .mes__text（词边界，避免 .mes_text_button 误伤）
      s = s.replace(/\.mes_text(?![-\w])|\.mes-text(?![-\w])|\.mes__text(?![-\w])/g, ".novel-msg-body");
      // 3) #chat .mes / #chat .mes_text 等（.mes 变体；此时 .mes_text 已替换，
      //    故处理 #chat 后紧跟任意 .mes 前缀的情况，但排除 .mes_swipe 等其它变体）
      s = s.replace(/#chat\s+\.mes(?!sage|_)/g, ".novel-msg-body");
      // 4) 单独 .mes（可能是 .mes p em 中的 .mes；排除 .message/.mes_text/.mes_swipe 误伤）
      s = s.replace(/(^|[\s>+~])\.mes(?!sage|_)(?=[\s>+~.,:])/g, "$1.novel-msg-body");
      // 5) 残留的聊天根前缀（body / #chat / .mes 容器）剥掉，让 .novel-msg-body 成为根
      s = s.replace(/^(?:body|html|#chat)\s+/i, "");
      // 6) 处理多个 .novel-msg-body 连续出现（去重，如 .novel-msg-body .novel-msg-body）
      s = s.replace(/(?:\.novel-msg-body\s*){2,}/g, ".novel-msg-body ");
      return s.trim();
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * 从所有可读样式表收集可桥接的规则（美化主题聊天文本特效）。
 * 支持：
 *   - 内联 <style>（美化插件注入）
 *   - 同源 <link rel="stylesheet">（ST 官方 style.css 的 .mes_text em/q 变色等）
 * 跨域 <link> 读取会抛异常 → try/catch 跳过。
 *
 * 只桥接「内联文字特效」规则（选择器尾部是 em/strong/q/blockquote/code 等聊天文本元素），
 * 容器级基础样式（.mes_text { line-height... }）跳过，避免覆盖阅读器自己的排版。
 * @param {object} deps { document }
 * @returns {string[]} 改写后的 cssText 数组（选择器已换为 .novel-msg-body 上下文）
 */
export function collectBridgeRulesCore(deps) {
  const gDoc = deps.document || document;
  const rules = [];

  for (const sheet of gDoc.styleSheets) {
    try {
      // 读取 cssRules：内联 style 与同源 link 均可读；跨域 link 在此抛异常被捕获
      for (const rule of sheet.cssRules) {
        if (!rule.selectorText || !rule.style) continue;
        // 只桥接聊天文本选择器
        if (!isChatTextSelectorCore(rule.selectorText)) continue;
        // 只桥接「内联文字特效」规则；容器级基础样式跳过（阅读器已有排版）
        if (!isTailChatTextElementCore(rule.selectorText)) continue;
        const rewritten = rewriteSelectorCore(rule.selectorText);
        if (!rewritten || rewritten === rule.selectorText) continue;
        // 只保留改写后与阅读器正文相关的分段（丢弃 .mes_reasoning 等伴生选择器：
        // 它们对聊天区有效，但对 .novel-msg-body 无意义，且会污染桥接样式）
        const keptParts = rewritten
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.includes(".novel-msg-body"));
        if (!keptParts.length) continue;
        const cleanRewritten = keptParts.join(", ");
        // 保留声明块（cssText 含选择器，需去掉原选择器部分）
        const decl = rule.style.cssText;
        if (!decl) continue;
        rules.push(`${cleanRewritten} { ${decl} }`);
      }
    } catch (err) {
      // 跨域样式表 / 无权限规则，跳过
    }
  }

  return rules;
}

/**
 * 将桥接规则写入动态 <style>（重建）。
 * @param {object} deps { document }
 * @param {string[]} rules 桥接 cssText 数组
 * @returns {HTMLElement|null} 注入的 style 元素
 */
export function injectBridgeStyleCore(deps, rules) {
  const gDoc = deps.document || document;
  const old = gDoc.getElementById("novel-theme-text-bridge");
  if (old) old.remove();
  if (!rules || rules.length === 0) return null;

  const styleEl = gDoc.createElement("style");
  styleEl.id = "novel-theme-text-bridge";
  styleEl.textContent = rules.join("\n");
  gDoc.head.appendChild(styleEl);
  return styleEl;
}

/**
 * 创建主题文本桥接编排：初始扫描注入 + 监听主题变化自动刷新。
 * @param {object} deps { document }
 * @returns {{ start: Function, destroy: Function, refresh: Function }}
 */
export function createThemeTextBridgeCore(deps) {
  const gDoc = deps.document || document;
  let observer = null;
  let timer = null;
  let enabled = true; // 桥接开关：选中内置主题时关闭（引号/星号改用主题自带变量）

  /** 刷新桥接样式（重新扫描 + 重建注入） */
  function refresh() {
    try {
      if (!enabled) {
        // 关闭状态：移除已注入的桥接样式，让内置主题的 --novel-* 特效变量生效
        const old = gDoc.getElementById("novel-theme-text-bridge");
        if (old) old.remove();
        return;
      }
      const rules = collectBridgeRulesCore({ document: gDoc });
      injectBridgeStyleCore({ document: gDoc }, rules);
    } catch (err) {
      console.warn("[NovelReader] 主题文本样式桥接刷新失败:", err);
    }
  }

  /** 启用/禁用桥接（禁用时移除注入样式） */
  function setEnabled(value) {
    enabled = !!value;
    refresh();
  }

  /** 启动监听（延迟等待美化主题加载） */
  function start() {
    // 原生对象必须用全局引用（Illegal invocation 防护）
    const gWin = window;
    const MutationObserverCtor =
      gWin.MutationObserver || gDoc.defaultView?.MutationObserver;
    if (!MutationObserverCtor) {
      refresh();
      return;
    }

    const schedule = () => {
      if (timer) gWin.clearTimeout(timer);
      timer = gWin.setTimeout(() => {
        timer = null;
        refresh();
      }, 300);
    };

    // 监听 <head> 样式增删（美化主题切换时）
    observer = new MutationObserverCtor((mutations) => {
      let changed = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of [
            ...mutation.addedNodes,
            ...mutation.removedNodes,
          ]) {
            if (
              node.nodeType === 1 /* Node.ELEMENT_NODE */ &&
              (node.tagName === "STYLE" || node.tagName === "LINK")
            ) {
              changed = true;
              break;
            }
          }
        }
        if (
          mutation.type === "characterData" &&
          mutation.target.parentNode?.tagName === "STYLE"
        ) {
          changed = true;
        }
      }
      if (changed) schedule();
    });
    observer.observe(gDoc.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // 初始刷新
    refresh();
  }

  function destroy() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  return { start, destroy, refresh, setEnabled };
}
