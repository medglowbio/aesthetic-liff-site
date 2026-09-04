import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const layouts = require("../assets/js/case-photo-layouts.js");

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

console.log("Verified all six case photo layouts, public mapping and legacy defaults.");
