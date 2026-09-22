// features/chatlogs/index.js
// 聊天记录操作核心：单条聊天删除 / 重命名。
//
// 设计原则（参考 CFM 最小版，见 NOVEL-READER-CHAT-DELETE-RENAME-SYNC.md）：
// - 功能层保持纯净：deleteChatFile / renameChatFile 只做「执行 + 同步关联数据 + 缓存失效 +
//   持久化 + 返回 true/false」，不负责重绘 UI。重绘由调用方（UI 事件处理器）成功后触发。
// - 双保险调用：优先酒馆原生函数（deleteCharacterChatByName / renameGroupOrCharacterChat），
//   异常或缺失时回退 HTTP API / 上下文方法。
// - 元数据 key 归一化：书签/阅读位置统一用「带 .jsonl 的完整文件名」作为 key；
//   仅在调用酒馆原生接口 / HTTP API 边界处去除/补上扩展名。
//
// 依赖注入 deps（由 index.js 提供）：
//   getStContext / getRequestHeaders / deleteCharacterChatByNameFunc /
//   renameGroupOrCharacterChatFunc / doNewChatFunc / bookshelf / bookmarks / progress / toast

/**
 * 创建聊天记录操作核心。
 * @param {object} deps 依赖注入
 * @returns {{ deleteChatFile: Function, renameChatFile: Function }}
 */
