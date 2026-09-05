(function (root, factory) {
  "use strict";

  const api = factory();
  root.CaseCropMath = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 3;

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const rounded = value => Math.round(value * 1000000) / 1000000;

  // Crop rectangles are stored normalized (0..1 of the source image) so they stay
  // valid regardless of the pixel size of the sanitized source.
  function normalizeCropRect(value) {
    if (!value || typeof value !== "object") return null;
    const rect = {
      x: Number(value.x),
      y: Number(value.y),
      width: Number(value.width),
      height: Number(value.height)
    };
    if (!Object.values(rect).every(Number.isFinite)) return null;
    if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) return null;
    if (rect.x + rect.width > 1.0001 || rect.y + rect.height > 1.0001) return null;
    return rect;
  }

  // Largest region of the source that matches the slot aspect ratio (zoom === 1).
  function baseCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const targetRatio = targetWidth / targetHeight;
    if (sourceWidth / sourceHeight > targetRatio) {
      return { width: sourceHeight * targetRatio, height: sourceHeight };
    }
    return { width: sourceWidth, height: sourceWidth / targetRatio };
  }

  // Slider positions (zoom 1..3, x/y -100..100) -> source-pixel crop rectangle.
  function cropRectFromControls({ sourceWidth, sourceHeight, slotWidth, slotHeight, zoom, x, y }) {
    const base = baseCropRect(sourceWidth, sourceHeight, slotWidth, slotHeight);
    const safeZoom = clamp(Number(zoom) || MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
    const width = base.width / safeZoom;
    const height = base.height / safeZoom;
    const maxX = Math.max(0, sourceWidth - width);
    const maxY = Math.max(0, sourceHeight - height);
    const xProgress = (Number(x) + 100) / 200;
    const yProgress = (Number(y) + 100) / 200;
    return {
      sourceX: maxX * xProgress,
      sourceY: maxY * yProgress,
      sourceWidth: width,
      sourceHeight: height,
      maxX,
      maxY,
      normalized: {
        x: rounded(maxX * xProgress / sourceWidth),
        y: rounded(maxY * yProgress / sourceHeight),
        width: rounded(width / sourceWidth),
        height: rounded(height / sourceHeight)
      }
    };
  }

  // Stored crop rectangle -> slider positions. Returns the neutral position when the
  // rectangle is missing or unusable, so a bad value never wedges the dialog.
  function controlsFromCropRect({ sourceWidth, sourceHeight, slotWidth, slotHeight, rect }) {
    const normalized = normalizeCropRect(rect);
    if (!normalized) return { zoom: MIN_ZOOM, x: 0, y: 0 };
    const base = baseCropRect(sourceWidth, sourceHeight, slotWidth, slotHeight);
    const width = normalized.width * sourceWidth;
    const height = normalized.height * sourceHeight;
    const zoom = clamp(Math.min(base.width / width, base.height / height), MIN_ZOOM, MAX_ZOOM);
    const cropWidth = base.width / zoom;
    const cropHeight = base.height / zoom;
    const maxX = Math.max(0, sourceWidth - cropWidth);
    const maxY = Math.max(0, sourceHeight - cropHeight);
    const centerX = (normalized.x + normalized.width / 2) * sourceWidth;
    const centerY = (normalized.y + normalized.height / 2) * sourceHeight;
    const sourceX = clamp(centerX - cropWidth / 2, 0, maxX);
    const sourceY = clamp(centerY - cropHeight / 2, 0, maxY);
    return {
      zoom,
      x: maxX ? sourceX / maxX * 200 - 100 : 0,
      y: maxY ? sourceY / maxY * 200 - 100 : 0
    };
  }

  return Object.freeze({
    MIN_ZOOM, MAX_ZOOM, normalizeCropRect, baseCropRect, cropRectFromControls, controlsFromCropRect
  });
});
