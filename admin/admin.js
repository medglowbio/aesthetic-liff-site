(function () {
  "use strict";

  const config = window.SUPABASE_CONFIG || {};
  const photoLayouts = window.CasePhotoLayouts;
  const cropMath = window.CaseCropMath;
  const initialHashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const initialQueryParams = new URLSearchParams(window.location.search);
  const initialAuthType = initialHashParams.get("type") || initialQueryParams.get("type");
  const initialPasswordSetupFlow = ["invite", "recovery"].includes(initialAuthType) || initialQueryParams.has("code");
  const configured = Boolean(config.url && config.publishableKey && window.supabase);
  const db = configured ? window.supabase.createClient(config.url, config.publishableKey, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true }
  }) : null;
  let catalog = [];
  const statusLabels = {
    draft: "草稿",
    pending_review: "待審核",
    changes_requested: "退回修改",
    published: "已發布",
    archived: "已封存"
  };
  const eventLabels = {
    created: "建立案例",
    submitted: "送交審核",
    changes_requested: "退回修改",
    published: "發布案例",
    unpublished: "下架案例",
    archived: "封存案例"
  };

  let session = null;
  let profile = null;
  let cases = [];
  let statusFilter = "all";
  let currentCase = null;
  let selectedTreatmentIds = new Set();
  let photoPairs = [];
  let deletedPhotoPairs = [];
  let cropState = null;
  let saving = false;
  let savingLabel = "處理中…";
  let appLoadPromise = null;
  let authBootComplete = false;

  const $ = id => document.getElementById(id);
  const authGate = window.AdminAuthGate.create({
    hiddenViewIds: ["login-view", "password-setup-view", "admin-app"]
  });
  const { escapeHtml, parseList, createToast, clamp, revokeBlobUrl, loadImage, sanitizeImage } = window.AdminUI;
  const toast = createToast({ duration: 2800 });
  const parseTags = parseList;
  const uid = () => session?.user?.id || "";
  const isReviewer = () => profile?.role === "reviewer";
  const isEditable = () => !currentCase || isReviewer() || (["draft", "changes_requested"].includes(currentCase.status) && currentCase.created_by === uid());

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function showLogin(message = "") {
    authGate.hide();
    profile = null;
    $("login-view").hidden = false;
    $("password-setup-view").hidden = true;
    $("admin-app").hidden = true;
    $("login-message").textContent = message;
  }

  function isPasswordSetupFlow() {
    return initialPasswordSetupFlow;
  }

  function showPasswordSetup() {
    authGate.hide();
    $("login-view").hidden = true;
    $("password-setup-view").hidden = false;
    $("admin-app").hidden = true;
    $("password-setup-message").textContent = "";
  }

  async function showApp() {
    if (!session) { showLogin(); return; }
    if (!$("admin-app").hidden && profile?.id === uid()) return;
    if (appLoadPromise) return appLoadPromise;

    const expectedUserId = uid();
    appLoadPromise = (async () => {
      authGate.showLoading("正在載入後台內容");
      const { data, error } = await db.from("profiles").select("id,display_name,role,active").eq("id", expectedUserId).single();
      if (error) throw error;
      if (uid() !== expectedUserId) return;
      if (!data?.active) {
        await db.auth.signOut();
        showLogin("帳號尚未啟用，請聯絡管理員。");
        return;
      }
      profile = data;
      $("account-name").textContent = profile.display_name || session.user.email;
      $("account-role").textContent = isReviewer() ? "主管審核" : "內容編輯";
      await Promise.all([
        loadTreatmentCatalog(),
        loadCases(null, { throwOnError: true })
      ]);
      if (uid() !== expectedUserId) return;
      authGate.hide();
      $("login-view").hidden = true;
      $("password-setup-view").hidden = true;
      $("admin-app").hidden = false;
    })();

    try {
      return await appLoadPromise;
    } finally {
      appLoadPromise = null;
    }
  }

  async function loadAppWithError() {
    try {
      await showApp();
    } catch (error) {
      authGate.showError(`後台載入失敗：${error.message || "請稍後再試"}`);
    }
  }

  async function loadTreatmentCatalog() {
    const { data, error } = await db.rpc("get_published_treatment_catalog");
    if (error) throw error;
    catalog = (data?.treatments || []).map(item => ({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      categoryName: item.categoryName
    }));
  }

  async function loadCases(selectId = null, { throwOnError = false } = {}) {
    let query = db.from("cases").select(`
      *,
      case_treatments(treatment_id),
      case_photo_pairs(
        id,label,follow_up_label,sort_order,canvas_ratio,split_direction,
        before_private_path,after_private_path,before_source_private_path,after_source_private_path,
        before_crop_rect,after_crop_rect,before_public_path,after_public_path
      ),
      case_events(id,event_type,note,actor_id,created_at)
    `).order("updated_at", { ascending: false });
    if (!isReviewer()) query = query.eq("created_by", uid());
    const { data, error } = await query;
    if (error) {
      if (throwOnError) throw error;
      toast(`案例載入失敗：${error.message}`);
      return false;
    }
    cases = data || [];
    renderCaseList();
    if (selectId) {
      const found = cases.find(item => item.id === selectId);
      if (found) await openCase(found);
    }
    return true;
  }

  function setStatusFilter(nextStatus) {
    statusFilter = nextStatus;
    document.querySelectorAll("[data-status]").forEach(item => {
      const active = item.dataset.status === nextStatus;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
  }

  function renderCaseList() {
    const filtered = statusFilter === "all" ? cases : cases.filter(item => item.status === statusFilter);
    $("admin-case-list").innerHTML = filtered.length ? filtered.map(item => `
      <button class="case-list-item ${currentCase?.id === item.id ? "active" : ""}" type="button" title="${escapeHtml(item.title)}" aria-label="開啟${escapeHtml(item.title)}，狀態${escapeHtml(statusLabels[item.status] || item.status)}" aria-current="${currentCase?.id === item.id ? "true" : "false"}" data-case-id="${item.id}">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="case-list-meta"><span>${escapeHtml(item.id)}</span><span>${statusLabels[item.status] || item.status}</span></span>
        <span class="case-list-meta"><span>${(item.case_treatments || []).length > 1 ? "複合療程" : "單一療程"}</span><span>${formatDate(item.updated_at)}</span></span>
      </button>`).join("") : '<div class="case-list-empty">此分類目前沒有案例</div>';
    document.querySelectorAll("[data-case-id]").forEach(button => button.addEventListener("click", () => {
      const item = cases.find(entry => entry.id === button.dataset.caseId);
      if (item) openCase(item);
    }));
  }

  const normalizeCropRect = value => cropMath.normalizeCropRect(value);

  function hasPhoto(pair, side) {
    return Boolean(pair[`${side}Blob`] || pair[`${side}PrivatePath`]);
  }

  function hasSource(pair, side) {
    return Boolean(pair[`${side}SourceBlob`] || pair[`${side}SourcePrivatePath`] || pair[`${side}SourcePreview`]);
  }

  function needsRecrop(pair, side) {
    return hasPhoto(pair, side) && (
      pair[`${side}RenderedRatio`] !== pair.canvasRatio ||
      pair[`${side}RenderedDirection`] !== pair.splitDirection
    );
  }

  function blankPair() {
    return {
      clientId: crypto.randomUUID(), id: null, label: "正面", followUpLabel: "",
      canvasRatio: "4:3", splitDirection: "horizontal",
      beforePrivatePath: "", afterPrivatePath: "", beforePreview: "", afterPreview: "",
      beforeSourcePrivatePath: "", afterSourcePrivatePath: "", beforeSourcePreview: "", afterSourcePreview: "",
      beforeCropRect: null, afterCropRect: null,
      beforeRenderedRatio: null, afterRenderedRatio: null,
      beforeRenderedDirection: null, afterRenderedDirection: null,
      beforeBlob: null, afterBlob: null, beforeSourceBlob: null, afterSourceBlob: null
    };
  }

  function newCase() {
    currentCase = null;
    selectedTreatmentIds = new Set();
    photoPairs = [blankPair()];
    deletedPhotoPairs = [];
    $("case-form").reset();
    $("case-order").value = "100";
    $("case-id").value = "";
    $("editor-eyebrow").textContent = "NEW CASE";
    $("editor-title").textContent = "新增案例";
    $("editor-status").textContent = "草稿";
    $("consent-record").textContent = "";
    $("event-list").innerHTML = "";
    $("workflow-note").value = "";
    showEditor();
    renderTreatments();
    renderPhotoPairs();
    renderWorkflow();
    $("case-editor").scrollTop = 0;
  }

  async function signedUrl(path) {
    if (!path) return "";
    const { data } = await db.storage.from("case-drafts").createSignedUrl(path, 3600);
    return data?.signedUrl || "";
  }

  async function openCase(item) {
    currentCase = item;
    selectedTreatmentIds = new Set((item.case_treatments || []).map(entry => entry.treatment_id));
    deletedPhotoPairs = [];
    photoPairs = await Promise.all((item.case_photo_pairs || []).sort((a, b) => a.sort_order - b.sort_order).map(async pair => {
      const [beforePreview, afterPreview, beforeSourcePreview, afterSourcePreview] = await Promise.all([
        signedUrl(pair.before_private_path),
        signedUrl(pair.after_private_path),
        signedUrl(pair.before_source_private_path),
        signedUrl(pair.after_source_private_path)
      ]);
      return {
        clientId: pair.id,
        id: pair.id,
        label: pair.label || "正面",
        followUpLabel: pair.follow_up_label || "",
        canvasRatio: photoLayouts.normalizeRatio(pair.canvas_ratio),
        splitDirection: photoLayouts.normalizeDirection(pair.split_direction),
        beforePrivatePath: pair.before_private_path,
        afterPrivatePath: pair.after_private_path,
        beforeSourcePrivatePath: pair.before_source_private_path || "",
        afterSourcePrivatePath: pair.after_source_private_path || "",
        beforePreview,
        afterPreview,
        beforeSourcePreview,
        afterSourcePreview,
        beforeCropRect: normalizeCropRect(pair.before_crop_rect),
        afterCropRect: normalizeCropRect(pair.after_crop_rect),
        beforeRenderedRatio: photoLayouts.normalizeRatio(pair.canvas_ratio),
        afterRenderedRatio: photoLayouts.normalizeRatio(pair.canvas_ratio),
        beforeRenderedDirection: photoLayouts.normalizeDirection(pair.split_direction),
        afterRenderedDirection: photoLayouts.normalizeDirection(pair.split_direction),
        beforeBlob: null,
        afterBlob: null,
        beforeSourceBlob: null,
        afterSourceBlob: null
      };
    }));
    if (!photoPairs.length) photoPairs = [blankPair()];
    $("case-title").value = item.title || "";
    $("case-id").value = item.id;
    $("case-order").value = item.display_order ?? 100;
    $("case-summary").value = item.summary || "";
    $("case-concerns").value = (item.concern_tags || []).join(", ");
    $("case-consent").checked = item.consent_confirmed === true;
    $("consent-record").textContent = item.consent_confirmed_at ? `已於 ${formatDate(item.consent_confirmed_at)} 確認授權` : "";
    $("editor-eyebrow").textContent = item.id;
    $("editor-title").textContent = item.title;
    $("editor-status").textContent = statusLabels[item.status] || item.status;
    $("workflow-note").value = "";
    showEditor();
    renderTreatments();
    renderPhotoPairs();
    renderWorkflow();
    renderEvents();
    renderCaseList();
    $("case-editor").scrollTop = 0;
  }

  function showEditor() {
    $("editor-empty").hidden = true;
    $("case-editor").hidden = false;
    document.querySelector(".case-sidebar").classList.add("editor-open");
  }

  function closeEditor() {
    currentCase = null;
    $("case-editor").hidden = true;
    $("editor-empty").hidden = false;
    document.querySelector(".case-sidebar").classList.remove("editor-open");
    renderCaseList();
  }

  function renderTreatments() {
    const query = $("treatment-search").value.trim().toLocaleLowerCase("zh-TW");
    const filtered = catalog.filter(item => !query || `${item.name} ${item.categoryName}`.toLocaleLowerCase("zh-TW").includes(query));
    const groups = new Map();
    filtered.forEach(item => {
      if (!groups.has(item.categoryName)) groups.set(item.categoryName, []);
      groups.get(item.categoryName).push(item);
    });
    $("treatment-picker").innerHTML = [...groups].map(([name, items]) => `
      <section class="treatment-group"><h3>${escapeHtml(name)}</h3><div class="treatment-options">
        ${items.map(item => `<button type="button" class="treatment-option ${selectedTreatmentIds.has(item.id) ? "active" : ""}" data-treatment-id="${item.id}">${escapeHtml(item.name)}</button>`).join("")}
      </div></section>`).join("");
    document.querySelectorAll("[data-treatment-id]").forEach(button => button.addEventListener("click", () => {
      if (!isEditable()) return;
      selectedTreatmentIds.has(button.dataset.treatmentId) ? selectedTreatmentIds.delete(button.dataset.treatmentId) : selectedTreatmentIds.add(button.dataset.treatmentId);
      renderTreatments();
    }));
  }

  function renderPhotoPairs() {
    $("photo-pairs").innerHTML = photoPairs.map((pair, index) => {
      const layout = photoLayouts.getLayout(pair.canvasRatio, pair.splitDirection);
      return `
        <article class="photo-pair" data-pair-index="${index}">
          <div class="photo-pair-head"><strong>照片組 ${index + 1}</strong><button class="remove-pair" type="button" data-remove-pair="${index}">移除此組</button></div>
          <div class="photo-meta">
            <input value="${escapeHtml(pair.label)}" data-pair-label="${index}" placeholder="角度，例如：正面">
            <input value="${escapeHtml(pair.followUpLabel)}" data-pair-follow-up="${index}" placeholder="追蹤時間，例如：療程後三個月">
          </div>
          <div class="photo-layout-controls">
            <fieldset class="photo-layout-group">
              <legend>完整畫布比例</legend>
              <div class="photo-segments">
                ${Object.values(photoLayouts.ratios).map(option => `<button type="button" class="${pair.canvasRatio === option.value ? "active" : ""}" aria-pressed="${pair.canvasRatio === option.value}" data-pair-ratio="${index}|${option.value}" ${isEditable() ? "" : "disabled"}>${option.label}</button>`).join("")}
              </div>
            </fieldset>
            <fieldset class="photo-layout-group">
              <legend>排列方式</legend>
              <div class="photo-segments">
                ${Object.values(photoLayouts.directions).map(option => `<button type="button" class="${pair.splitDirection === option.value ? "active" : ""}" aria-pressed="${pair.splitDirection === option.value}" data-pair-direction="${index}|${option.value}" ${isEditable() ? "" : "disabled"}>${option.label}</button>`).join("")}
              </div>
            </fieldset>
          </div>
          <div class="photo-comparison-admin ${layout.ratioClass} ${layout.directionClass}">
            ${photoUploadTemplate(pair, index, "before", "術前")}
            ${photoUploadTemplate(pair, index, "after", "術後")}
          </div>
          <p class="photo-layout-size">完整畫布 ${layout.canvasWidth} × ${layout.canvasHeight} px；每張 ${layout.slotWidth} × ${layout.slotHeight} px</p>
        </article>`;
    }).join("");
    document.querySelectorAll("[data-remove-pair]").forEach(button => button.addEventListener("click", () => removePhotoPair(Number(button.dataset.removePair))));
    document.querySelectorAll("[data-pair-label]").forEach(input => input.addEventListener("input", () => photoPairs[Number(input.dataset.pairLabel)].label = input.value));
    document.querySelectorAll("[data-pair-follow-up]").forEach(input => input.addEventListener("input", () => photoPairs[Number(input.dataset.pairFollowUp)].followUpLabel = input.value));
    document.querySelectorAll("[data-pair-ratio]").forEach(button => button.addEventListener("click", () => {
      const [index, ratio] = button.dataset.pairRatio.split("|");
      updatePairLayout(Number(index), { canvasRatio: ratio });
    }));
    document.querySelectorAll("[data-pair-direction]").forEach(button => button.addEventListener("click", () => {
      const [index, direction] = button.dataset.pairDirection.split("|");
      updatePairLayout(Number(index), { splitDirection: direction });
    }));
    document.querySelectorAll("[data-photo-input]").forEach(input => input.addEventListener("change", event => {
      const [index, side] = input.dataset.photoInput.split(":");
      const file = event.target.files?.[0];
      if (file) startCrop(file, Number(index), side);
      input.value = "";
    }));
    document.querySelectorAll("[data-photo-pick]").forEach(button => button.addEventListener("click", () => {
      const [index, side] = button.dataset.photoPick.split(":");
      document.querySelector(`[data-photo-input="${index}:${side}"]`)?.click();
    }));
    document.querySelectorAll("[data-photo-edit]").forEach(button => button.addEventListener("click", () => {
      const [index, side] = button.dataset.photoEdit.split(":");
      editCrop(Number(index), side);
    }));
  }

  function photoUploadTemplate(pair, index, side, label) {
    const preview = side === "before" ? pair.beforePreview : pair.afterPreview;
    const sourceAvailable = hasSource(pair, side);
    const recropRequired = needsRecrop(pair, side);
    const warning = recropRequired
      ? (sourceAvailable ? "版型已變更，請重新裁切" : "舊照片沒有母圖，請重新上傳")
      : "";
    return `<div class="photo-upload">
      ${preview ? `<img src="${escapeHtml(preview)}" alt="${label}預覽">` : '<span class="photo-placeholder">＋<br>選擇並裁切照片</span>'}
      <input type="file" accept="image/jpeg,image/png,image/webp" data-photo-input="${index}:${side}" ${isEditable() ? "" : "disabled"}>
      <span class="photo-label">${label}</span>
      ${warning ? `<span class="photo-crop-warning">${warning}</span>` : ""}
      <span class="photo-upload-actions">
        <button type="button" data-photo-pick="${index}:${side}" ${isEditable() ? "" : "disabled"}>${preview ? "更換" : "選擇"}</button>
        ${preview ? `<button type="button" data-photo-edit="${index}:${side}" title="${sourceAvailable ? "使用私有母圖重新裁切" : "舊照片沒有可重新裁切的母圖"}" ${isEditable() && sourceAvailable ? "" : "disabled"}>重新裁切</button>` : ""}
      </span>
    </div>`;
  }

  function updatePairLayout(index, changes) {
    if (!isEditable()) return;
    const pair = photoPairs[index];
    if (!pair) return;
    if (changes.canvasRatio) pair.canvasRatio = photoLayouts.normalizeRatio(changes.canvasRatio);
    if (changes.splitDirection) pair.splitDirection = photoLayouts.normalizeDirection(changes.splitDirection);
    renderPhotoPairs();
  }

  function removePhotoPair(index) {
    if (!isEditable()) return;
    const [removed] = photoPairs.splice(index, 1);
    if (removed?.id) deletedPhotoPairs.push(removed);
    if (!photoPairs.length) photoPairs.push(blankPair());
    renderPhotoPairs();
  }

  function renderWorkflow() {
    const status = currentCase?.status || "draft";
    $("review-section").hidden = !currentCase;
    $("submit-review-button").hidden = Boolean(currentCase && !["draft", "changes_requested"].includes(status));
    $("save-draft-button").disabled = !isEditable() || saving;
    $("submit-review-button").disabled = !isEditable() || saving;
    $("save-draft-button").textContent = saving ? savingLabel : "儲存案例";
    $("submit-review-button").textContent = saving ? savingLabel : "送交主管審核";
    $("add-photo-pair").disabled = !isEditable();
    $("case-consent").disabled = !isEditable();
    const actions = [];
    if (isReviewer() && status === "pending_review") {
      actions.push('<button type="button" class="primary-button" data-workflow="publish">確認發布</button>');
      actions.push('<button type="button" class="secondary-button danger-button" data-workflow="request_changes">退回修改</button>');
    }
    if (isReviewer() && status === "published") actions.push('<button type="button" class="secondary-button danger-button" data-workflow="unpublish">下架案例</button>');
    if (isReviewer() && status !== "archived") actions.push('<button type="button" class="secondary-button" data-workflow="archive">封存案例</button>');
    $("workflow-actions").innerHTML = actions.join("");
    document.querySelectorAll("[data-workflow]").forEach(button => button.addEventListener("click", () => runWorkflow(button.dataset.workflow)));
    document.querySelectorAll("[data-workflow]").forEach(button => { button.disabled = saving; });
  }

  function renderEvents() {
    const events = (currentCase?.case_events || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    $("event-list").innerHTML = events.length ? events.map(item => `<div class="event-item"><time>${formatDate(item.created_at)}</time><p><strong>${eventLabels[item.event_type] || item.event_type}</strong>${item.note ? `<br>${escapeHtml(item.note)}` : ""}</p></div>`).join("") : '<div class="case-list-empty">尚無操作紀錄</div>';
  }

  async function uploadPairBlob(caseId, pair, side, kind) {
    const source = kind === "source";
    const blob = pair[`${side}${source ? "Source" : ""}Blob`];
    const existing = pair[`${side}${source ? "Source" : ""}PrivatePath`];
    if (!blob) return { path: existing, replacedPath: "", uploaded: false };
    const suffix = source ? `${side}-source` : side;
    const path = `${uid()}/${caseId}/${crypto.randomUUID()}-${suffix}.webp`;
    const { error } = await db.storage.from("case-drafts").upload(path, blob, { contentType: "image/webp", upsert: false });
    if (error) throw error;
    return { path, replacedPath: existing, uploaded: true };
  }

  async function saveCase() {
    if (saving) return currentCase?.id || null;
    if (!isEditable()) throw new Error("此案例目前不可編輯");
    const title = $("case-title").value.trim();
    if (title.length < 2) throw new Error("請填寫案例名稱");
    const hasIncompletePair = photoPairs.some(pair => {
      const hasBefore = hasPhoto(pair, "before");
      const hasAfter = hasPhoto(pair, "after");
      return (hasBefore || hasAfter) && !(hasBefore && hasAfter);
    });
    if (hasIncompletePair) throw new Error("照片組必須同時包含術前與術後");
    if (photoPairs.some(pair => needsRecrop(pair, "before") || needsRecrop(pair, "after"))) {
      throw new Error("版型已變更，請先重新裁切術前與術後照片");
    }

    saving = true;
    savingLabel = "儲存中…";
    renderWorkflow();
    try {
      const consent = $("case-consent").checked;
      const now = new Date().toISOString();
      const values = {
        title,
        summary: $("case-summary").value.trim(),
        display_order: Number($("case-order").value) || 100,
        concern_tags: parseTags($("case-concerns").value),
        consent_confirmed: consent,
        consent_confirmed_by: consent ? uid() : null,
        consent_confirmed_at: consent ? (currentCase?.consent_confirmed_at || now) : null
      };
      let caseId = currentCase?.id;
      let created = false;
      if (caseId) {
        const { error } = await db.from("cases").update(values).eq("id", caseId);
        if (error) throw error;
      } else {
        // New rows must initially satisfy the draft-only insert policy. Consent is
        // recorded immediately afterwards while the new draft is editable.
        const insertValues = {
          ...values,
          consent_confirmed: false,
          consent_confirmed_by: null,
          consent_confirmed_at: null,
          created_by: uid(),
          status: "draft"
        };
        const { data, error } = await db.from("cases").insert(insertValues).select("id").single();
        if (error) throw error;
        caseId = data.id;
        created = true;
        if (consent) {
          const consentUpdate = await db.from("cases").update(values).eq("id", caseId);
          if (consentUpdate.error) throw consentUpdate.error;
        }
      }

      const treatmentDelete = await db.from("case_treatments").delete().eq("case_id", caseId);
      if (treatmentDelete.error) throw treatmentDelete.error;
      if (selectedTreatmentIds.size) {
        const { error } = await db.from("case_treatments").insert([...selectedTreatmentIds].map(treatmentId => ({ case_id: caseId, treatment_id: treatmentId })));
        if (error) throw error;
      }

      for (const removed of deletedPhotoPairs) {
        const paths = [
          removed.beforePrivatePath,
          removed.afterPrivatePath,
          removed.beforeSourcePrivatePath,
          removed.afterSourcePrivatePath
        ].filter(Boolean);
        if (paths.length) await db.storage.from("case-drafts").remove(paths);
        const result = await db.from("case_photo_pairs").delete().eq("id", removed.id);
        if (result.error) throw result.error;
      }

      const completePairs = photoPairs.filter(pair => hasPhoto(pair, "before") && hasPhoto(pair, "after"));
      for (let index = 0; index < completePairs.length; index++) {
        const pair = completePairs[index];
        const uploads = [];
        try {
          // Settled rather than all: a partial failure must still expose the uploads
          // that succeeded so the catch below can remove them.
          const results = await Promise.allSettled([
            uploadPairBlob(caseId, pair, "before", "source"),
            uploadPairBlob(caseId, pair, "after", "source"),
            uploadPairBlob(caseId, pair, "before", "derivative"),
            uploadPairBlob(caseId, pair, "after", "derivative")
          ]);
          results.forEach(result => { if (result.status === "fulfilled") uploads.push(result.value); });
          const failure = results.find(result => result.status === "rejected");
          if (failure) throw failure.reason;
          const row = {
            case_id: caseId,
            label: pair.label.trim() || "正面",
            follow_up_label: pair.followUpLabel.trim(),
            sort_order: index,
            canvas_ratio: photoLayouts.normalizeRatio(pair.canvasRatio),
            split_direction: photoLayouts.normalizeDirection(pair.splitDirection),
            before_source_private_path: uploads[0].path || null,
            after_source_private_path: uploads[1].path || null,
            before_private_path: uploads[2].path,
            after_private_path: uploads[3].path,
            before_crop_rect: pair.beforeCropRect,
            after_crop_rect: pair.afterCropRect
          };
          if (pair.id) {
            const { error } = await db.from("case_photo_pairs").update(row).eq("id", pair.id);
            if (error) throw error;
          } else {
            const { data, error } = await db.from("case_photo_pairs").insert(row).select("id").single();
            if (error) throw error;
            pair.id = data.id;
          }
          pair.beforeSourcePrivatePath = uploads[0].path || "";
          pair.afterSourcePrivatePath = uploads[1].path || "";
          pair.beforePrivatePath = uploads[2].path;
          pair.afterPrivatePath = uploads[3].path;
          pair.beforeSourceBlob = null;
          pair.afterSourceBlob = null;
          pair.beforeBlob = null;
          pair.afterBlob = null;
          const replacedPaths = uploads.map(upload => upload.replacedPath).filter(Boolean);
          if (replacedPaths.length) await db.storage.from("case-drafts").remove(replacedPaths);
        } catch (error) {
          const newPaths = uploads.filter(upload => upload.uploaded).map(upload => upload.path);
          if (newPaths.length) await db.storage.from("case-drafts").remove(newPaths);
          throw error;
        }
      }

      let eventWarning = "";
      if (created) {
        try {
          await invokeWorkflow("created", caseId, "建立案例");
        } catch (error) {
          console.warn("Case creation event logging failed", error);
          eventWarning = "，操作紀錄稍後補登";
        }
      }
      setStatusFilter("all");
      const reloaded = await loadCases(caseId);
      if (!reloaded) throw new Error("案例已儲存，但案例列表重新載入失敗，請重新整理頁面");
      toast(`案例已儲存${eventWarning}`);
      return caseId;
    } finally {
      saving = false;
      renderWorkflow();
    }
  }

  async function invokeWorkflow(action, caseId, note = "") {
    const { data, error } = await db.functions.invoke("case-workflow", { body: { action, caseId, note } });
    if (error) {
      let message = error.message;
      const response = error.context;
      if (response && typeof response.json === "function") {
        try {
          const payload = await response.json();
          message = payload?.error || message;
        } catch {
          // Keep the Supabase fallback message when the response is not JSON.
        }
      }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function runWorkflow(action) {
    if (saving) return;
    try {
      const note = $("workflow-note").value.trim();
      if (action === "request_changes" && !note) throw new Error("退回修改時請填寫原因");
      if (action === "publish") await saveCase();
      saving = true;
      savingLabel = "處理中…";
      renderWorkflow();
      const result = await invokeWorkflow(action, currentCase.id, note);
      toast(`案例狀態已更新：${statusLabels[result.status] || result.status}`);
      await loadCases(currentCase.id);
    } catch (error) {
      toast(error.message || "操作失敗");
    } finally {
      saving = false;
      renderWorkflow();
    }
  }

  async function submitReview() {
    if (saving) return;
    try {
      const caseId = await saveCase();
      saving = true;
      savingLabel = "送審中…";
      renderWorkflow();
      const result = await invokeWorkflow("submit", caseId, $("workflow-note").value.trim());
      toast(`案例已送審：${statusLabels[result.status]}`);
      await loadCases(caseId);
    } catch (error) {
      toast(error.message || "送審失敗");
    } finally {
      saving = false;
      renderWorkflow();
    }
  }

  function cropGeometry() {
    const { image, layout } = cropState;
    return {
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
      slotWidth: layout.slotWidth,
      slotHeight: layout.slotHeight
    };
  }

  function cropRectFromControls() {
    if (!cropState) return null;
    return cropMath.cropRectFromControls({
      ...cropGeometry(),
      zoom: Number($("crop-zoom").value),
      x: Number($("crop-x").value),
      y: Number($("crop-y").value)
    });
  }

  function setCropControls(rect) {
    if (!cropState) return;
    const controls = cropMath.controlsFromCropRect({ ...cropGeometry(), rect });
    $("crop-zoom").value = String(controls.zoom);
    $("crop-x").value = String(controls.x);
    $("crop-y").value = String(controls.y);
  }

  function updateCropOutputs() {
    $("crop-zoom-value").value = `${Math.round(Number($("crop-zoom").value) * 100)}%`;
    $("crop-x-value").value = `${Math.round((Number($("crop-x").value) + 100) / 2)}%`;
    $("crop-y-value").value = `${Math.round((Number($("crop-y").value) + 100) / 2)}%`;
  }

  function drawCrop() {
    if (!cropState) return;
    const canvas = $("crop-canvas");
    const context = canvas.getContext("2d");
    const rect = cropRectFromControls();
    context.fillStyle = "#ddd";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      cropState.image,
      rect.sourceX,
      rect.sourceY,
      rect.sourceWidth,
      rect.sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    updateCropOutputs();
  }

  function openCrop({ image, pairIndex, side, sourceBlob = null, sourcePreview = "", ownsSourcePreview = false, cropRect = null }) {
    const pair = photoPairs[pairIndex];
    if (!pair) return;
    const layout = photoLayouts.getLayout(pair.canvasRatio, pair.splitDirection);
    const canvas = $("crop-canvas");
    canvas.width = layout.slotWidth;
    canvas.height = layout.slotHeight;
    const slotRatio = layout.slotWidth / layout.slotHeight;
    const cropWidth = slotRatio <= .4 ? 210 : slotRatio <= .5 ? 280 : slotRatio <= .7 ? 360 : 520;
    $("crop-stage").style.setProperty("--crop-aspect", `${layout.slotWidth} / ${layout.slotHeight}`);
    $("crop-stage").style.setProperty("--crop-width", `${cropWidth}px`);
    $("crop-title").textContent = `${side === "before" ? "術前" : "術後"} · ${layout.ratioLabel} ${layout.directionLabel}`;
    cropState = { image, pairIndex, side, sourceBlob, sourcePreview, ownsSourcePreview, cropRect, layout, drag: null };
    setCropControls(cropRect);
    drawCrop();
    $("crop-dialog").showModal();
  }

  async function startCrop(file, pairIndex, side) {
    if (!isEditable()) return;
    try {
      const source = await sanitizeImage(file);
      openCrop({
        image: source.image,
        pairIndex,
        side,
        sourceBlob: source.blob,
        sourcePreview: source.preview,
        ownsSourcePreview: true
      });
    } catch (error) {
      toast(error.message || "無法讀取這張圖片");
    }
  }

  async function editCrop(pairIndex, side) {
    if (!isEditable()) return;
    const pair = photoPairs[pairIndex];
    if (!pair || !hasSource(pair, side)) {
      toast("舊照片沒有可重新裁切的母圖，請重新上傳");
      return;
    }
    try {
      const sourceBlob = pair[`${side}SourceBlob`];
      let preview = pair[`${side}SourcePreview`] || (sourceBlob ? URL.createObjectURL(sourceBlob) : "");
      if (preview && !pair[`${side}SourcePreview`]) pair[`${side}SourcePreview`] = preview;
      let image;
      try {
        if (!preview) throw new Error("母圖預覽網址尚未建立");
        image = await loadImage(preview);
      } catch (error) {
        const sourcePath = pair[`${side}SourcePrivatePath`];
        if (!sourcePath) throw error;
        preview = await signedUrl(sourcePath);
        if (!preview) throw error;
        pair[`${side}SourcePreview`] = preview;
        image = await loadImage(preview);
      }
      openCrop({ image, pairIndex, side, sourcePreview: preview, cropRect: pair[`${side}CropRect`] });
    } catch (error) {
      toast(error.message || "母圖載入失敗，請重新上傳");
    }
  }

  function resetCrop() {
    if (!cropState) return;
    setCropControls(null);
    drawCrop();
  }

  function beginCropDrag(event) {
    if (!cropState) return;
    const rect = cropRectFromControls();
    cropState.drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      sourceX: rect.sourceX,
      sourceY: rect.sourceY,
      sourceWidth: rect.sourceWidth,
      sourceHeight: rect.sourceHeight,
      maxX: rect.maxX,
      maxY: rect.maxY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("dragging");
  }

  function moveCropDrag(event) {
    const drag = cropState?.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const canvasRect = event.currentTarget.getBoundingClientRect();
    const sourceX = clamp(drag.sourceX - (event.clientX - drag.clientX) / canvasRect.width * drag.sourceWidth, 0, drag.maxX);
    const sourceY = clamp(drag.sourceY - (event.clientY - drag.clientY) / canvasRect.height * drag.sourceHeight, 0, drag.maxY);
    $("crop-x").value = String(drag.maxX ? sourceX / drag.maxX * 200 - 100 : 0);
    $("crop-y").value = String(drag.maxY ? sourceY / drag.maxY * 200 - 100 : 0);
    drawCrop();
  }

  function endCropDrag(event) {
    if (!cropState?.drag || cropState.drag.pointerId !== event.pointerId) return;
    cropState.drag = null;
    event.currentTarget.classList.remove("dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function confirmCrop() {
    const state = cropState;
    if (!state) return;
    const rect = cropRectFromControls();
    const blob = await new Promise(resolve => $("crop-canvas").toBlob(resolve, "image/webp", .86));
    if (!blob) { toast("圖片轉檔失敗"); return; }
    if (cropState !== state) return;
    const pair = photoPairs[state.pairIndex];
    if (!pair) return;
    revokeBlobUrl(pair[`${state.side}Preview`]);
    pair[`${state.side}Blob`] = blob;
    pair[`${state.side}Preview`] = URL.createObjectURL(blob);
    pair[`${state.side}CropRect`] = rect.normalized;
    pair[`${state.side}RenderedRatio`] = pair.canvasRatio;
    pair[`${state.side}RenderedDirection`] = pair.splitDirection;
    if (state.sourceBlob) {
      revokeBlobUrl(pair[`${state.side}SourcePreview`]);
      pair[`${state.side}SourceBlob`] = state.sourceBlob;
      pair[`${state.side}SourcePreview`] = state.sourcePreview;
      state.ownsSourcePreview = false;
    }
    cropState = null;
    $("crop-dialog").close();
    renderPhotoPairs();
  }

  async function boot() {
    if (!photoLayouts || !cropMath) {
      authGate.showError("照片版型模組載入失敗，請重新整理頁面；若持續失敗請確認 assets/js/ 下的版型與裁切腳本是否已部署。");
      return;
    }
    $("setup-warning").hidden = configured;
    $("login-form").querySelector("button").disabled = !configured;
    $("request-password-reset").disabled = !configured;
    if (!configured) {
      showLogin();
      return;
    }

    db.auth.onAuthStateChange((event, nextSession) => {
      session = nextSession;
      if (!authBootComplete) return;
      window.setTimeout(() => {
        handleAuthTransition(event, nextSession).catch(error => {
          authGate.showError(`後台載入失敗：${error.message || "請稍後再試"}`);
        });
      }, 0);
    });

    try {
      authGate.showLoading();
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      session = data.session;
      if (session) {
        if (isPasswordSetupFlow()) showPasswordSetup(); else await loadAppWithError();
      } else showLogin();
    } catch (error) {
      authGate.showError(`無法確認登入狀態：${error.message || "請稍後再試"}`);
    } finally {
      authBootComplete = true;
    }
  }

  async function handleAuthTransition(event, nextSession) {
    if (session !== nextSession) return;
    if (!nextSession) {
      showLogin();
      return;
    }
    if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && isPasswordSetupFlow())) {
      showPasswordSetup();
      return;
    }
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") await loadAppWithError();
  }

  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    $("login-message").textContent = "登入中...";
    const { data, error } = await db.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
    if (error) { $("login-message").textContent = "登入失敗，請確認帳號與密碼。"; return; }
    session = data.session;
    $("login-message").textContent = "";
    await loadAppWithError();
  });
  $("request-password-reset").addEventListener("click", async () => {
    const email = $("login-email").value.trim();
    if (!email) {
      $("login-message").textContent = "請先輸入電子郵件。";
      $("login-email").focus();
      return;
    }
    $("login-message").textContent = "寄送密碼設定信中...";
    const redirectTo = window.location.protocol === "file:"
      ? "https://medglowbio-ship-it.github.io/aesthetic-liff-site/admin/"
      : new URL("./", window.location.href).href.replace(/[?#].*$/, "");
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
    $("login-message").textContent = error
      ? `寄送失敗：${error.message}`
      : "密碼設定信已寄出，請使用同一個瀏覽器開啟最新信件。";
  });
  $("password-setup-form").addEventListener("submit", async event => {
    event.preventDefault();
    const password = $("new-password").value;
    const confirmation = $("confirm-password").value;
    if (password !== confirmation) {
      $("password-setup-message").textContent = "兩次輸入的密碼不一致。";
      return;
    }
    $("password-setup-message").textContent = "設定中...";
    const { error } = await db.auth.updateUser({ password });
    if (error) {
      $("password-setup-message").textContent = `設定失敗：${error.message}`;
      return;
    }
    window.history.replaceState({}, document.title, window.location.pathname);
    $("password-setup-message").textContent = "";
    await loadAppWithError();
  });
  $("logout-button").addEventListener("click", () => db.auth.signOut());
  $("new-case-button").addEventListener("click", newCase);
  $("close-editor-button").addEventListener("click", closeEditor);
  $("treatment-search").addEventListener("input", renderTreatments);
  $("add-photo-pair").addEventListener("click", () => { photoPairs.push(blankPair()); renderPhotoPairs(); });
  $("case-form").addEventListener("submit", async event => { event.preventDefault(); try { await saveCase(); } catch (error) { toast(error.message || "儲存失敗"); } });
  $("submit-review-button").addEventListener("click", submitReview);
  $("confirm-crop").addEventListener("click", confirmCrop);
  $("reset-crop").addEventListener("click", resetCrop);
  ["crop-zoom", "crop-x", "crop-y"].forEach(id => $(id).addEventListener("input", drawCrop));
  $("crop-canvas").addEventListener("pointerdown", beginCropDrag);
  $("crop-canvas").addEventListener("pointermove", moveCropDrag);
  $("crop-canvas").addEventListener("pointerup", endCropDrag);
  $("crop-canvas").addEventListener("pointercancel", endCropDrag);
  $("crop-dialog").addEventListener("close", () => {
    if (cropState?.ownsSourcePreview) revokeBlobUrl(cropState.sourcePreview);
    cropState = null;
  });
  $("status-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    setStatusFilter(button.dataset.status);
    renderCaseList();
  });

  boot();
})();
