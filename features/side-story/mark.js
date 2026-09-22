// features/side-story/mark.js
// 楼层番外标注/取消标注逻辑。
// 语义（与阅读器分章规则一致：user+char 合并为一章）：
//   - 点击 char 楼层：标记该 char 楼层 + 关联上一楼 user 楼层（构成一个番外单元）
//   - 点击 user 楼层：标记该 user 楼层 + 关联下一楼 char 楼层（构成一个番外单元）
// 标注 = 三合一同时执行：
//   1) 标记：写入 ST 消息 mes.extra.novelExtra（挂在 char 楼层上，user 用 linked 引用）
//   2) 隐藏：调用 ST hideChatMessageRange 把相关楼层设为 is_system=true
//      （= ST 原生「从信息词中排除消息」，只影响 AI 上下文，不影响阅读器渲染）
//   3) 入指令库：将 user 楼层文本收入番外指令库（按文本去重）
// 取消标注：撤标记 + 撤隐藏（unhide）；确认后同时移出指令库。

/**
 * 创建楼层番外标注核心。
 * @param {object} deps 依赖注入
 * @param {Function} deps.getChat        () => Array  读取 ST 全局 chat 消息数组（索引 = mesid）
 * @param {Function} deps.getHideRange   () => Function|null  ST hideChatMessageRange(start,end,unhide)
 * @param {Function} deps.getSaveChat    () => Function|null  ST saveChatConditional()
 * @param {object}   deps.commandLib     指令库核心（addFromMessage / existsByText / deleteCommand）
 * @param {Function} deps.getEnabled     () => boolean 番外功能是否启用（未启用时不允许标注）
 * @param {Function} [deps.getHidePair]  () => boolean 是否同时隐藏配对楼层（设置侧开关；默认 true）
 * @param {Function} [deps.getCollectLib]() => boolean 是否将 user 指令收入指令库（设置侧开关；默认 true）
 * @returns {object} mark API
 */
