(function () {
  "use strict";
  const config = window.SUPABASE_CONFIG || {};
  const db = window.supabase.createClient(config.url, config.publishableKey, { auth: { persistSession: true } });
  const $ = id => document.getElementById(id);
  const statusLabels = { draft: "草稿", pending_review: "待審核", changes_requested: "退回修改", published: "已發布", unpublished: "已下架", archived: "已封存" };
  let session;
  let profile;
  let kind = "treatment";
  let live = { treatment: [], category: [], subcategory: [] };
  let revisions = [];
  let current = null;
  let currentRevision = null;
  let pendingImageBlob = null;
  let pendingImageSource = null;
  let pendingImageUrl = "";
  let search = "";
  let busy = false;
  let openRequest = 0;
  let retryOpen = null;

  const isReviewer = () => profile?.role === "reviewer";
  const uid = () => session?.user?.id;
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const parseList = value => [...new Set(String(value || "").split(/[,，\n]/).map(v => v.trim()).filter(Boolean))];
  const slug = value => String(value || "item").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "item";
  const makeId = (type, name) => `${type}-${slug(name)}-${crypto.randomUUID().slice(0, 8)}`;
  const typeLabels = { treatment: "療程／保養品", category: "大分類", subcategory: "子分類" };

  function parseJson(value) {
    if (typeof value !== "string") return value;
    const source = value.trim();
    if (!source || !["[", "{"].includes(source[0])) return value;
    try { return JSON.parse(source); } catch (_) { return value; }
  }

  function normalizeArray(value) {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed == null || parsed === "") return [];
    return parseList(parsed);
  }

  function normalizeInfo(value) {
    const parsed = parseJson(value);
    if (Array.isArray(parsed)) {
      return parsed.map(item => {
        if (typeof item === "string") {
          const parts = item.split(/[｜|]/);
          return { k: (parts.shift() || "").trim(), v: parts.join("｜").trim() };
        }
        return { k: String(item?.k ?? item?.label ?? item?.name ?? "").trim(), v: String(item?.v ?? item?.value ?? item?.text ?? "").trim() };
      }).filter(item => item.k);
    }
    if (parsed && typeof parsed === "object") return Object.entries(parsed).map(([k, v]) => ({ k, v: String(v ?? "") }));
    return String(parsed || "").split("\n").map(line => {
      const parts = line.split(/[｜|]/);
      return { k: (parts.shift() || "").trim(), v: parts.join("｜").trim() };
    }).filter(item => item.k);
  }

  function normalizeBoolean(value, fallback = true) {
    if (typeof value === "boolean") return value;
    if (value == null || value === "") return fallback;
    return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
  }

  function normalizePercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 50;
  }

  function normalizePayload(type, payload = {}, base = {}) {
    const parsedPayload = parseJson(payload);
    const parsedBase = parseJson(base);
    const baseObject = parsedBase && typeof parsedBase === "object" && !Array.isArray(parsedBase) ? parsedBase : {};
    const payloadObject = parsedPayload && typeof parsedPayload === "object" && !Array.isArray(parsedPayload) ? parsedPayload : {};
    const cleanOverlay = Object.fromEntries(Object.entries(payloadObject).filter(([, value]) => value !== undefined && value !== null));
    const p = { ...baseObject, ...cleanOverlay };
    const common = {
      ...p,
      name: String(p.name || ""),
      sortOrder: Number.isFinite(Number(p.sortOrder ?? p.sort_order)) ? Number(p.sortOrder ?? p.sort_order) : 100,
      visible: normalizeBoolean(p.visible, true),
      image: p.image || p.image_url || "",
      imageAlt: String(p.imageAlt ?? p.image_alt ?? ""),
      imageCaption: String(p.imageCaption ?? p.image_caption ?? ""),
      imageFocusX: normalizePercent(p.imageFocusX ?? p.image_focus_x),
      imageFocusY: normalizePercent(p.imageFocusY ?? p.image_focus_y)
    };
    if (type === "category") return { ...common, group: String(p.group ?? p.group_key ?? "type"), summary: String(p.summary || ""), icon: String(p.icon || "") };
    if (type === "subcategory") return { ...common, categoryId: String(p.categoryId ?? p.category_id ?? "") };
    return {
      ...common,
      categoryId: String(p.categoryId ?? p.category_id ?? ""),
      contentType: ["treatment", "product"].includes(p.contentType ?? p.content_type) ? (p.contentType ?? p.content_type) : "treatment",
      device: String(p.device ?? p.device_subtitle ?? ""),
      shortDescription: String(p.shortDescription ?? p.short_description ?? ""),
      tags: normalizeArray(p.tags).map(value => String(value).trim()).filter(Boolean),
      subcategoryIds: normalizeArray(p.subcategoryIds ?? p.subcategory_ids).map(value => String(value)).filter(Boolean),
      licenseName: String(p.licenseName ?? p.license_name ?? ""),
      licenseNo: String(p.licenseNo ?? p.license_no ?? ""),
      fullDescription: String(p.fullDescription ?? p.full_description ?? ""),
      suitable: String(p.suitable || ""),
      info: normalizeInfo(p.info),
      preNotes: String(p.preNotes ?? p.pre_notes ?? ""),
      postNotes: String(p.postNotes ?? p.post_notes ?? "")
    };
  }

  function toast(message) {
    $("admin-toast").textContent = message;
    $("admin-toast").classList.add("show");
    setTimeout(() => $("admin-toast").classList.remove("show"), 3200);
  }

  async function init() {
    const auth = await db.auth.getSession();
    session = auth.data.session;
    if (!session) { location.href = "./"; return; }
    const result = await db.from("profiles").select("id,display_name,role,active").eq("id", uid()).single();
    if (result.error || !result.data?.active) { location.href = "./"; return; }
    profile = result.data;
    $("account-name").textContent = profile.display_name || session.user.email;
    $("account-role").textContent = isReviewer() ? "主管審核" : "內容編輯";
    $("catalog-gate").hidden = true;
    $("catalog-app").hidden = false;
    bind();
    await loadAll();
  }

  function bind() {
    $("logout-button").onclick = async () => { await db.auth.signOut(); location.href = "./"; };
    document.querySelectorAll("[data-kind]").forEach(button => button.onclick = () => setKind(button.dataset.kind));
    $("catalog-search").oninput = event => { search = event.target.value.trim().toLowerCase(); renderList(); };
    $("new-entity").onclick = () => newEntity();
    $("close-button").onclick = closeEditor;
    $("duplicate-button").onclick = duplicateEntity;
    $("catalog-form").onsubmit = async event => { event.preventDefault(); await saveRevision(); };
    $("submit-button").onclick = submitRevision;
    $("image-file").onchange = prepareImage;
    $("focus-x").oninput = updatePreviewFocus;
    $("focus-y").oninput = updatePreviewFocus;
    $("catalog-retry").onclick = () => retryOpen?.();
  }

  async function loadAll(selectKey) {
    const [categories, subcategories, treatments, revisionRows] = await Promise.all([
      db.from("treatment_categories").select("*").order("sort_order"),
      db.from("treatment_subcategories").select("*").order("sort_order"),
      db.from("treatment_catalog").select("*").order("sort_order"),
      db.from("catalog_revisions").select("*").order("updated_at", { ascending: false })
    ]);
    const error = categories.error || subcategories.error || treatments.error || revisionRows.error;
    if (error) { toast(`目錄載入失敗：${error.message}`); return; }
    live.category = categories.data || [];
    live.subcategory = subcategories.data || [];
    live.treatment = treatments.data || [];
    revisions = revisionRows.data || [];
    renderList();
    if (selectKey) {
      const [type, id] = selectKey.split(":");
      const entity = type === "revision" ? revisions.find(v => v.id === id) : live[type]?.find(v => v.id === id);
      if (entity) await (type === "revision" ? openRevision(entity) : openLive(type, entity));
    }
  }

  function setKind(next) {
    kind = next;
    document.querySelectorAll("[data-kind]").forEach(button => {
      const active = button.dataset.kind === kind;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    closeEditor();
    renderList();
  }

  function renderList() {
    const source = kind === "revision" ? revisions.filter(row => row.status !== "published" && row.status !== "archived") : live[kind];
    const rows = source.filter(row => `${row.name || row.payload?.name || ""} ${row.id} ${row.entity_id || ""} ${row.category_name || ""}`.toLowerCase().includes(search));
    $("catalog-list").innerHTML = rows.length ? rows.map(row => {
      const type = kind === "revision" ? row.entity_type : kind;
      const id = kind === "revision" ? row.id : row.id;
      const title = kind === "revision" ? row.payload?.name || row.entity_id : row.name;
      const status = kind === "revision" ? row.status : row.status;
      const meta = type === "treatment" ? (row.category_name || categoryName(row.payload?.categoryId)) : type === "subcategory" ? categoryName(row.category_id || row.payload?.categoryId) : row.group_key || row.payload?.group || "";
      const safeTitle = title || "未命名內容";
      const active = currentRevision?.id === row.id || (!currentRevision && current?.id === row.id);
      return `<button class="catalog-list-item ${active ? "active" : ""}" type="button" title="${escapeHtml(safeTitle)}" aria-label="開啟${escapeHtml(safeTitle)}，狀態${escapeHtml(statusLabels[status] || status)}" aria-current="${active ? "true" : "false"}" data-type="${type}" data-id="${id}" data-revision="${kind === "revision"}"><strong>${escapeHtml(safeTitle)}</strong><span><i>${escapeHtml(meta)}</i><i>${statusLabels[status] || status}</i></span></button>`;
    }).join("") : '<div class="catalog-empty-message">目前沒有符合的項目</div>';
    document.querySelectorAll(".catalog-list-item").forEach(button => button.onclick = async () => {
      if (busy) return;
      if (button.dataset.revision === "true") await openRevision(revisions.find(row => row.id === button.dataset.id));
      else await openLive(button.dataset.type, live[button.dataset.type].find(row => row.id === button.dataset.id));
    });
  }

  function categoryName(id) { return live.category.find(row => row.id === id)?.name || ""; }
  function latestOpenRevision(type, id) { return revisions.find(row => row.entity_type === type && row.entity_id === id && ["draft", "pending_review", "changes_requested"].includes(row.status)); }

  function liveToPayload(type, row) {
    if (type === "category") return normalizePayload(type, { name: row.name, group: row.group_key, summary: row.summary, icon: row.icon, image: row.image_url, imageAlt: row.image_alt, imageFocusX: row.image_focus_x, imageFocusY: row.image_focus_y, sortOrder: row.sort_order, visible: row.visible });
    if (type === "subcategory") return normalizePayload(type, { name: row.name, categoryId: row.category_id, sortOrder: row.sort_order, visible: row.visible });
    return normalizePayload(type, { name: row.name, categoryId: row.category_id, contentType: row.content_type, device: row.device_subtitle, shortDescription: row.short_description, tags: row.tags, licenseName: row.license_name, licenseNo: row.license_no, fullDescription: row.full_description, suitable: row.suitable, info: row.info, preNotes: row.pre_notes, postNotes: row.post_notes, image: row.image_url, imageAlt: row.image_alt, imageCaption: row.image_caption, imageFocusX: row.image_focus_x, imageFocusY: row.image_focus_y, sortOrder: row.sort_order, visible: row.visible, subcategoryIds: [] });
  }

  async function openLive(type, row) {
    if (!row) return;
    const request = ++openRequest;
    retryOpen = () => openLive(type, row);
    try {
      clearPendingImage();
      const open = latestOpenRevision(type, row.id);
      if (open) { await openRevision(open, row, request); return; }
      const payload = liveToPayload(type, row);
      if (type === "treatment") payload.subcategoryIds = await treatmentLinks(row.id);
      if (request !== openRequest) return;
      current = { type, id: row.id, live: row, payload: normalizePayload(type, payload), isNew: false };
      currentRevision = null;
      renderEditor(true);
    } catch (error) {
      if (request === openRequest) showRenderError(error);
    }
  }

  async function treatmentLinks(treatmentId) {
    if (!treatmentId) return [];
    const { data, error } = await db.from("treatment_subcategory_links").select("subcategory_id").eq("treatment_id", treatmentId);
    if (error) throw error;
    return (data || []).map(row => row.subcategory_id);
  }

  async function revisionImageUrl(path) {
    if (!path) return "";
    const result = await db.storage.from("treatment-drafts").createSignedUrl(path, 3600);
    return result.data?.signedUrl || "";
  }

  async function openRevision(row, suppliedLive = null, suppliedRequest = null) {
    if (!row) return;
    const request = suppliedRequest ?? ++openRequest;
    retryOpen = () => openRevision(row, suppliedLive);
    try {
      clearPendingImage();
      const liveRow = suppliedLive || live[row.entity_type]?.find(item => item.id === row.entity_id) || null;
      const base = liveRow ? liveToPayload(row.entity_type, liveRow) : {};
      if (row.entity_type === "treatment" && liveRow) base.subcategoryIds = await treatmentLinks(row.entity_id);
      const payload = normalizePayload(row.entity_type, structuredClone(row.payload || {}), base);
      if (payload.imageDraftPath) payload.imagePreview = await revisionImageUrl(payload.imageDraftPath);
      if (request !== openRequest) return;
      currentRevision = row;
      current = { type: row.entity_type, id: row.entity_id, live: liveRow, payload, isNew: !liveRow };
      renderEditor(true);
    } catch (error) {
      if (request === openRequest) showRenderError(error);
    }
  }

  function newEntity(forceType = kind === "revision" ? "treatment" : kind) {
    clearPendingImage();
    const type = forceType;
    currentRevision = null;
    current = { type, id: "", live: null, isNew: true, payload: normalizePayload(type) };
    retryOpen = () => newEntity(type);
    renderEditor(true);
  }

  function duplicateEntity() {
    if (!current) return;
    clearPendingImage();
    const payload = normalizePayload(current.type, structuredClone(readPayload()));
    payload.name = `${payload.name || "未命名"} 複本`;
    payload.imageDraftPath = "";
    currentRevision = null;
    current = { type: current.type, id: "", live: null, isNew: true, payload };
    retryOpen = () => newEntity(current.type);
    renderEditor(true);
  }

  function showRenderError(error) {
    console.error("Catalog editor rendering failed", error);
    $("catalog-empty").hidden = true;
    $("catalog-editor").hidden = false;
    $("catalog-sidebar").classList.add("editor-open");
    $("catalog-form").hidden = true;
    $("catalog-render-error").hidden = false;
    $("catalog-render-error-message").textContent = error?.message || "資料格式無法辨識，請重新載入。";
    $("entity-heading").textContent = current?.payload?.name || "內容載入失敗";
    $("entity-status").textContent = "載入失敗";
  }

  function renderEditor(resetScroll = false) {
    try {
      if (!current) throw new Error("找不到要編輯的內容");
      const type = current.type;
      const p = current.payload = normalizePayload(type, current.payload);
      $("catalog-empty").hidden = true;
      $("catalog-editor").hidden = false;
      $("catalog-sidebar").classList.add("editor-open");
      $("catalog-render-error").hidden = true;
      $("catalog-form").hidden = false;
      $("entity-heading").textContent = p.name || ({ treatment: "新增療程／保養品", category: "新增大分類", subcategory: "新增子分類" }[type]);
      $("stable-id").textContent = current.id ? `穩定 ID：${current.id}` : "儲存後自動建立穩定 ID";
      const status = currentRevision?.status || current.live?.status || "draft";
      $("entity-status").textContent = statusLabels[status] || status;
      $("entity-eyebrow").textContent = typeLabels[type] || type;
      $("editor-mode-note").textContent = currentRevision
        ? "目前顯示新版修訂；主管核准前，公開網站仍使用原已發布版本。"
        : current.live?.status === "published"
          ? "可直接編輯全部欄位；第一次儲存會建立新版草稿，不會覆蓋正式版本。"
          : "儲存後會建立草稿，再依審核流程發布。";
      $("duplicate-button").hidden = false;
      $("detail-section").hidden = type !== "treatment";
      $("image-section").hidden = type === "subcategory";
      renderFields(type, p);
      setImage(pendingImageUrl || p.imagePreview || p.image, p.imageAlt, p.imageCaption, p.imageFocusX, p.imageFocusY);
      renderWorkflow();
      renderEvents();
      const locked = Boolean(currentRevision && currentRevision.status === "pending_review" && !isReviewer());
      $("save-button").disabled = locked || busy;
      $("submit-button").hidden = Boolean(currentRevision?.status === "pending_review" || currentRevision?.status === "published");
      $("submit-button").disabled = locked || busy;
      renderList();
      applyBusyState();
      if (resetScroll) $("catalog-editor").scrollTop = 0;
    } catch (error) {
      showRenderError(error);
    }
  }

  function field(label, id, value = "", wide = false, type = "input") {
    return `<label class="catalog-field ${wide ? "wide" : ""}">${label}${type === "textarea" ? `<textarea id="${id}">${escapeHtml(value)}</textarea>` : `<input id="${id}" value="${escapeHtml(value)}">`}</label>`;
  }
  function select(label, id, options, value, wide = false, multiple = false) {
    const selectedValues = multiple ? new Set(normalizeArray(value).map(String)) : null;
    return `<label class="catalog-field ${wide ? "wide" : ""}">${label}<select id="${id}" ${multiple ? "multiple size=6" : ""}>${options.map(o => `<option value="${escapeHtml(o.id)}" ${(multiple ? selectedValues.has(String(o.id)) : String(value || "") === String(o.id)) ? "selected" : ""}>${escapeHtml(o.name)}</option>`).join("")}</select></label>`;
  }

  function renderFields(type, p) {
    const categoryOptions = live.category.filter(row => row.status === "published").map(row => ({ id: row.id, name: row.name }));
    $("base-fields").innerHTML = field("名稱", "field-name", p.name, true) +
      (type === "category" ? `${field("分類簡介", "field-summary", p.summary, true, "textarea")}${field("圖示（單一符號）", "field-icon", p.icon)}${field("顯示順序", "field-order", p.sortOrder)}` : "") +
      (type === "subcategory" ? `${select("所屬大分類", "field-category", categoryOptions, p.categoryId, true)}${field("顯示順序", "field-order", p.sortOrder)}` : "") +
      (type === "treatment" ? `${select("所屬大分類", "field-category", categoryOptions, p.categoryId)}${select("內容類型", "field-content-type", [{ id: "treatment", name: "療程" }, { id: "product", name: "保養品" }], p.contentType)}${field("儀器／產品副標", "field-device", p.device, true)}${field("卡片簡短說明", "field-short", p.shortDescription, true, "textarea")}${field("標籤（逗號分隔）", "field-tags", (p.tags || []).join("，"), true)}${field("顯示順序", "field-order", p.sortOrder)}${select("子分類（可複選）", "field-subcategories", live.subcategory.filter(s => !p.categoryId || s.category_id === p.categoryId).map(s => ({ id: s.id, name: s.name })), p.subcategoryIds || [], true, true)}` : "") +
      `<label class="catalog-field catalog-check"><input id="field-visible" type="checkbox" ${p.visible !== false ? "checked" : ""}>公開時顯示</label>`;
    if (type === "treatment") {
      $("detail-fields").innerHTML = field("仿單名稱", "field-license-name", p.licenseName, true) + field("許可證字號", "field-license-no", p.licenseNo, true) + field("完整說明", "field-full", p.fullDescription, true, "textarea") + field("適合對象", "field-suitable", p.suitable, true, "textarea") + field("動態資訊（每行：欄位｜內容）", "field-info", (p.info || []).map(v => `${v.k || ""}｜${v.v || ""}`).join("\n"), true, "textarea") + field("術前注意事項", "field-pre", p.preNotes, true, "textarea") + field("術後注意事項", "field-post", p.postNotes, true, "textarea");
      $("field-category").onchange = event => { current.payload = normalizePayload(type, readPayload()); current.payload.categoryId = event.target.value; renderEditor(false); };
    }
  }

  function readPayload() {
    const type = current.type;
    const p = { ...current.payload, name: $("field-name").value.trim(), sortOrder: Number($("field-order")?.value || 100), visible: $("field-visible").checked };
    if (type === "category") Object.assign(p, { group: "type", summary: $("field-summary").value.trim(), icon: $("field-icon").value.trim() });
    if (type === "subcategory") p.categoryId = $("field-category").value;
    if (type === "treatment") Object.assign(p, {
      categoryId: $("field-category").value, contentType: $("field-content-type").value, device: $("field-device").value.trim(), shortDescription: $("field-short").value.trim(), tags: parseList($("field-tags").value),
      subcategoryIds: [...$("field-subcategories").selectedOptions].map(o => o.value), licenseName: $("field-license-name").value.trim(), licenseNo: $("field-license-no").value.trim(), fullDescription: $("field-full").value.trim(), suitable: $("field-suitable").value.trim(),
      info: $("field-info").value.split("\n").map(line => line.split("｜")).filter(v => v[0]?.trim()).map(v => ({ k: v[0].trim(), v: v.slice(1).join("｜").trim() })), preNotes: $("field-pre").value.trim(), postNotes: $("field-post").value.trim()
    });
    if (type !== "subcategory") Object.assign(p, { imageAlt: $("image-alt").value.trim(), imageCaption: $("image-caption").value.trim(), imageFocusX: Number($("focus-x").value), imageFocusY: Number($("focus-y").value) });
    return p;
  }

  function setImage(src, alt = "", caption = "", x = 50, y = 50) {
    $("image-alt").value = alt || "";
    $("image-caption").value = caption || "";
    $("focus-x").value = x ?? 50;
    $("focus-y").value = y ?? 50;
    if (src) { $("image-preview").src = src; $("image-preview").hidden = false; $("image-placeholder").hidden = true; }
    else { $("image-preview").removeAttribute("src"); $("image-preview").hidden = true; $("image-placeholder").hidden = false; }
    updatePreviewFocus();
  }

  function updatePreviewFocus() {
    const x = normalizePercent($("focus-x").value);
    const y = normalizePercent($("focus-y").value);
    $("image-preview").style.objectPosition = `${x}% ${y}%`;
    $("focus-x-output").textContent = `${x}%`;
    $("focus-y-output").textContent = `${y}%`;
  }

  function clearPendingImage() {
    if (pendingImageSource?.close) pendingImageSource.close();
    if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
    pendingImageBlob = null;
    pendingImageSource = null;
    pendingImageUrl = "";
  }

  async function cropPendingImage() {
    if (!pendingImageSource) return pendingImageBlob;
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    const scale = Math.max(1200 / pendingImageSource.width, 900 / pendingImageSource.height);
    const width = pendingImageSource.width * scale;
    const height = pendingImageSource.height * scale;
    const focusX = Number($("focus-x").value) / 100;
    const focusY = Number($("focus-y").value) / 100;
    const offsetX = -(width - 1200) * focusX;
    const offsetY = -(height - 900) * focusY;
    context.drawImage(pendingImageSource, offsetX, offsetY, width, height);
    return new Promise(resolve => canvas.toBlob(resolve, "image/webp", .88));
  }

  async function prepareImage(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
      clearPendingImage();
      pendingImageSource = await createImageBitmap(file);
      pendingImageUrl = URL.createObjectURL(file);
      pendingImageBlob = file;
      setImage(pendingImageUrl, $("image-alt").value, $("image-caption").value, 50, 50);
    } catch (error) {
      toast(`圖片讀取失敗：${error.message}`);
    } finally {
      event.target.value = "";
    }
  }

  function applyBusyState(label = "處理中…") {
    document.body.classList.toggle("catalog-busy", busy);
    ["new-entity", "save-button", "submit-button", "duplicate-button", "close-button"].forEach(id => {
      const element = $(id);
      if (element) element.disabled = busy || (id === "save-button" && currentRevision?.status === "pending_review" && !isReviewer());
    });
    document.querySelectorAll("[data-action]").forEach(button => button.disabled = busy);
    if ($("save-button")) $("save-button").textContent = busy ? label : "儲存草稿";
    if ($("submit-button")) $("submit-button").textContent = busy ? label : "送交主管審核";
  }

  function setBusy(next, label = "處理中…") {
    busy = next;
    applyBusyState(label);
  }

  async function ensureRevision(payload) {
    let id = current.id;
    if (!id) id = makeId(current.type, payload.name);
    if (currentRevision) {
      const result = await db.from("catalog_revisions").update({ payload, status: currentRevision.status === "changes_requested" ? "changes_requested" : "draft" }).eq("id", currentRevision.id).select().single();
      if (result.error) throw result.error;
      currentRevision = result.data; current.id = id; return result.data;
    }
    const existing = latestOpenRevision(current.type, id);
    if (existing) { currentRevision = existing; return ensureRevision(payload); }
    const result = await db.from("catalog_revisions").insert({ entity_type: current.type, entity_id: id, payload, created_by: uid() }).select().single();
    if (result.error) throw result.error;
    currentRevision = result.data; current.id = id;
    await db.from("catalog_events").insert({ revision_id: result.data.id, entity_type: current.type, entity_id: id, actor_id: uid(), event_type: "created" });
    return result.data;
  }

  async function saveRevision(silent = false, manageBusy = true) {
    if (busy && manageBusy) return false;
    if (manageBusy) setBusy(true, "儲存中…");
    try {
      let payload = normalizePayload(current.type, readPayload(), current.live ? liveToPayload(current.type, current.live) : {});
      if (!payload.name) throw new Error("請填寫名稱");
      let revision = await ensureRevision(payload);
      if (pendingImageBlob) {
        pendingImageBlob = await cropPendingImage();
        if (!pendingImageBlob) throw new Error("圖片裁切失敗，請重新選擇圖片");
        const path = `${uid()}/${revision.id}/${crypto.randomUUID()}.webp`;
        const upload = await db.storage.from("treatment-drafts").upload(path, pendingImageBlob, { contentType: "image/webp" });
        if (upload.error) throw upload.error;
        payload.imageDraftPath = path;
        const update = await db.from("catalog_revisions").update({ payload }).eq("id", revision.id).select().single();
        if (update.error) throw update.error;
        currentRevision = update.data;
        clearPendingImage();
      }
      await db.from("catalog_events").insert({ revision_id: currentRevision.id, entity_type: current.type, entity_id: current.id, actor_id: uid(), event_type: "saved" });
      if (!silent) toast("草稿已儲存");
      await loadAll(`revision:${currentRevision.id}`);
      return true;
    } catch (error) {
      toast(`儲存失敗：${error.message}`);
      return false;
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  async function invoke(action, note = "") {
    const result = await db.functions.invoke("catalog-workflow", { body: { action, revisionId: currentRevision?.id, entityType: current.type, entityId: current.id, note } });
    if (result.error) {
      let message = result.error.message;
      try {
        const response = result.error.context;
        const payload = response && typeof response.clone === "function" ? await response.clone().json() : null;
        if (payload?.error) message = payload.error;
      } catch (_) {}
      throw new Error(message);
    }
    if (result.data?.error) throw new Error(result.data.error);
    return result.data;
  }

  async function submitRevision() {
    if (busy) return;
    setBusy(true, "送審中…");
    try {
      if (!await saveRevision(true, false)) return;
      await invoke("submit");
      toast("已送交主管審核");
      await loadAll();
      closeEditor();
    } catch (error) {
      toast(`送審失敗：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function renderWorkflow() {
    const status = currentRevision?.status;
    const actions = [];
    if (isReviewer() && status === "pending_review") {
      actions.push('<button type="button" class="primary-button" data-action="publish">確認發布</button>', '<button type="button" class="secondary-button danger-button" data-action="request_changes">退回修改</button>');
    }
    if (isReviewer() && current.live?.status === "published") actions.push('<button type="button" class="secondary-button" data-action="unpublish">下架</button>', '<button type="button" class="secondary-button danger-button" data-action="archive">封存</button>');
    $("catalog-workflow-actions").innerHTML = actions.join("");
    document.querySelectorAll("[data-action]").forEach(button => button.onclick = async () => {
      if (busy) return;
      const action = button.dataset.action;
      const note = $("catalog-note").value.trim();
      if (action === "request_changes" && !note) { toast("退回修改時請填寫原因"); return; }
      setBusy(true, "處理中…");
      try {
        await invoke(action, note);
        toast(action === "publish" ? "新版已發布，公開頁重新整理後即生效" : "狀態已更新");
        await loadAll();
        closeEditor();
      } catch (error) {
        toast(`操作失敗：${error.message}`);
      } finally {
        setBusy(false);
      }
    });
    applyBusyState();
  }

  async function renderEvents() {
    if (!current.id) { $("catalog-events").innerHTML = ""; return; }
    const entityId = current.id;
    try {
      const { data, error } = await db.from("catalog_events").select("event_type,note,created_at").eq("entity_id", entityId).order("created_at", { ascending: false });
      if (error) throw error;
      if (current?.id !== entityId) return;
      $("catalog-events").innerHTML = (data || []).map(row => `<div class="event-item"><time>${new Date(row.created_at).toLocaleString("zh-TW")}</time><p><strong>${escapeHtml(row.event_type)}</strong>${row.note ? `<br>${escapeHtml(row.note)}` : ""}</p></div>`).join("") || '<div class="catalog-empty-message">尚無歷程</div>';
    } catch (error) {
      if (current?.id === entityId) $("catalog-events").innerHTML = `<div class="catalog-empty-message">歷程載入失敗：${escapeHtml(error.message)}</div>`;
    }
  }

  function closeEditor() {
    current = currentRevision = null;
    clearPendingImage();
    $("catalog-editor").hidden = true;
    $("catalog-empty").hidden = false;
    $("catalog-render-error").hidden = true;
    $("catalog-form").hidden = false;
    $("catalog-sidebar").classList.remove("editor-open");
    renderList();
  }

  init().catch(error => { $("catalog-gate").innerHTML = `<p>後台載入失敗：${escapeHtml(error.message)}</p>`; });
})();