export function createChatlogsCore(deps) {
  const toast = deps.toast || window.toastr || null;

  /** 轻量 toast 提示（toastr 不可用时静默） */
  function notify(type, message) {
    try {
      if (toast && typeof toast[type] === "function") toast[type](message);
    } catch {
      // 忽略：toastr 异常不影响主流程
    }
  }

  /**
   * 由角色头像文件名查角色索引。
   * @param {string} avatar 角色头像文件名
   * @returns {number} 角色索引；未找到返回 -1
   */
  function findCharIndex(avatar) {
    const chars = deps.getStContext()?.characters;
    if (!Array.isArray(chars)) return -1;
    return chars.findIndex((c) => c.avatar === avatar);
  }

  /**
   * 去掉 .jsonl 扩展名（酒馆原生函数期望不带扩展名）。
   * @param {string} name 文件名
   * @returns {string} 不含 .jsonl 的文件名
   */
  function stripExt(name) {
    return String(name || "").replace(/\.jsonl$/i, "");
  }

  /**
   * 通过 HTTP API 删除聊天（原生函数缺失/异常时的回退）。
   * @param {string} avatar 角色头像文件名
   * @param {string} fileNameNoExt 不含 .jsonl 的文件名
   * @returns {Promise<boolean>}
   */
  async function deleteViaHttpApi(avatar, fileNameNoExt) {
    try {
      const res = await fetch("/api/chats/delete", {
        method: "POST",
        headers: deps.getRequestHeaders(),
        body: JSON.stringify({
          chatfile: fileNameNoExt + ".jsonl",
          avatar_url: avatar,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && typeof json === "object" && json.error === true) {
        console.warn("[NovelReader] 删除聊天 API 返回错误:", json);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[NovelReader] 删除聊天 API 失败:", err);
      return false;
    }
  }

  /**
   * 删除单条聊天（功能层：只执行 + 清理关联数据 + 缓存失效，不重绘 UI）。
   * @param {string} avatar 角色头像文件名
   * @param {string} chatFileName 聊天文件名（带 .jsonl）
   * @returns {Promise<boolean>} 是否删除成功
   */
  async function deleteChatFile(avatar, chatFileName) {
    const charIdx = findCharIndex(avatar);
    if (charIdx < 0) {
      notify("error", "未找到对应角色，无法删除聊天");
      return false;
    }
    const fileNameNoExt = stripExt(chatFileName);

    // 双保险：优先酒馆原生函数，异常或缺失时回退 HTTP API
    let deleted = false;
    const deleteNative = deps.deleteCharacterChatByNameFunc?.();
    if (typeof deleteNative === "function") {
      try {
        await deleteNative(String(charIdx), fileNameNoExt);
        deleted = true;
      } catch (err) {
        console.warn(
          "[NovelReader] deleteCharacterChatByName 失败，回退 API:",
          err,
        );
        deleted = await deleteViaHttpApi(avatar, fileNameNoExt);
      }
    } else {
      deleted = await deleteViaHttpApi(avatar, fileNameNoExt);
    }

    if (!deleted) {
      notify("error", "删除聊天失败");
      return false;
    }

    // 删除成功后同步清理关联数据 + 缓存失效（删除后同步核心）
    try {
      deps.bookmarks?.clearByChat?.(avatar, chatFileName);
      deps.progress?.clear?.(avatar, chatFileName);
      deps.getStContext()?.saveSettingsDebounced?.();
      await deps.bookshelf?.invalidateChat?.(avatar, chatFileName);
    } catch (err) {
      console.warn("[NovelReader] 删除聊天后清理关联数据失败:", err);
    }

    notify("success", "聊天已删除");
    return true;
  }

  /**
   * 重命名单条聊天（功能层：只执行 + 迁移关联数据 + 缓存失效，不重绘 UI）。
   * @param {string} avatar 角色头像文件名
   * @param {string} oldFileName 旧聊天文件名（带 .jsonl）
   * @param {string} newName 新文件名（不带扩展名，最终自动补 .jsonl）
   * @returns {Promise<boolean>} 是否重命名成功
   */
  async function renameChatFile(avatar, oldFileName, newName) {
    const cleanName = String(newName || "")
      .trim()
      .replace(/\.jsonl$/i, "");
    if (!cleanName) {
      notify("error", "新文件名不能为空");
      return false;
    }
    const charIdx = findCharIndex(avatar);
    if (charIdx < 0) {
      notify("error", "未找到对应角色，无法重命名聊天");
      return false;
    }
    const oldNameNoExt = stripExt(oldFileName);
    const newFileName = cleanName + ".jsonl";

    // 双保险：优先酒馆原生函数，缺失时回退 ctx.renameChat（仅限当前打开的聊天）
    let renamed = false;
    const renameNative = deps.renameGroupOrCharacterChatFunc?.();
    if (typeof renameNative === "function") {
      try {
        await renameNative({
          characterId: String(charIdx),
          groupId: null,
          oldFileName: oldNameNoExt,
          newFileName: cleanName,
          loader: false,
        });
        renamed = true;
      } catch (err) {
        console.warn(
          "[NovelReader] renameGroupOrCharacterChat 失败，回退 ctx.renameChat:",
          err,
        );
        renamed = await renameViaCtx(avatar, oldNameNoExt, cleanName);
      }
    } else {
      renamed = await renameViaCtx(avatar, oldNameNoExt, cleanName);
    }

    if (!renamed) {
      notify("error", "重命名聊天失败");
      return false;
    }

    // 重命名成功后迁移关联数据（备注/书签/阅读位置） + 缓存失效
    try {
      deps.bookmarks?.renameKey?.(avatar, oldFileName, newFileName);
      deps.progress?.renameKey?.(avatar, oldFileName, newFileName);
      deps.getStContext()?.saveSettingsDebounced?.();
      await deps.bookshelf?.invalidateChat?.(avatar, oldFileName);
    } catch (err) {
      console.warn("[NovelReader] 重命名聊天后迁移关联数据失败:", err);
    }

    notify("success", "聊天已重命名");
    return true;
  }

  /**
   * 通过 ST 上下文 ctx.renameChat 重命名（只能重命名「当前打开的聊天」）。
   * @param {string} avatar 角色头像文件名
   * @param {string} oldNameNoExt 旧文件名（不含 .jsonl）
   * @param {string} newNameNoExt 新文件名（不含 .jsonl）
   * @returns {Promise<boolean>}
   */
  async function renameViaCtx(avatar, oldNameNoExt, newNameNoExt) {
    try {
      const ctx = deps.getStContext();
      if (typeof ctx?.renameChat !== "function") return false;
      // ctx.renameChat 只能重命名当前打开的聊天；旧聊天不是当前聊天时无法直接改名
      const currentId = ctx.getCurrentChatId?.() ?? null;
      if (currentId !== oldNameNoExt) {
        notify("warning", "需先在酒馆中打开该聊天才能重命名");
        return false;
      }
      await ctx.renameChat(oldNameNoExt, newNameNoExt);
      return true;
    } catch (err) {
      console.warn("[NovelReader] ctx.renameChat 失败:", err);
      return false;
    }
  }

  return { deleteChatFile, renameChatFile };
}
