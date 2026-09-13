// ui/modal/index.js
// 通用弹窗构建器。
// 移动端铁律（详见 MOBILE-POPUP-FIX.md）：
//   1) overlay 一律不加 overflow（WebView fixed+overflow flex bug）
//   2) 移动端媒体查询放 style.css 文件末尾
//   3) 弹窗容器用 margin:auto
//   4) 高度用 100vh
// 实现用纯 DOM（不依赖 ST 的 getContext().createPopperModal），CSS 类统一 novel- 前缀。

/**
 * 创建通用遮罩弹窗。
 * @param {object} options
 * @param {string} [options.title] 标题
 * @param {boolean} [options.backdropClose=true] 点击遮罩是否关闭
 * @param {boolean} [options.showClose=true] 是否显示右上角关闭按钮
 * @param {boolean} [options.compact=false] 紧凑弹窗（小尺寸、居中、可滚动内容），用于设置类小弹窗
 * @returns {{ overlay: HTMLElement, dialog: HTMLElement, content: HTMLElement, close: Function, onClose: Function }}
 */
export function createOverlayDialog(options = {}) {
  const { title = "", backdropClose = true, showClose = true, compact = false } = options;

  const overlay = document.createElement("div");
  overlay.className = "novel-overlay";
  overlay.dataset.novelOverlay = "";

  const dialog = document.createElement("div");
  dialog.className = "novel-dialog" + (compact ? " novel-dialog-compact" : "");

  // 仅在有标题或需要关闭按钮时才渲染 header（避免全屏弹窗出现空标题条）
  const content = document.createElement("div");
  content.className = "novel-dialog-content";

  if (title || showClose) {
    const header = document.createElement("div");
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

  if (backdropClose) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
  }

  document.body.appendChild(overlay);
  return {
    overlay,
    dialog,
    content,
    close,
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