export function createMarkCore(deps) {
  const {
    getChat,
    getHideRange,
    getSaveChat,
    commandLib,
    getEnabled,
    getHidePair,
    getCollectLib,
  } = deps;

  /** 番外标记在 extra 中的命名空间 key */
  const EXTRA_KEY = "novelExtra";

  /** 读某条消息的番外标记 */
  function readMark(mesId) {
    const chat = getChat();
    const mes = chat?.[mesId];
    return mes?.extra?.[EXTRA_KEY] || null;
  }

  /** 写某条消息的番外标记（无则建 extra） */
  function writeMark(mesId, mark) {
    const chat = getChat();
    const mes = chat?.[mesId];
    if (!mes) return false;
    if (!mes.extra) mes.extra = {};
    if (mark) mes.extra[EXTRA_KEY] = mark;
    else delete mes.extra[EXTRA_KEY];
    return true;
  }

  /** 判断某楼层是否为 user 消息（is_user） */
  function isUserMes(mesId) {
    const chat = getChat();
    return Boolean(chat?.[mesId]?.is_user);
  }

  /**
   * 解析「番外单元」：给定楼层，返回 { charId, userId }（标记统一挂 char）。
   * 配对规则：
   *   - 点击 char：配对其上方最近一条紧邻的 user
   *   - 点击 user：配对其下方最近一条紧邻的 char
   * @param {number} mesId 被点击楼层索引
   * @returns {{charId: number|null, userId: number|null, userText: string}|null}
   */
  function resolvePair(mesId) {
    const chat = getChat();
    if (!Array.isArray(chat)) return null;
    const mes = chat[mesId];
    if (!mes) return null;

    if (isUserMes(mesId)) {
      // user 楼层：找下一楼最近的 char（紧邻，跳过系统消息）
      for (let i = mesId + 1; i < chat.length; i++) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_user) break; // 又遇到 user → 无配对
        if (!m.is_system) {
          return { charId: i, userId: mesId, userText: String(mes.mes || "") };
        }
      }
      return { charId: null, userId: mesId, userText: String(mes.mes || "") };
    }

    // char 楼层：找上方最近一条紧邻的 user（跳过系统消息）
    for (let i = mesId - 1; i >= 0; i--) {
      const m = chat[i];
      if (!m) continue;
      if (!m.is_user) break; // 又遇到 char → 无配对
      if (!m.is_system) {
        return { charId: mesId, userId: i, userText: String(m.mes || "") };
      }
    }
    return { charId: mesId, userId: null, userText: "" };
  }

  /** 该楼层是否已标注为番外（读 char 挂载点） */
  function isMarked(mesId) {
    const p = resolvePair(mesId);
    if (!p) return false;
    const charMark = p.charId != null ? readMark(p.charId) : null;
    if (charMark) return true;
    // 反向：若本楼层是某 char 的关联 user，也算已标注
    const chat = getChat();
    const mes = chat?.[mesId];
    if (mes?.is_user && mes.extra?.[EXTRA_KEY]) return true;
    return false;
  }

  /**
   * 标注楼层为番外（三合一：标记 + 隐藏 + 入指令库）。
   * @param {number} mesId 被点击楼层索引
   * @returns {Promise<{ok:boolean, msg:string}>}
   */
  async function mark(mesId) {
    const chat = getChat();
    if (!Array.isArray(chat) || !chat[mesId]) {
      return { ok: false, msg: "楼层不存在" };
    }
    // 番外功能未启用时不允许标注（防御：按钮正常不可见）
    if (typeof getEnabled === "function" && !getEnabled()) {
      return { ok: false, msg: "番外功能未启用" };
    }
    // 本楼层已标注（自身带指针，可能是已隐藏的配对楼）→ 直接提示，
    // 避免 resolvePair 因 is_system 跳过配对楼层而误报"未找到配对"
    if (readMark(mesId)) {
      return { ok: false, msg: "该楼层已是番外" };
    }
    const p = resolvePair(mesId);
    if (!p) return { ok: false, msg: "无法解析楼层" };
    if (p.charId == null) {
      return { ok: false, msg: "未找到配对的角色楼层" };
    }
    if (readMark(p.charId)) {
      return { ok: false, msg: "该楼层已是番外" };
    }

    // 1) 标记（挂 char 楼层）
    const markObj = {
      fw: true,
      linked: p.userId,
    };
    writeMark(p.charId, markObj);
    if (p.userId != null && isUserMes(p.userId)) {
      // user 楼层也挂一个轻量指针（便于 user 楼层按钮识别已标注）
      writeMark(p.userId, { fw: true, linked: p.charId });
    }

    // 2) 隐藏：char 楼层 + （存在时）user 楼层。
    //    配对楼层间只可能有 is_system 消息（resolvePair 跳过系统消息、遇同类 break），
    //    故合并为一次区间 hide，DOM 同步更新、仅一次保存，避免两次调用产生的时间差。
    //    不 await：hideRange 循环内 DOM 属性同步设置，只有末尾 await saveChatConditional()
    //    是异步的。不等待可让图标/toast 立即刷新，保存完成后才重载阅读器。
    const hidePair = typeof getHidePair === "function" ? getHidePair() : true;
    let hidePromise = null;
    if (hidePair) {
      const hideRange = getHideRange();
      if (typeof hideRange === "function") {
        const ids = [p.charId];
        if (p.userId != null) ids.push(p.userId);
        hidePromise = hideRange(Math.min(...ids), Math.max(...ids), false);
      }
    }

    // 3) 入指令库（user 指令文本；去重；可由设置「标注时收入指令库」关闭）
    const collectToLib =
      typeof getCollectLib === "function" ? getCollectLib() : true;
    if (collectToLib && p.userId != null && p.userText.trim()) {
      commandLib.addFromMessage(p.userText, { name: "" });
    }

    // 保存聊天：hideRange 内部已保存；未走隐藏路径时显式保存。
    // 不阻塞 UI：返回 saved Promise，调用方在重载阅读器前等待即可。
    let saved = null;
    if (hidePromise) {
      saved = hidePromise.catch((err) =>
        console.warn("[NovelReader] hideChatMessageRange 失败:", err),
      );
    } else {
      const saveChat = getSaveChat();
      if (typeof saveChat === "function") {
        saved = saveChat().catch((err) =>
          console.warn("[NovelReader] saveChatConditional 失败:", err),
        );
      }
    }

    return { ok: true, msg: "已标注为番外", saved };
  }

  /**
   * 取消楼层番外标注（撤标记 + 撤隐藏）。
   * 指令库移除不在此处理：返回 commandMatch 供调用方（index.js）在确认后删除，
   * 避免确认框阻塞楼层恢复与图标/toast 刷新（造成延迟）。
   * @param {number} mesId 被点击楼层索引
   * @returns {Promise<{ok:boolean, msg:string, saved:Promise|null, commandMatch:object|null}>}
   *   commandMatch：匹配到的指令库指令（{id, name}），供调用方确认是否移除
   */
  async function unmark(mesId) {
    const chat = getChat();
    if (!Array.isArray(chat) || !chat[mesId]) {
      return { ok: false, msg: "楼层不存在" };
    }
    // 优先用双向指针反查配对（标注会隐藏楼层，resolvePair 会跳过 is_system
    // 消息，导致无法配对已隐藏的楼层；而 mark 写入的 linked 指针不受影响）
    const markSelf = readMark(mesId);
    let charId = null;
    let userId = null;
    let userText = "";
    if (markSelf) {
      if (isUserMes(mesId)) {
        // user 楼自身带指针 → 指向其 char 楼
        userId = mesId;
        charId = typeof markSelf.linked === "number" ? markSelf.linked : null;
        userText = String(chat[mesId]?.mes || "");
      } else {
        // char 楼自身带指针 → 指向其 user 楼
        charId = mesId;
        userId = typeof markSelf.linked === "number" ? markSelf.linked : null;
        if (userId != null) userText = String(chat[userId]?.mes || "");
      }
    } else {
      // 未隐藏时走常规配对（此时楼层可见，resolvePair 可用）
      const p = resolvePair(mesId);
      if (!p) return { ok: false, msg: "无法解析楼层" };
      charId = p.charId;
      userId = p.userId;
      userText = p.userText;
    }

    if (charId == null && !readMark(mesId) && !isUserMes(mesId)) {
      return { ok: false, msg: "该楼层不是番外" };
    }

    // 1) 撤标记：char + user 都删
    if (charId != null) writeMark(charId, null);
    if (userId != null) writeMark(userId, null);
    // 若点击的是已标注 user 楼层（其 extra 有指针），一并清理
    if (isUserMes(mesId) && chat[mesId]?.extra?.[EXTRA_KEY]) {
      writeMark(mesId, null);
    }

    // 2) 撤隐藏：unhide。不能像标记那样合并区间（配对楼之间可能夹有
    //    真正的系统消息，区间 unhide 会误把它们恢复显示），改为并行两次
    //    单楼 unhide —— 内部 DOM 属性同步设置、同一宏任务完成，两楼视觉
    //    同时恢复，无时间差。
    //    不 await：DOM 属性同步设置已生效，保存由 saved 交给调用方等待。
    const hideRange = getHideRange();
    let hidePromise = null;
    if (typeof hideRange === "function") {
      hidePromise = Promise.all(
        [charId, userId]
          .filter((id) => id != null)
          .map((id) => hideRange(id, id, true)),
      );
    }

    // 3) 匹配指令库指令（不删除：由调用方确认后决定）
    //    返回 commandMatch 让 index.js 在 toast/图标刷新之后再弹确认框，
    //    避免确认框阻塞楼层恢复与按钮刷新。
    let commandMatch = null;
    if (userId != null && userText.trim()) {
      const cmd = findCommandByText(commandLib, userText);
      if (cmd) {
        commandMatch = { id: cmd.id, name: cmd.name || "" };
      }
    }

    // 保存聊天：撤隐藏内部已保存；未走隐藏路径时显式保存。
    // 不阻塞 UI：返回 saved Promise，调用方在重载阅读器前等待即可。
    let saved = null;
    if (hidePromise) {
      saved = hidePromise.catch((err) =>
        console.warn("[NovelReader] hideChatMessageRange 失败:", err),
      );
    } else {
      const saveChat = getSaveChat();
      if (typeof saveChat === "function") {
        saved = saveChat().catch((err) =>
          console.warn("[NovelReader] saveChatConditional 失败:", err),
        );
      }
    }

    return { ok: true, msg: "已取消番外标注", saved, commandMatch };
  }

  return {
    mark,
    unmark,
    isMarked,
    resolvePair,
    readMark,
    isUserMes,
    EXTRA_KEY,
  };
}

/**
 * 在指令库中按文本查找指令（trim 后完全一致；找不到返回 null）。
 * @param {object} commandLib 指令库核心
 * @param {string} text 指令文本
 * @returns {object|null}
 */
function findCommandByText(commandLib, text) {
  const txt = String(text || "").trim();
  if (!txt) return null;
  const cmds = commandLib.listCommands();
  for (const cmd of Object.values(cmds)) {
    if (String(cmd.text || "").trim() === txt) return cmd;
  }
  return null;
}
