// features/side-story/inject.js
// 番外按钮注入：
//   1) 楼层操作栏：向每个楼层 .mes_buttons 追加「标注/取消番外」按钮，
//      插入在「消息操作」（省略号 .extraMesButtonsHint）之前，与编辑/检查点等按钮同级直接可见。
//   2) 输入框工具行：向 #rightSendForm（发送按钮同侧）注入「指令库」入口按钮
// 启用番外功能时才显示；关闭时隐藏。
// 采用事件委托（document 级 click），避免频繁重渲染造成的监听泄漏。

/**
 * 创建番外按钮注入器。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getEnabled      () => boolean 番外功能是否启用
 * @param {Function} deps.onMarkClick     (mesId, btnEl) => void 标注按钮点击回调
 * @param {Function} deps.onUnmarkClick   (mesId, btnEl) => void 取消标注按钮点击回调
 * @param {Function} deps.isMarked        (mesId) => boolean 楼层是否已标注
 * @param {Function} deps.onOpenLibClick  () => void 指令库按钮点击回调（打开面板）
 * @param {Function} deps.getMesIdFromBtn (btnEl) => number|null 从按钮定位楼层 mesid
 * @returns {object} inject API
 */
export function createInjectCore(deps) {
  const {
    getEnabled,
    onMarkClick,
    onUnmarkClick,
    isMarked,
    onOpenLibClick,
    getMesIdFromBtn,
  } = deps;

  let delegated = false;

  // ---- 楼层按钮注入（事件委托） ----

  /**
   * 为单个楼层注入番外按钮（幂等：已含则跳过）。
   * 插入位置：.mes_buttons 中「消息操作」省略号（.extraMesButtonsHint）之前，
   * 与编辑/检查点等按钮同级，直接可见（不进三点菜单）。
   * @param {HTMLElement} mesEl .mes 楼层根元素
   * @param {number} mesId 楼层索引
   */
  function injectIntoMessage(mesEl, mesId) {
    if (!mesEl) return;
    const buttonsRow = mesEl.querySelector(".mes_buttons");
    if (!buttonsRow) return;
    // 幂等：按钮已存在则只同步状态（标注/取消后配对楼层的按钮也要刷新）
    let btn = mesEl.querySelector(".novel-side-story-btn");
    if (!btn) {
      btn = document.createElement("div");
      btn.className = "mes_button novel-side-story-btn";
      btn.dataset.mesid = String(mesId);
      btn.innerHTML = '<i class="fa-solid fa-book"></i>';
      btn.title = "标注为番外";
      // 插到「消息操作」省略号之前；没有省略号则追加到按钮行末尾
      const hint = buttonsRow.querySelector(".extraMesButtonsHint");
      if (hint) buttonsRow.insertBefore(btn, hint);
      else buttonsRow.appendChild(btn);
    }
    refreshButtonState(btn, isMarked(mesId));
  }

  /** 刷新单个按钮的标注/取消状态（无变化不重绘，避免 MutationObserver 高频触发闪烁） */
  function refreshButtonState(btn, marked) {
    if (!btn) return;
    const mode = marked ? "unmark" : "mark";
    if (btn.dataset.mode === mode) return;
    btn.dataset.mode = mode;
    btn.title = marked ? "取消番外标注" : "标注为番外";
    // 图标保持「书」不变（只通过 .novel-side-story-active 变蓝），不切换为书签
    btn.innerHTML = '<i class="fa-solid fa-book"></i>';
    btn.classList.toggle("novel-side-story-active", marked);
  }

  /**
   * 全量扫描聊天区域中的楼层，注入/刷新番外按钮。
   * 幂等：已注入的按钮只刷新状态，不重复添加。
   */
  function refreshAll() {
    if (!getEnabled()) return;
    document.querySelectorAll("#chat .mes").forEach((mesEl) => {
      const mesId = Number(mesEl.getAttribute("mesid"));
      if (Number.isNaN(mesId)) return;
      injectIntoMessage(mesEl, mesId);
    });
  }

  /** 按 mesid 刷新某楼层按钮状态（标注/取消后调用） */
  function refreshByMesId(mesId) {
    const btn = document.querySelector(
      `.novel-side-story-btn[data-mesid="${mesId}"]`,
    );
    if (btn) refreshButtonState(btn, isMarked(mesId));
  }

  // ---- 输入框工具行按钮注入 ----

  let libBtnEl = null;

  /** 向 #rightSendForm 注入「指令库」入口按钮（幂等） */
  function injectLibButton() {
    if (libBtnEl && document.body.contains(libBtnEl)) {
      libBtnEl.style.display = getEnabled() ? "" : "none";
      return libBtnEl;
    }
    const rightForm = document.getElementById("rightSendForm");
    if (!rightForm) return null;

    const btn = document.createElement("div");
    btn.className = "novel-side-story-lib-btn interactable";
    btn.id = "novel_side_story_lib_btn";
    btn.title = "番外指令库";
    btn.innerHTML = '<i class="fa-solid fa-book-bookmark"></i>';
    btn.style.display = getEnabled() ? "" : "none";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onOpenLibClick?.();
    });
    // 放在发送按钮之前（同侧工具行内）
    const sendBut = document.getElementById("send_but");
    if (sendBut) rightForm.insertBefore(btn, sendBut);
    else rightForm.appendChild(btn);
    libBtnEl = btn;
    return btn;
  }

  // ---- 统一入口 ----

  /** 全局注入：绑定事件委托 + 注入楼层按钮 + 输入框按钮 */
  function injectAll() {
    injectLibButton();
    if (delegated) {
      refreshAll();
      return;
    }

    // 事件委托：楼层标注/取消按钮
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".novel-side-story-btn");
      if (!btn) return;
      const mesId = Number(btn.dataset.mesid);
      if (Number.isNaN(mesId)) return;
      const mode = btn.dataset.mode;
      if (mode === "unmark") onUnmarkClick?.(mesId, btn);
      else onMarkClick?.(mesId, btn);
    });

    // 楼层按钮随消息渲染：ST 用 jQuery 渲染消息，用 MutationObserver 监听 #chat
    // 以便新渲染的楼层也能注入按钮（比轮询更可靠）。
    const chatEl = document.getElementById("chat");
    if (chatEl && window.MutationObserver) {
      const observer = new MutationObserver(() => {
        if (!getEnabled()) return;
        refreshAll();
      });
      observer.observe(chatEl, { childList: true, subtree: true });
    }

    delegated = true;
    refreshAll();
  }

  /** 启用状态变化时刷新显隐（开关切换后调用） */
  function refresh() {
    injectLibButton();
    const enabled = getEnabled();
    if (enabled) refreshAll();
    else {
      // 关闭时隐藏楼层按钮与指令库按钮
      document
        .querySelectorAll(".novel-side-story-btn")
        .forEach((b) => (b.style.display = "none"));
      if (libBtnEl) libBtnEl.style.display = "none";
    }
  }

  return {
    injectAll,
    refresh,
    refreshAll,
    refreshByMesId,
    injectIntoMessage,
    getLibButton: () => libBtnEl,
  };
}
