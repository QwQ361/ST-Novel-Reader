// DOM 辅助函数：触摸/鼠标坐标兼容、元素滚动到视野中央。

/**
 * 获取事件坐标，兼容触摸与鼠标事件。
 * @param {Event} e 事件对象
 * @returns {{clientX: number, clientY: number}}
 */
export function getEventClientX(e) {
  if (!e) return { clientX: 0, clientY: 0 };
  if (e.touches && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return {
      clientX: e.changedTouches[0].clientX,
      clientY: e.changedTouches[0].clientY,
    };
  }
  return { clientX: e.clientX ?? 0, clientY: e.clientY ?? 0 };
}

/**
 * 将目标元素滚动到滚动容器视野中央（垂直方向）。
 * @param {HTMLElement} element 目标元素
 * @param {HTMLElement|null} container 滚动容器；缺省时用最近的可滚动祖先
 */
export function scrollElementIntoViewCentered(element, container = null) {
  if (!element) return;
  const scrollBox =
    container || element.closest(".novel-scroll") || element.parentElement;
  if (!scrollBox) return;
  const targetTop = element.offsetTop;
  const targetHeight = element.offsetHeight || 0;
  const viewportHeight = scrollBox.clientHeight || 0;
  scrollBox.scrollTo({
    top: targetTop - (viewportHeight - targetHeight) / 2,
    behavior: "smooth",
  });
}
