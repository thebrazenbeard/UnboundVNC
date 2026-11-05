// Keep the keyboard user's place even when the grid replaces its button DOM.
export function findDeviceAction(grid, action, id) {
  if (!grid || !action || !id) return null;
  return [...grid.querySelectorAll('[data-action][data-id]')]
    .find(button => button.dataset.action === action && button.dataset.id === id) ?? null;
}

export function captureFocus(element) {
  const actionButton = element?.closest?.('[data-action][data-id]');
  return {
    element: element ?? null,
    action: actionButton?.dataset.action ?? null,
    deviceId: actionButton?.dataset.id ?? null,
  };
}

export function isToolbarEscape(event) {
  return event.key === 'Escape' && event.ctrlKey === true && event.altKey === true
    && event.shiftKey === true && event.metaKey !== true;
}

function availableForFocus(element) {
  return Boolean(element?.isConnected && !element.disabled && !element.closest?.('[hidden], [inert]'));
}

export function restoreFocus(saved, grid, fallback) {
  const original = saved?.element;
  const replacement = findDeviceAction(grid, saved?.action, saved?.deviceId);
  const target = (availableForFocus(original) ? original : null)
    ?? (availableForFocus(replacement) ? replacement : null)
    ?? (availableForFocus(fallback) ? fallback : null);
  target?.focus({ preventScroll: true });
  return target ?? null;
}
