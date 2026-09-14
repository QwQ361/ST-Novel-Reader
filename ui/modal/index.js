// ui/modal/index.js
// 通用弹窗构建器。
// 移动端铁律（详见 MOBILE-POPUP-FIX.md）：
//   1) overlay 一律不加 overflow（WebView fixed+overflow flex bug）
//   2) 移动端媒体查询放 style.css 文件末尾
//   3) 弹窗容器用 margin:auto
//   4) 高度用 100vh
// 实现用纯 DOM（不依赖 ST 的 getContext().createPopperModal），CSS 类统一 novel- 前缀。

/**
 * 使 handleEl 可拖动 dialog（悬浮窗移动）。
 * 拖动时排除按钮/输入框/选择器等交互元素，避免误触；窗口不超出视口。
 * 也会给 handleEl 加上 .novel-dialog-float-drag 类（移动端媒体查询会禁用拖动 cursor）。
 * @param {HTMLElement} dialog
 * @param {HTMLElement} handleEl
 */
export function makeDraggable(dialog, handleEl) {
  if (!dialog || !handleEl) return;
  handleEl.classList.add("novel-dialog-float-drag");
  let drag = null;
  handleEl.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, select, textarea, .interactable")) return;
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: dialog.offsetLeft,
      origTop: dialog.offsetTop,
    };
    try {
      handleEl.setPointerCapture(e.pointerId);
    } catch {}
    e.preventDefault();
  });
  handleEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const left = Math.min(
      Math.max(drag.origLeft + (e.clientX - drag.startX), 0),
      window.innerWidth - dialog.offsetWidth,
    );
    const top = Math.min(
      Math.max(drag.origTop + (e.clientY - drag.startY), 0),
      window.innerHeight - dialog.offsetHeight,
    );
    dialog.style.left = `${left}px`;
    dialog.style.top = `${top}px`;
  });
  const endDrag = (e) => {
    drag = null;
    try {
      handleEl.releasePointerCapture(e.pointerId);
    } catch {}
  };
  handleEl.addEventListener("pointerup", endDrag);
  handleEl.addEventListener("pointercancel", endDrag);
}

/**
 * 创建通用遮罩弹窗。
 * @param {object} options
 * @param {string} [options.title] 标题
 * @param {boolean} [options.backdropClose=true] 点击遮罩是否关闭
 *        （悬浮窗模式可被置顶运行时关闭，见 togglePinOnOverlay）
 * @param {boolean} [options.showClose=true] 是否显示右上角关闭按钮
 * @param {boolean} [options.compact=false] 紧凑弹窗（小尺寸、居中、可滚动内容），用于设置类小弹窗
 * @param {boolean} [options.floating=false] 悬浮窗模式：半透明遮罩 + 固定尺寸可拖动/可缩放窗口
 *        （标题栏拖动移动，右下角手柄缩放；移动端由媒体查询强制全屏，见 style.css 末尾）
 * @param {object} [options.floatingRect] 悬浮窗上次保存的 {w,h,x,y}；提供则在打开时恢复大小与位置
 * @param {Function} [options.onFloatingRect] (rect:{w,h,x,y}) => void 拖动/缩放结束时回调，用于持久化
 * @returns {{ overlay: HTMLElement, dialog: HTMLElement, content: HTMLElement, close: Function, onClose: Function, setPinned: Function }}
 */
