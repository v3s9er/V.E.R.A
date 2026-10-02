// Electron screen rectangles use device-independent pixels, including on HiDPI.
export function fitWindowBounds(bounds, area) {
  if (![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) throw new Error('Invalid display work area');
  const maxWidth = Math.max(1, Math.floor(area.width));
  const maxHeight = Math.max(1, Math.floor(area.height));
  const minWidth = Math.min(760, maxWidth), minHeight = Math.min(620, maxHeight);
  const width = Math.max(minWidth, Math.min(maxWidth, Math.round(bounds.width)));
  const height = Math.max(minHeight, Math.min(maxHeight, Math.round(bounds.height)));
  const x = Math.round(Math.max(area.x, Math.min(area.x + maxWidth - width, bounds.x)));
  const y = Math.round(Math.max(area.y, Math.min(area.y + maxHeight - height, bounds.y)));
  return { x, y, width, height, minWidth, minHeight };
}

export function initialWindowBounds(area) {
  const width = Math.min(1320, Math.max(1, area.width - 32));
  const height = Math.min(860, Math.max(1, area.height - 32));
  return fitWindowBounds({ x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height }, area);
}
