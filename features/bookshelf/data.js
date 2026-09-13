// features/bookshelf/data.js
// 数据获取层：全部角色、某角色聊天列表、完整消息数组。
// 依赖注入 deps：getStContext / getRequestHeaders / getPastCharacterChatsFunc

/**
 * 获取全部角色列表。
 * @param {object} deps 依赖注入
 * @returns {Array<object>} 角色数组（元素含 avatar/name/chat 等字段）
 */
export function getCharactersCore(deps) {
  const ctx = deps.getStContext();
  return Array.isArray(ctx?.characters) ? ctx.characters : [];
}

/**
 * 获取指定角色（按角色索引）的聊天列表。
 * 优先 ST 内置 getPastCharacterChats（带缓存），失败时回退 /api/characters/chats。
 * @param {object} deps 依赖注入
 * @param {number} charIdx 角色索引
 * @param {string} avatar 角色头像文件名（用于回退 API）
 * @returns {Promise<Array>} 聊天数组，每项含 file_name / chat_items / last_mes / file_size 等
 */
export async function getCharChatsCore(deps, charIdx, avatar) {
  const getChats = deps.getPastCharacterChatsFunc?.();
  if (typeof getChats === "function") {
    try {
      const list = await getChats(charIdx);
      if (Array.isArray(list) && list.length) return list;
    } catch (err) {
      console.warn("[NovelReader] getPastCharacterChats 失败，回退 API:", err);
    }
  }
  // 回退：POST /api/characters/chats
  // 注意：该 API 在缺少 CSRF header 或出错时返回 HTTP 200 + body { error: true }，必须显式识别
  const headers = deps.getRequestHeaders();
  try {
    const res = await fetch("/api/characters/chats", {
      method: "POST",
      headers,
      body: JSON.stringify({ avatar_url: avatar }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // 后端错误（HTTP 200 但 body.error === true）
    if (json && typeof json === "object" && json.error === true) {
      console.warn("[NovelReader] 聊天列表 API 返回错误:", json);
      return [];
    }
    // 正常：数组直接返回；对象（老版本 ST）取 Object.values 转数组
    if (Array.isArray(json)) return json;
    if (json && typeof json === "object") {
      const values = Object.values(json);
      if (values.length) return values;
    }
    return [];
  } catch (err) {
    console.warn("[NovelReader] 聊天列表 API 失败:", err);
    return [];
  }
}

/**
 * 获取某聊天完整消息数组（POST /api/chats/get）。
 * 参考 ST 官方 getChatsFromFiles：请求体必须含 ch_name（角色名）+ file_name（不带 .jsonl）+ avatar_url。
 * 返回数组的首条是元数据消息（ST 会 shift 掉），此处同样移除。
 * @param {object} deps 依赖注入
 * @param {string} avatar 角色头像文件名
 * @param {string} fileName 聊天文件名（带 .jsonl，内部去除扩展名）
 * @returns {Promise<Array<object>>} 消息数组（mes.name / mes.is_user / mes.mes 等）
 */
export async function getChatMessagesCore(deps, avatar, fileName) {
  const headers = deps.getRequestHeaders();
  try {
    // 由 avatar 反查角色名（ch_name 是后端定位聊天文件的关键）
    // 优先 deps.getCharacters（bookshelf 场景），兜底从 ST context 直接取
    let chars = deps.getCharacters ? deps.getCharacters() : [];
    if (!chars.length) {
      const ctx = deps.getStContext ? deps.getStContext() : null;
      chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
    }
    const char = chars.find((c) => c.avatar === avatar);
    const ch_name = char?.name || "";
    // ST 官方请求：file_name 不带 .jsonl 扩展名
    const baseName = String(fileName || "").replace(/\.jsonl$/i, "");

    const res = await fetch("/api/chats/get", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ch_name,
        file_name: baseName,
        avatar_url: avatar,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // 后端错误（HTTP 200 + body.error）
    if (
      json &&
      typeof json === "object" &&
      !Array.isArray(json) &&
      json.error === true
    ) {
      console.warn("[NovelReader] 读取聊天内容 API 返回错误:", json);
      return [];
    }
    if (!Array.isArray(json)) return [];
    // 移除首条元数据消息（与 ST getChatsFromFiles 行为一致）
    if (
      json.length &&
      json[0] &&
      json[0].is_system === false &&
      !("mes" in json[0]) &&
      json[0].name === undefined
    ) {
      json.shift();
    } else if (
      json.length &&
      json[0] &&
      typeof json[0] === "object" &&
      !("mes" in json[0]) &&
      !("is_user" in json[0])
    ) {
      json.shift();
    }
    return json;
  } catch (err) {
    console.warn("[NovelReader] 读取聊天内容失败:", avatar, fileName, err);
    return [];
  }
}