export function createOverlayDialog(options = {}) {
  const {
    title = "",
    backdropClose = true,
    showClose = true,
    compact = false,
    floating = false,
    floatingRect = null,
    onFloatingRect = null,
  } = options;

  const overlay = document.createElement("div");
  overlay.className =
    "novel-overlay" +
    (compact ? " novel-overlay-compact" : "") +
    (floating ? " novel-overlay-floating" : "");
  overlay.dataset.novelOverlay = "";

  const dialog = document.createElement("div");
  dialog.className =
    "novel-dialog" +
    (compact ? " novel-dialog-compact" : "") +
    (floating ? " novel-dialog-floating" : "");

  // 仅在有标题或需要关闭按钮时才渲染 header（避免全屏弹窗出现空标题条）
  const content = document.createElement("div");
  content.className = "novel-dialog-content";

  let header = null;
  if (title || showClose) {
    header = document.createElement("div");
    header.className = "novel-dialog-header";
    if (title) {
      const titleEl = document.createElement("span");
      titleEl.className = "novel-dialog-title";
      titleEl.textContent = title;
      header.appendChild(titleEl);
    }
    if (showClose) {
      const closeBtn = document.createElement("div");
      closeBtn.className = "novel-dialog-close interactable";
      closeBtn.title = "关闭";
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", () => close());
      header.appendChild(closeBtn);
    }
    dialog.appendChild(header);
  }

  dialog.appendChild(content);
  overlay.appendChild(dialog);

  /** 关闭回调（由调用方覆盖） */
  let onClose = () => {};

  function close() {
    overlay.remove();
    onClose();
  }

  // 置顶状态（悬浮窗）：置顶后点击遮罩不再关闭，仅可主动关闭。
  // 用 overlay 的 dataset 标记，遮罩点击处理器运行时读取，免闭包同步。
  overlay.dataset.novelPinned = "";

  /** 切换置顶状态：置顶时点遮罩不关闭，且遮罩透明 + 点击穿透（可正常使用悬浮窗外页面）。
   *  @param {boolean} pinned */
  function setPinned(pinned) {
    overlay.dataset.novelPinned = pinned ? "1" : "";
    overlay.classList.toggle("novel-overlay-pinned", !!pinned);
  }

  if (backdropClose) {
    overlay.addEventListener("click", (e) => {
      if (e.target !== overlay) return;
      if (overlay.dataset.novelPinned === "1") return; // 置顶：点遮罩不关闭
      close();
    });
  }

  // ---- 悬浮窗模式：居中定位（或恢复上次大小位置）+ 标题栏拖动 + 右下角缩放 ----
  if (floating) {
    const vw = () => window.innerWidth;
    const vh = () => window.innerHeight;
    const minW = 360;
    const minH = 240;
    // 恢复上次保存的大小与位置；未保存或越界则居中初始化。
    // 移动端（窄视口）初始窗口更小（92vw × 56vh），避免一打开就近全屏、看不到拖拽手柄
    const mobile = vw() <= 900;
    let initW = Math.min(mobile ? 640 : 880, vw() * (mobile ? 0.92 : 0.92));
    let initH = Math.min(mobile ? 420 : 620, vh() * (mobile ? 0.56 : 0.88));
    let initX = (vw() - initW) / 2;
    let initY = (vh() - initH) / 2;
    if (floatingRect && floatingRect.w > 0 && floatingRect.h > 0) {
      const savedW = Math.max(floatingRect.w, minW);
      const savedH = Math.max(floatingRect.h, minH);
      // 移动端额外限制上限（此前全屏时期可能保存过 100vw×100vh 的旧几何，避免恢复后仍全屏）
      const capW = mobile ? vw() * 0.98 : vw();
      const capH = mobile ? vh() * 0.7 : vh();
      initW = Math.min(savedW, capW);
      initH = Math.min(savedH, capH);
      // 位置越界（分辨率变化/窗口调整）时回退到左上安全区域
      initX = Math.min(Math.max(floatingRect.x ?? 0, 0), Math.max(vw() - initW, 0));
      initY = Math.min(Math.max(floatingRect.y ?? 0, 0), Math.max(vh() - initH, 0));
    }
    dialog.style.width = `${initW}px`;
    dialog.style.height = `${initH}px`;
    dialog.style.left = `${initX}px`;
    dialog.style.top = `${initY}px`;

    // 拖动/缩放结束时把最新几何信息交回调用方持久化
    const reportRect = () => {
      if (typeof onFloatingRect === "function") {
        onFloatingRect({
          w: Math.round(dialog.offsetWidth),
          h: Math.round(dialog.offsetHeight),
          x: Math.round(dialog.offsetLeft),
          y: Math.round(dialog.offsetTop),
        });
      }
    };

    // 拖动：仅标题栏（点击关闭按钮不触发）
    if (header) {
      header.classList.add("novel-dialog-float-drag");
      let drag = null;
      header.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".novel-dialog-close")) return;
        drag = {
          startX: e.clientX,
          startY: e.clientY,
          origLeft: dialog.offsetLeft,
          origTop: dialog.offsetTop,
        };
        try {
          header.setPointerCapture(e.pointerId);
        } catch {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const left = Math.min(
          Math.max(drag.origLeft + (e.clientX - drag.startX), 0),
          vw() - dialog.offsetWidth,
        );
        const top = Math.min(
          Math.max(drag.origTop + (e.clientY - drag.startY), 0),
          vh() - dialog.offsetHeight,
        );
        dialog.style.left = `${left}px`;
        dialog.style.top = `${top}px`;
      });
      const endDrag = (e) => {
        drag = null;
        try {
          header.releasePointerCapture(e.pointerId);
        } catch {}
        reportRect();
      };
      header.addEventListener("pointerup", endDrag);
      header.addEventListener("pointercancel", endDrag);
    }

    // 缩放：右下角手柄
    const handle = document.createElement("div");
    handle.className = "novel-dialog-resize-handle";
    handle.title = "拖动调整大小";
    dialog.appendChild(handle);

    let resize = null;
    handle.addEventListener("pointerdown", (e) => {
      resize = {
        startX: e.clientX,
        startY: e.clientY,
        origW: dialog.offsetWidth,
        origH: dialog.offsetHeight,
      };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resize) return;
      const minW = 360;
      const minH = 240;
      const w = Math.min(
        Math.max(resize.origW + (e.clientX - resize.startX), minW),
        vw() - dialog.offsetLeft,
      );
      const h = Math.min(
        Math.max(resize.origH + (e.clientY - resize.startY), minH),
        vh() - dialog.offsetTop,
      );
      dialog.style.width = `${w}px`;
      dialog.style.height = `${h}px`;
    });
    const endResize = (e) => {
      resize = null;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
      reportRect();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
  }

  document.body.appendChild(overlay);
  return {
    overlay,
    dialog,
    content,
    close,
    setPinned,
    set onClose(fn) {
      onClose = fn;
    },
  };
}

/**
 * 创建选择对话框（带若干按钮）。
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.message]
 * @param {Array<{label: string, value: any, primary?: boolean}>} options.choices
 * @param {Function} [options.onSelect] (value) => void
 * @returns {{ dialog: HTMLElement, close: Function }}
 */
export function createChoiceDialog(options = {}) {
  const {
    title = "",
    message = "",
    choices = [],
    onSelect = () => {},
  } = options;
  const dlg = createOverlayDialog({ title, backdropClose: false });
  const content = dlg.content;

  if (message) {
    const p = document.createElement("div");
    p.className = "novel-dialog-message";
    p.textContent = message;
    content.appendChild(p);
  }

  const btnRow = document.createElement("div");
  btnRow.className = "novel-dialog-actions";
  choices.forEach((ch) => {
    const btn = document.createElement("div");
    btn.className = `novel-btn${ch.primary ? " novel-btn-primary" : ""}`;
    btn.textContent = ch.label;
    btn.addEventListener("click", () => {
      dlg.close();
      onSelect(ch.value);
    });
    btnRow.appendChild(btn);
  });
  content.appendChild(btnRow);

  return { dialog: dlg.dialog, close: dlg.close };
}
