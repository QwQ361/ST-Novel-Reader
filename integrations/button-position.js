// integrations/button-position.js
// 按钮三位置（顶栏 / 悬浮球 / 魔法棒）核心实现（参考 CFM ui/toolbar/buttons.js）：
//   1) switchButtonModeCore   —— 销毁旧按钮 → 按新模式创建
//   2) destroyAllButtonsCore  —— 销毁全部按钮 + 解绑跨元素事件（命名空间）
//   3) createTopbarButtonCore —— 顶栏（#rightNavHolder 前，回退 #top-settings-holder）
//   4) createFloatingButtonCore —— 悬浮球（body 末尾，PC 拖拽 + 移动端长按拖拽 + resize 校正）
//   5) createWandButtonCore   —— 魔法棒菜单（#extensionsMenu 内，延迟重试）
//
// 依赖注入（deps）：
//   $                    jQuery
//   document / window    DOM 对象
//   localStorage         localStorage
//   navigator            navigator（vibrate）
//   storageKeyBtnPos     悬浮球位置存储键（如 "nr-button-pos"）
//   openReader           () => void  打开阅读器
//   setTimeout / clearTimeout
//   onTopbarIconReady    可选：顶栏按钮注入后回调（启动图标美化适配等）

const BTN_ID_TOP = "novel-topbar-button";
const BTN_ID_FLOAT = "novel-float-button";
const BTN_ID_WAND = "novel-wand-button";

/**
 * 销毁全部按钮（含解绑 document/window 级命名空间事件）。
 * @param {object} deps
 */
export function destroyAllButtonsCore(deps) {
  const $ = deps.$;
  deps.$(deps.document).off(".novelBtnDrag");
  deps.$(deps.window).off(".novelBtnResize");
  $(`#${BTN_ID_TOP}`).remove();
  $(`#${BTN_ID_FLOAT}`).remove();
  $(`#${BTN_ID_WAND}`).remove();
}

/**
 * 切换按钮模式：销毁旧按钮 → 持久化新模式 → 按新模式创建。
 * @param {"topbar"|"float"|"wand"} newMode
 * @param {object} deps 含 destroyAllButtons / setButtonMode / createTopbarButton / createFloatingButton / createWandButton
 */
export function switchButtonModeCore(newMode, deps) {
  deps.destroyAllButtons();
  deps.setButtonMode(newMode);
  if (newMode === "topbar") deps.createTopbarButton();
  else if (newMode === "wand") deps.createWandButton();
  else deps.createFloatingButton();
}

/**
 * 顶栏按钮：注入 #rightNavHolder 前（回退 #top-settings-holder），
 * 类名用酒馆原生 drawer 三件套，美化主题图标替换规则自动生效。
 * @param {object} deps
 */
export function createTopbarButtonCore(deps) {
  const $ = deps.$;
  if ($(`#${BTN_ID_TOP}`).length > 0) return; // 幂等保护

  const btn = $(
    `<div id="${BTN_ID_TOP}" class="drawer">
      <div class="drawer-toggle drawer-header" title="酒馆小说阅读器">
        <div class="drawer-icon closedIcon fa-solid fa-book interactable" title="酒馆小说阅读器" tabindex="0" role="button"></div>
      </div>
    </div>`,
  );
  const rightNav = $("#rightNavHolder");
  if (rightNav.length > 0) rightNav.before(btn);
  else $("#top-settings-holder").append(btn);

  btn.on("click touchend", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 无论点击 icon 还是覆盖其上的 toggle（url 图标模式），都打开阅读器
    if (e.target.closest(`#${BTN_ID_TOP}`)) deps.openReader();
  });

  // 延迟应用自定义图标 + 启动主题监听（美化主题适配）
  if (typeof deps.onTopbarIconReady === "function") {
    deps.setTimeout(() => deps.onTopbarIconReady(), 500);
  }
}

/**
 * 悬浮球：注入 body 末尾，支持 PC 鼠标拖拽 + 移动端长按拖拽，resize 边界校正。
 * @param {object} deps
 */
