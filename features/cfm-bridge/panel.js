// features/cfm-bridge/panel.js
// CFM 文件夹过滤浮动面板（复用于顶栏角色搜索 + 设置弹窗预设搜索）。
// 参照 NOVEL-READER-BUTTON-UI-ALIGN.md §6（CFM native-filters 面板）：
//   - 按钮：菜单按钮图标（menu_button 风格），点击开合面板
//   - 面板：fixed 浮动层，工具栏（标题 + 展开/收起全部）+ 文件夹树
//   - 树节点：箭头（旋转指示展开）+ 文件夹图标 + 名称，层级缩进
//   - 一键展开/收起：expandedSet 集合 + 重渲染树
//   - 点击面板外部自动关闭

/**
 * 创建文件夹过滤浮动面板控制器。
 * @param {object} options
 * @param {HTMLElement} options.anchorEl 按钮元素（面板锚定在其下方）
 * @param {string} options.type "chars" | "presets"
 * @param {Function} options.getBridge 返回 cfmBridge core（含 buildFolderTreeHtml / getAllFolderIds / isCfmInstalled）
 * @param {Function} options.onSelect (folderId: string) => void 选中文件夹回调
 * @param {string} [options.currentFilter] 当前选中过滤值
 * @returns {{ refresh: Function, setFilter: Function, destroy: Function }}
 */
export function createCfmFolderPanel(options = {}) {
  const {
    anchorEl,
    type = "chars",
    getBridge,
    onSelect = () => {},
    currentFilter = "__all__",
  } = options;

  let expandedSet = new Set();
  let filter = currentFilter;
  let panelEl = null;
  let treeContainer = null;
  let mounted = false;

  /** 重新构建树（重渲染驱动，参照 CFM 展开/收起全部逻辑） */
  function renderTree() {
    if (!treeContainer) return;
    const bridge = getBridge?.();
    if (!bridge) return;
    treeContainer.innerHTML = bridge.buildFolderTreeHtml(
      type,
      expandedSet,
      filter,
    );

    // 节点点击：箭头切换展开；行点击选中过滤
    treeContainer.querySelectorAll(".novel-cfm-tnode").forEach((node) => {
      const id = node.dataset.id;
      const arrow = node.querySelector(".novel-cfm-tnode-arrow");
      // 箭头点击：切换展开状态 → 重渲染
      arrow?.addEventListener("click", (e) => {
        e.stopPropagation();
        const children = node.dataset.hasChildren === "1";
        if (!children) return;
        if (expandedSet.has(id)) expandedSet.delete(id);
        else expandedSet.add(id);
        renderTree();
      });
      // 行点击：选中过滤值 → 重渲染 + 回调
      node.addEventListener("click", () => {
        filter = id;
        renderTree();
        onSelect(id);
      });
    });
  }

  /** 展开全部：所有文件夹 id 加入集合 + 重渲染 */
  function expandAll() {
    const bridge = getBridge?.();
    if (!bridge) return;
    for (const id of bridge.getAllFolderIds(type)) expandedSet.add(id);
    renderTree();
  }

  /** 收起全部：清空集合 + 重渲染 */
  function collapseAll() {
    expandedSet.clear();
    renderTree();
  }

  /** 面板 HTML（工具栏 + 树容器） */
  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "novel-cfm-panel";
    panel.innerHTML = `
      <div class="novel-cfm-toolbar">
        <span class="novel-cfm-toolbar-title"><i class="fa-solid fa-folder-tree"></i> 文件夹过滤</span>
        <span class="novel-cfm-toolbar-actions">
          <i class="fa-solid fa-angles-down novel-cfm-expand-all" title="展开全部"></i>
          <i class="fa-solid fa-angles-up novel-cfm-collapse-all" title="收起全部"></i>
        </span>
      </div>
      <div class="novel-cfm-tree"></div>`;
    return panel;
  }

  /** 定位面板：锚定按钮下方，视口越界自动翻转 */
  function positionPanel() {
    if (!panelEl || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const margin = 6;
    let left = rect.left;
    let top = rect.bottom + margin;
    // 水平越界：向右翻转（贴右边缘）
    if (left + panelRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - panelRect.width - margin);
    }
    // 垂直越界：翻转到按钮上方
    if (top + panelRect.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - panelRect.height - margin);
    }
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
  }

  /** 关闭面板（移除 DOM + 解绑全局监听） */
  function close() {
    if (!mounted) return;
    panelEl?.remove();
    panelEl = null;
    treeContainer = null;
    mounted = false;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    window.removeEventListener("resize", positionPanel);
  }

  /** 点击面板外部关闭（capture 阶段，阻止事件继续冒泡到内部处理） */
  function onDocMouseDown(e) {
    if (!mounted) return;
    if (!panelEl?.contains(e.target) && !anchorEl.contains(e.target)) {
      close();
    }
  }

  /** 打开/切换面板 */
  function toggle() {
    if (mounted) {
      close();
      return;
    }
    const bridge = getBridge?.();
    if (!bridge || !bridge.isCfmInstalled()) return;

    panelEl = buildPanel();
    treeContainer = panelEl.querySelector(".novel-cfm-tree");
    document.body.appendChild(panelEl);

    // 工具栏：展开/收起全部
    panelEl
      .querySelector(".novel-cfm-expand-all")
      ?.addEventListener("click", (e) => {
        e.stopPropagation();
        expandAll();
      });
    panelEl
      .querySelector(".novel-cfm-collapse-all")
      ?.addEventListener("click", (e) => {
        e.stopPropagation();
        collapseAll();
      });

    renderTree();
    positionPanel();

    // 全局监听：点击外部关闭 + 窗口缩放重定位
    mounted = true;
    document.addEventListener("mousedown", onDocMouseDown, true);
    window.addEventListener("resize", positionPanel);
  }

  /** 外部刷新（如文件夹被修改后重建树） */
  function refresh() {
    if (!mounted) return;
    renderTree();
    positionPanel();
  }

  /** 外部设置当前过滤值（同步高亮，不触发回调） */
  function setFilter(value) {
    filter = value;
    if (mounted) renderTree();
  }

  return { toggle, refresh, setFilter, close };
}
