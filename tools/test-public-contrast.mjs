import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const rootBlocks = source.match(/:root\s*\{/g) || [];

assert.equal(rootBlocks.length, 1, "index.html must define one canonical :root palette");

const root = source.match(/:root\s*\{([\s\S]*?)\}/)?.[1] || "";
const expectedColors = {
  cream: "#F7F3EE",
  "warm-white": "#FDFAF6",
  paper: "#F0EAE2",
  ink: "#1A1714",
  "ink-soft": "#3D3830",
  "ink-muted": "#6F665D",
  "gold-accent": "#B8965A",
  "gold-text": "#806033",
  "gold-pale": "#F0E5D0",
};

const colors = {};
for (const [name, expected] of Object.entries(expectedColors)) {
  const value = root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  assert.equal(value?.toUpperCase(), expected, `--${name} keeps the approved palette value`);
  colors[name] = value;
}

function luminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function assertContrast(foreground, background, minimum, label) {
  const ratio = contrastRatio(colors[foreground], colors[background]);
  assert.ok(ratio >= minimum, `${label} contrast is ${ratio.toFixed(2)}:1; expected ${minimum}:1`);
}

for (const background of ["cream", "warm-white", "paper", "gold-pale"]) {
  assertContrast("gold-text", background, 4.5, `gold text on ${background}`);
  assertContrast("ink-muted", background, 4.5, `muted text on ${background}`);
}
assertContrast("warm-white", "gold-text", 4.5, "light text on gold actions");

const retiredPalette = [
  "#e7e0d4", "#f5f1e9", "#eee8dd", "#9b7a4d", "#b59b72", "#ded3bf",
  "#ece5d9", "#dfd7ca", "#f2ede4", "#f1ebe2", "#fbf7ef", "#fbf8f1",
];
for (const color of retiredPalette) {
  assert.doesNotMatch(source, new RegExp(color, "i"), `${color} must not bypass the canonical palette`);
}

assert.doesNotMatch(source, /var\(--gold\)/, "ambiguous --gold usage must not return");
assert.match(source, /border-bottom-color:\s*var\(--gold-accent\)/);
assert.match(source, /color:\s*var\(--gold-text\)/);
assert.match(source, /background:\s*var\(--warm-white\)/);

console.log("Verified the public palette, semantic color roles and WCAG AA text contrast.");
