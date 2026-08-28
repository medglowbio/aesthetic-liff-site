import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function extractConst(name) {
  const marker = `const ${name} =`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${name}`);
  let i = start + marker.length;
  while (/\s/.test(html[i])) i++;
  const open = html[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) throw new Error(`Unsupported ${name} initializer`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let j = i; j < html.length; j++) {
    const ch = html[j];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    if (ch === close && --depth === 0) {
      return Function(`"use strict"; return (${html.slice(i, j + 1)});`)();
    }
  }
  throw new Error(`Unclosed ${name}`);
}

const DATA = extractConst("DATA");
const DETAIL_MAP = extractConst("DETAIL_MAP");
const CATEGORY_IMAGE_MAP = extractConst("CATEGORY_IMAGE_MAP");

const sql = value => value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${sql(JSON.stringify(value ?? []))}::jsonb`;
const array = value => `array[${(value || []).map(sql).join(",")}]::text[]`;
const slug = value => String(value).normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

function splitNotes(notes = "") {
  const text = String(notes);
  const after = text.search(/【(?:術後|使用後)注意事項】/);
  if (after < 0) return { pre: text, post: "" };
  return { pre: text.slice(0, after).trim(), post: text.slice(after).trim() };
}

const categories = [];
const subcategories = [];
const treatments = new Map();
const links = [];

DATA.categories.forEach((category, categoryIndex) => {
  categories.push({
    id: category.id,
    group: category.group || "type",
    name: category.name,
    summary: category.concern || "",
    icon: category.icon || "",
    image: CATEGORY_IMAGE_MAP[category.id] || "",
    imageAlt: `${category.name} 分類圖片`,
    sortOrder: (categoryIndex + 1) * 10
  });
  let treatmentOrder = 0;
  category.subcategories.forEach((subcategory, subcategoryIndex) => {
    const virtualAll = /^(全部療程|全部保養品|全部顯示)$/.test(subcategory.name);
    const subcategoryId = virtualAll ? "" : `${category.id}-${slug(subcategory.name) || `group-${subcategoryIndex + 1}`}`;
    if (!virtualAll) subcategories.push({
      id: subcategoryId,
      categoryId: category.id,
      name: subcategory.name,
      sortOrder: (subcategoryIndex + 1) * 10
    });
    subcategory.treatments.forEach(item => {
      treatmentOrder++;
      if (!treatments.has(item.id)) {
        const detail = DETAIL_MAP[item.name] || {};
        const noteParts = splitNotes(detail.notes || "");
        const product = category.id === "aespa_products" || category.id === "skincare_products";
        treatments.set(item.id, {
          id: item.id,
          name: item.name,
          categoryId: category.id,
          categoryName: category.name,
          contentType: product ? "product" : "treatment",
          device: item.device || "",
          shortDescription: item.desc || "",
          tags: item.tags || [],
          licenseName: detail.licenseName || "",
          licenseNo: detail.licenseNo || "",
          fullDescription: detail.desc || item.desc || "",
          suitable: detail.suitable || "",
          info: detail.info || [],
          preNotes: noteParts.pre,
          postNotes: noteParts.post,
          image: detail.image || "",
          imageAlt: detail.imageAlt || `${item.name} 圖片`,
          imageCaption: detail.imageCaption || "",
          sortOrder: treatmentOrder * 10
        });
      }
      if (!virtualAll) links.push({ treatmentId: item.id, subcategoryId, sortOrder: treatmentOrder * 10 });
    });
  });
});

const lines = [
  "-- Generated from index.html. Do not hand-edit; rerun tools/generate-catalog-seed.mjs.",
  "begin;",
  ...categories.map(c => `insert into public.treatment_categories (id,group_key,name,summary,icon,image_url,image_alt,sort_order,visible,status,published_at) values (${sql(c.id)},${sql(c.group)},${sql(c.name)},${sql(c.summary)},${sql(c.icon)},${sql(c.image)},${sql(c.imageAlt)},${c.sortOrder},true,'published',now()) on conflict (id) do update set group_key=excluded.group_key,name=excluded.name,summary=excluded.summary,icon=excluded.icon,image_url=excluded.image_url,image_alt=excluded.image_alt,sort_order=excluded.sort_order,visible=true,status='published';`),
  ...subcategories.map(s => `insert into public.treatment_subcategories (id,category_id,name,sort_order,visible,status,published_at) values (${sql(s.id)},${sql(s.categoryId)},${sql(s.name)},${s.sortOrder},true,'published',now()) on conflict (id) do update set category_id=excluded.category_id,name=excluded.name,sort_order=excluded.sort_order,visible=true,status='published';`),
  ...[...treatments.values()].map(t => `insert into public.treatment_catalog (id,name,category_id,category_name,active,content_type,device_subtitle,short_description,tags,license_name,license_no,full_description,suitable,info,pre_notes,post_notes,image_url,image_alt,image_caption,sort_order,visible,status,published_at) values (${sql(t.id)},${sql(t.name)},${sql(t.categoryId)},${sql(t.categoryName)},true,${sql(t.contentType)},${sql(t.device)},${sql(t.shortDescription)},${array(t.tags)},${sql(t.licenseName)},${sql(t.licenseNo)},${sql(t.fullDescription)},${sql(t.suitable)},${json(t.info)},${sql(t.preNotes)},${sql(t.postNotes)},${sql(t.image)},${sql(t.imageAlt)},${sql(t.imageCaption)},${t.sortOrder},true,'published',now()) on conflict (id) do update set name=excluded.name,category_id=excluded.category_id,category_name=excluded.category_name,active=true,content_type=excluded.content_type,device_subtitle=excluded.device_subtitle,short_description=excluded.short_description,tags=excluded.tags,license_name=excluded.license_name,license_no=excluded.license_no,full_description=excluded.full_description,suitable=excluded.suitable,info=excluded.info,pre_notes=excluded.pre_notes,post_notes=excluded.post_notes,image_url=excluded.image_url,image_alt=excluded.image_alt,image_caption=excluded.image_caption,sort_order=excluded.sort_order,visible=true,status='published';`),
  "delete from public.treatment_subcategory_links;",
  ...links.map(l => `insert into public.treatment_subcategory_links (treatment_id,subcategory_id,sort_order) values (${sql(l.treatmentId)},${sql(l.subcategoryId)},${l.sortOrder}) on conflict (treatment_id,subcategory_id) do update set sort_order=excluded.sort_order;`),
  "commit;",
  ""
];

fs.writeFileSync(path.join(root, "supabase/migrations/202608280002_seed_treatment_catalog.sql"), lines.join("\n"));
fs.writeFileSync(path.join(root, "assets/data/catalog-static-snapshot.json"), JSON.stringify({ categories, subcategories, treatments: [...treatments.values()], links }, null, 2));
console.log(JSON.stringify({ categories: categories.length, subcategories: subcategories.length, treatments: treatments.size, links: links.length }, null, 2));