export function createFloatingButtonCore(deps) {
  const $ = deps.$;
  if ($(`#${BTN_ID_FLOAT}`).length > 0) return;

  const btn = $(
    `<div id="${BTN_ID_FLOAT}" class="novel-float-button" title="酒馆小说阅读器">
      <i class="fa-solid fa-book"></i>
    </div>`,
  );
  $("body").append(btn);

  // ---- 初始定位（恢复保存位置 + 边界校正；无保存 → 默认右上角） ----
  const btnSize = 44; // 与 style.css .novel-float-button 尺寸保持一致
  const winW = $(deps.window).width();
  const winH = $(deps.window).height();
  let savedPos = null;
  try {
    savedPos = JSON.parse(
      deps.localStorage.getItem(deps.storageKeyBtnPos) || "null",
    );
  } catch {
    savedPos = null;
  }
  if (savedPos) {
    let posTop = parseInt(savedPos.top, 10) || 150;
    let posLeft = parseInt(savedPos.left, 10);
    if (isNaN(posLeft) || posLeft > winW - btnSize)
      posLeft = winW - btnSize - 10;
    if (posLeft < 0) posLeft = 10;
    if (posTop > winH - btnSize) posTop = winH - btnSize - 10;
    if (posTop < 0) posTop = 10;
    // 避让消息操作按钮条（mes_buttons）常见区域（y≈150-210）：
    // 旧版本默认位置 top:150px 在手机上正好与之重叠，用户会"找不到"悬浮球。
    // 仅当保存位置落在此区间且靠右（right 侧）时，重置为新的默认位置。
    const defaultTop = Math.round(winH * 0.3);
    if (posTop >= 140 && posTop <= 220 && posLeft > winW * 0.5) {
      posTop = defaultTop;
      btn.css({ top: posTop + "px", right: "15px", left: "auto" });
      savePos();
    } else {
      btn.css({
        top: posTop + "px",
        left: posLeft + "px",
        right: "auto",
        bottom: "auto",
      });
    }
  } else {
    // 默认右上角：top 用视口 30%（像素值），避开手机上消息操作按钮条
    // （mes_buttons，y≈170-200）区域，避免用户"找不到"悬浮球
    const defaultTop = Math.round(winH * 0.3);
    btn.css({
      top: defaultTop + "px",
      right: "15px",
      left: "auto",
      bottom: "auto",
    });
  }

  // ---- 状态 ----
  let isDragging = false;
  let hasMoved = false;
  let longPressTriggered = false;
  let offset = { x: 0, y: 0 };
  let startPos = { x: 0, y: 0 };
  let longPressTimer = null;
  const btnEl = btn[0];

  /** 保存当前位置 */
  function savePos() {
    try {
      deps.localStorage.setItem(
        deps.storageKeyBtnPos,
        JSON.stringify({ top: btn.css("top"), left: btn.css("left") }),
      );
    } catch {}
  }

  // ---- PC 端鼠标拖拽（jQuery + 命名空间事件） ----
  btn.on("mousedown", (e) => {
    hasMoved = false;
    const pos = btn.offset();
    offset.x = e.pageX - pos.left;
    offset.y = e.pageY - pos.top;
    startPos.x = e.pageX;
    startPos.y = e.pageY;
    isDragging = true;
    btn.css("cursor", "grabbing");
    e.preventDefault();
  });
  $(deps.document).on("mousemove.novelBtnDrag", (e) => {
    if (!isDragging) return;
    if (
      Math.abs(e.pageX - startPos.x) > 5 ||
      Math.abs(e.pageY - startPos.y) > 5
    )
      hasMoved = true; // 5px 移动阈值判定拖拽 vs 点击
    if (hasMoved)
      btn.css({
        top: e.pageY - offset.y + "px",
        left: e.pageX - offset.x + "px",
        right: "auto",
        bottom: "auto",
      });
  });
  $(deps.document).on("mouseup.novelBtnDrag", () => {
    if (!isDragging) return;
    isDragging = false;
    btn.css("cursor", "grab");
    if (hasMoved) savePos();
    deps.setTimeout(() => {
      hasMoved = false;
    }, 50); // 延迟重置，防止拖拽后 click 误触
  });
  btn.on("click", (e) => {
    if (hasMoved) {
      e.preventDefault();
      e.stopPropagation();
      return;
    } // 拖拽过则不响应点击
    deps.openReader();
  });

  // ---- 移动端触摸（原生事件 + passive 控制 + 长按拖拽） ----
  let tSx = 0,
    tSy = 0;
  let btnTouchEnded = false;

  // touchstart：记录起点，启动 500ms 长按计时器
  btnEl.addEventListener(
    "touchstart",
    (e) => {
      hasMoved = false;
      longPressTriggered = false;
      btnTouchEnded = false;
      const t = e.touches[0];
      tSx = t.clientX;
      tSy = t.clientY;
      const pos = btn.offset();
      offset.x = t.pageX - pos.left;
      offset.y = t.pageY - pos.top;
      longPressTimer = deps.setTimeout(() => {
        longPressTimer = null;
        if (btnTouchEnded) return; // 竞态保护
        longPressTriggered = true;
        isDragging = true;
        btn.addClass("novel-long-press-ready"); // 视觉反馈
        if (deps.navigator?.vibrate) deps.navigator.vibrate(50); // 震动反馈
      }, 500);
    },
    { passive: true },
  );

  // touchmove：长按后拖拽；移动 >10px 取消长按
  btnEl.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!isDragging) {
        if (Math.abs(t.clientX - tSx) > 10 || Math.abs(t.clientY - tSy) > 10) {
          if (longPressTimer) {
            deps.clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }
        return;
      }
      e.preventDefault(); // 阻止滚动（必须 passive:false）
      hasMoved = true;
      btn.css({
        top: t.pageY - offset.y + "px",
        left: t.pageX - offset.x + "px",
        right: "auto",
        bottom: "auto",
      });
    },
    { passive: false },
  );

  // touchend：区分点击 / 长按拖拽结束
  btnEl.addEventListener(
    "touchend",
    (e) => {
      btnTouchEnded = true;
      if (longPressTimer) {
        deps.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      if (!isDragging && !longPressTriggered) {
        e.preventDefault();
        deps.openReader(); // 短按 = 打开弹窗
        return;
      }
      if (isDragging) {
        isDragging = false;
        btn.removeClass("novel-long-press-ready");
        if (hasMoved) savePos();
      }
      hasMoved = false;
      longPressTriggered = false;
    },
    { passive: false },
  );

  // touchcancel：清理状态
  btnEl.addEventListener("touchcancel", () => {
    btnTouchEnded = true;
    if (longPressTimer) {
      deps.clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (isDragging) {
      isDragging = false;
      btn.removeClass("novel-long-press-ready");
    }
    hasMoved = false;
    longPressTriggered = false;
  });

  // ---- resize 边界校正（防抖 150ms，防止按钮被移出屏幕） ----
  let resizeTimer = null;
  $(deps.window).on("resize.novelBtnResize", () => {
    deps.clearTimeout(resizeTimer);
    resizeTimer = deps.setTimeout(() => {
      const b = $(`#${BTN_ID_FLOAT}`);
      if (!b.length) return;
      let l = b.offset().left,
        t = b.offset().top;
      const maxL = $(deps.window).width() - b.outerWidth();
      const maxT = $(deps.window).height() - b.outerHeight();
      if (l > maxL) l = maxL;
      if (l < 0) l = 0;
      if (t > maxT) t = maxT;
      if (t < 0) t = 0;
      b.css({ top: t + "px", left: l + "px" });
      savePos();
    }, 150);
  });
}

/**
 * 魔法棒菜单按钮：注入 #extensionsMenu 内，延迟重试直到菜单就绪。
 * @param {object} deps
 */
export function createWandButtonCore(deps) {
  const $ = deps.$;
  if ($(`#${BTN_ID_WAND}`).length > 0) return;

  const extensionsMenu = $("#extensionsMenu");
  if (extensionsMenu.length === 0) {
    // 魔术棒菜单还没加载，延迟重试
    deps.setTimeout(() => deps.createWandButton(), 500);
    return;
  }

  const buttonHtml = $(
    `<div id="${BTN_ID_WAND}" class="list-group-item flex-container flexGap5 interactable" title="酒馆小说阅读器">
      <div class="fa-solid fa-book extensionsMenuExtensionButton"></div>
      <span>小说阅读器</span>
    </div>`,
  );
  extensionsMenu.append(buttonHtml);
  buttonHtml.on("click touchend", (e) => {
    e.preventDefault();
    e.stopPropagation();
    $("#extensionsMenu").hide(); // 先关闭魔术棒下拉
    deps.openReader();
  });
}
