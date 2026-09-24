// features/gen-notify/index.js
// 新楼层生成结束 / 被截断 → 通知状态机。
// 订阅 ST 的生成事件，累计"待通知的生成结束次数"（pending）。
// 纯逻辑层：不操作弹窗 DOM，UI 展示由主入口 index.js 负责。
//
// 需求约定（详见 plans/new-chapter-notify.md）：
//   - 不做"当前阅读聊天"区分：酒馆任意聊天生成结束都计数
//   - 不区分正常结束 / 手动停止：GENERATION_ENDED 与 GENERATION_STOPPED 统一计数
//   - dryRun（提示词查看器预览）不计数
//
// 依赖注入 deps：
//   getStContext   () => window.SillyTavern.getContext()  拿 eventSource / eventTypes
//   getSettings    () => extension_settings               读取 genNotifyEnabled 开关
//   onNotify       () => void                             有新的生成结束时回调（主入口据此显示红点+气泡）

/**
 * 创建"生成结束通知"核心。
 * @param {object} deps 依赖注入
 * @returns {object} gen-notify API
 */
export function createGenNotifyCore(deps) {
  // 待通知的生成结束次数（红点角标计数；点击气泡/关闭弹窗时清零）
  let pending = 0;
  // 当前是否处于生成中（GENERATION_STARTED 置 true，ENDED/STOPPED 置 false）
  let generating = false;
  // 事件处理器引用（供 unsubscribe 移除）
  let handlers = null;

  /**
   * 累计一次生成结束通知。
   * @param {string} source 触发来源：'ended' | 'stopped'（仅用于日志/未来扩展区分）
   */
  function bump(source) {
    pending += 1;
    try {
      deps.onNotify?.({ count: pending, source });
    } catch (err) {
      console.warn("[NovelReader] 生成通知回调失败:", err);
    }
  }

  /** 订阅 ST 生成事件（幂等：重复调用先取消再订阅） */
  function subscribe() {
    const ctx = deps.getStContext();
    const events = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (!events || !types) return;

    unsubscribe();

    handlers = {
      started: (type, options, dryRun) => {
        // dryRun = true 表示提示词查看器预览（不会真正产生楼层），不进入生成状态
        if (dryRun) return;
        generating = true;
      },
      ended: () => {
        if (!generating) return; // 无 STARTED 的孤立 ENDED（其它来源）不通知
        generating = false;
        bump("ended");
      },
      stopped: () => {
        if (!generating) return; // 无 STARTED 的孤立 STOPPED 不通知
        generating = false;
        bump("stopped");
      },
    };

    events.on(types.GENERATION_STARTED, handlers.started);
    events.on(types.GENERATION_ENDED, handlers.ended);
    events.on(types.GENERATION_STOPPED, handlers.stopped);
  }

  /** 取消订阅（弹窗关闭 / 开关关闭时调用） */
  function unsubscribe() {
    if (!handlers) return;
    const ctx = deps.getStContext();
    const events = ctx?.eventSource;
    const types = ctx?.eventTypes;
    if (events && types) {
      // ST 的 eventSource 是 EventEmitter：用 removeListener 移除监听；
      // 部分版本也提供 off 别名，统一走 removeListener（兼容两者）
      const remove = events.removeListener || events.off;
      if (typeof remove === "function") {
        remove.call(events, types.GENERATION_STARTED, handlers.started);
        remove.call(events, types.GENERATION_ENDED, handlers.ended);
        remove.call(events, types.GENERATION_STOPPED, handlers.stopped);
      }
    }
    handlers = null;
  }

  /** 返回当前待通知计数（不消费） */
  function getPending() {
    return pending;
  }

  /** 清零计数（点击气泡 / 关闭弹窗时调用） */
  function clear() {
    pending = 0;
  }

  return {
    subscribe,
    unsubscribe,
    getPending,
    clear,
  };
}
