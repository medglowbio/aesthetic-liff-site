(function (root, factory) {
  "use strict";

  const api = factory();
  root.CasePhotoLayouts = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const ratios = Object.freeze({
    "4:3": Object.freeze({ value: "4:3", label: "4:3", cssClass: "ratio-4-3", canvasWidth: 1200, canvasHeight: 900 }),
    "3:4": Object.freeze({ value: "3:4", label: "3:4", cssClass: "ratio-3-4", canvasWidth: 900, canvasHeight: 1200 }),
    "1:1": Object.freeze({ value: "1:1", label: "1:1", cssClass: "ratio-1-1", canvasWidth: 1200, canvasHeight: 1200 })
  });
  const directions = Object.freeze({
    horizontal: Object.freeze({ value: "horizontal", label: "左右排列", cssClass: "direction-horizontal" }),
    vertical: Object.freeze({ value: "vertical", label: "上下排列", cssClass: "direction-vertical" })
  });

  function normalizeRatio(value) {
    return ratios[value] ? value : "4:3";
  }

  function normalizeDirection(value) {
    return directions[value] ? value : "horizontal";
  }

  function getLayout(ratioValue, directionValue) {
    const ratio = ratios[normalizeRatio(ratioValue)];
    const direction = directions[normalizeDirection(directionValue)];
    const horizontal = direction.value === "horizontal";
    return Object.freeze({
      ratio: ratio.value,
      direction: direction.value,
      ratioLabel: ratio.label,
      directionLabel: direction.label,
      ratioClass: ratio.cssClass,
      directionClass: direction.cssClass,
      canvasWidth: ratio.canvasWidth,
      canvasHeight: ratio.canvasHeight,
      slotWidth: horizontal ? ratio.canvasWidth / 2 : ratio.canvasWidth,
      slotHeight: horizontal ? ratio.canvasHeight : ratio.canvasHeight / 2
    });
  }

  return Object.freeze({ ratios, directions, normalizeRatio, normalizeDirection, getLayout });
});
