import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const layouts = require("../assets/js/case-photo-layouts.js");
const cropMath = require("../assets/js/case-crop-math.js");

const expected = [
  ["4:3", "horizontal", 1200, 900, 600, 900],
  ["4:3", "vertical", 1200, 900, 1200, 450],
  ["3:4", "horizontal", 900, 1200, 450, 1200],
  ["3:4", "vertical", 900, 1200, 900, 600],
  ["1:1", "horizontal", 1200, 1200, 600, 1200],
  ["1:1", "vertical", 1200, 1200, 1200, 600]
];

for (const [ratio, direction, canvasWidth, canvasHeight, slotWidth, slotHeight] of expected) {
  const layout = layouts.getLayout(ratio, direction);
  assert.equal(layout.canvasWidth, canvasWidth, `${ratio} ${direction} canvas width`);
  assert.equal(layout.canvasHeight, canvasHeight, `${ratio} ${direction} canvas height`);
  assert.equal(layout.slotWidth, slotWidth, `${ratio} ${direction} slot width`);
  assert.equal(layout.slotHeight, slotHeight, `${ratio} ${direction} slot height`);
  assert.equal(slotWidth * (direction === "horizontal" ? 2 : 1), canvasWidth);
  assert.equal(slotHeight * (direction === "vertical" ? 2 : 1), canvasHeight);
}

assert.equal(layouts.normalizeRatio("unknown"), "4:3");
assert.equal(layouts.normalizeDirection(null), "horizontal");

// ── Crop math ──
const sources = [
  [4096, 3072],
  [3000, 4000],
  [2400, 2400],
  [4096, 1024]
];
const controlPositions = [
  [1, 0, 0],
  [1.75, -100, 100],
  [2.4, 42.5, -13.5],
  [3, 100, -100]
];

for (const [ratio, direction] of expected.map(row => [row[0], row[1]])) {
  const layout = layouts.getLayout(ratio, direction);
  for (const [sourceWidth, sourceHeight] of sources) {
    const geometry = {
      sourceWidth, sourceHeight, slotWidth: layout.slotWidth, slotHeight: layout.slotHeight
    };
    for (const [zoom, x, y] of controlPositions) {
      const rect = cropMath.cropRectFromControls({ ...geometry, zoom, x, y });
      const label = `${ratio} ${direction} ${sourceWidth}x${sourceHeight} @${zoom}/${x}/${y}`;

      // The crop window matches the slot aspect ratio and stays inside the source.
      assert.ok(
        Math.abs(rect.sourceWidth / rect.sourceHeight - layout.slotWidth / layout.slotHeight) < 1e-9,
        `${label} keeps the slot aspect ratio`
      );
      assert.ok(rect.sourceX >= 0 && rect.sourceY >= 0, `${label} has no negative origin`);
      assert.ok(rect.sourceX + rect.sourceWidth <= sourceWidth + 1e-6, `${label} stays inside the width`);
      assert.ok(rect.sourceY + rect.sourceHeight <= sourceHeight + 1e-6, `${label} stays inside the height`);

      // A stored rectangle must survive normalization and restore the same framing.
      // Stored rects are rounded to 1e-6, so allow well under a pixel of drift.
      const tolerance = Math.max(sourceWidth, sourceHeight) * 1e-4;
      assert.ok(cropMath.normalizeCropRect(rect.normalized), `${label} produces a storable rect`);
      const restored = cropMath.controlsFromCropRect({ ...geometry, rect: rect.normalized });
      const reapplied = cropMath.cropRectFromControls({ ...geometry, ...restored });
      assert.ok(Math.abs(reapplied.sourceX - rect.sourceX) < tolerance, `${label} restores sourceX`);
      assert.ok(Math.abs(reapplied.sourceY - rect.sourceY) < tolerance, `${label} restores sourceY`);
      assert.ok(Math.abs(reapplied.sourceWidth - rect.sourceWidth) < tolerance, `${label} restores width`);
      assert.ok(Math.abs(reapplied.sourceHeight - rect.sourceHeight) < tolerance, `${label} restores height`);
    }
  }
}

// Zoom stays within the slider bounds even when a stored rect asks for more.
const tinyRect = { x: .4, y: .4, width: .01, height: .01 };
const clamped = cropMath.controlsFromCropRect({
  sourceWidth: 4096, sourceHeight: 3072, slotWidth: 600, slotHeight: 900, rect: tinyRect
});
assert.equal(clamped.zoom, cropMath.MAX_ZOOM);
assert.ok(clamped.x >= -100 && clamped.x <= 100);
assert.ok(clamped.y >= -100 && clamped.y <= 100);

// Unusable rectangles fall back to the neutral position instead of wedging the dialog.
for (const bad of [null, undefined, {}, { x: 0, y: 0, width: 0, height: .5 }, { x: .8, y: 0, width: .5, height: .5 }]) {
  assert.equal(cropMath.normalizeCropRect(bad), null);
  assert.deepEqual(
    cropMath.controlsFromCropRect({
      sourceWidth: 1200, sourceHeight: 900, slotWidth: 600, slotHeight: 900, rect: bad
    }),
    { zoom: cropMath.MIN_ZOOM, x: 0, y: 0 }
  );
}

const rows = [{
  id: "case-layout-test",
  title: "版型測試",
  status: "published",
  display_order: 1,
  concern_tags: [],
  summary: "",
  consent_confirmed: true,
  case_treatments: [],
  case_photo_pairs: [
    {
      id: "pair-new",
      label: "正面",
      sort_order: 1,
      before_public_path: "case/before.webp",
      after_public_path: "case/after.webp",
      published_canvas_ratio: "3:4",
      published_split_direction: "vertical"
    },
    {
      id: "pair-legacy",
      label: "側面",
      sort_order: 2,
      before_public_path: "case/legacy-before.webp",
      after_public_path: "case/legacy-after.webp"
    }
  ]
}];
let selectedColumns = "";
const query = {
  select(columns) { selectedColumns = columns; return this; },
  eq() { return this; },
  order() { return this; },
  then(resolve) { return Promise.resolve({ data: rows, error: null }).then(resolve); }
};
const client = {
  from() { return query; },
  storage: {
    from() {
      return { getPublicUrl: path => ({ data: { publicUrl: `https://images.example/${path}` } }) };
    }
  }
};
const context = {
  window: {
    SUPABASE_CONFIG: { url: "https://example.supabase.co", publishableKey: "test" },
    CasePhotoLayouts: layouts,
    supabase: { createClient: () => client }
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("../assets/js/supabase-cases.js", import.meta.url), "utf8"), context);
const result = await context.window.CaseRepository.loadPublishedCases();
assert.equal(result.cases[0].beforeAfterPairs[0].canvasRatio, "3:4");
assert.equal(result.cases[0].beforeAfterPairs[0].splitDirection, "vertical");
assert.equal(result.cases[0].beforeAfterPairs[1].canvasRatio, "4:3");
assert.equal(result.cases[0].beforeAfterPairs[1].splitDirection, "horizontal");
assert.match(selectedColumns, /published_canvas_ratio/);
assert.doesNotMatch(selectedColumns, /source_private_path|crop_rect/);

console.log("Verified all six case photo layouts, crop round trips, public mapping and legacy defaults.");
