(function () {
  "use strict";

  const config = window.SUPABASE_CONFIG || {};
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

  const $ = id => document.getElementById(id);
  const uid = () => session?.user?.id || "";
  const isReviewer = () => profile?.role === "reviewer";
  const isEditable = () => !currentCase || isReviewer() || (["draft", "changes_requested"].includes(currentCase.status) && currentCase.created_by === uid());

  function toast(message) {
    const element = $("admin-toast");
    element.textContent = message;
    element.classList.add("show");
    window.setTimeout(() => element.classList.remove("show"), 2800);
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function parseTags(value) {
    return [...new Set(String(value || "").split(/[,，\n]/).map(item => item.trim()).filter(Boolean))];
  }

  function showLogin(message = "") {
    $("login-view").hidden = false;
    $("password-setup-view").hidden = true;
    $("admin-app").hidden = true;
    $("login-message").textContent = message;
  }

  function isPasswordSetupFlow() {
    return initialPasswordSetupFlow;
  }

  function showPasswordSetup() {
    $("login-view").hidden = true;
    $("password-setup-view").hidden = false;
    $("admin-app").hidden = true;
    $("password-setup-message").textContent = "";
  }

  async function showApp() {
    const { data, error } = await db.from("profiles").select("id,display_name,role,active").eq("id", uid()).single();
    if (error || !data?.active) {
      await db.auth.signOut();
      showLogin("帳號尚未啟用，請聯絡管理員。");
      return;
    }
    profile = data;
    $("account-name").textContent = profile.display_name || session.user.email;
    $("account-role").textContent = isReviewer() ? "主管審核" : "內容編輯";
    $("login-view").hidden = true;
    $("password-setup-view").hidden = true;
    $("admin-app").hidden = false;
    await loadTreatmentCatalog();
    await loadCases();
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

  async function loadCases(selectId = null) {
    let query = db.from("cases").select(`
      *,
      case_treatments(treatment_id),
      case_photo_pairs(id,label,follow_up_label,sort_order,before_private_path,after_private_path,before_public_path,after_public_path),
      case_events(id,event_type,note,actor_id,created_at)
    `).order("updated_at", { ascending: false });
    if (!isReviewer()) query = query.eq("created_by", uid());
    const { data, error } = await query;
    if (error) {
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

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function blankPair() {
    return {
      clientId: crypto.randomUUID(), id: null, label: "正面", followUpLabel: "",
      beforePrivatePath: "", afterPrivatePath: "", beforePreview: "", afterPreview: "",
      beforeBlob: null, afterBlob: null
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
    photoPairs = await Promise.all((item.case_photo_pairs || []).sort((a, b) => a.sort_order - b.sort_order).map(async pair => ({
      clientId: pair.id,
      id: pair.id,
      label: pair.label || "正面",
      followUpLabel: pair.follow_up_label || "",
      beforePrivatePath: pair.before_private_path,
      afterPrivatePath: pair.after_private_path,
      beforePreview: await signedUrl(pair.before_private_path),
      afterPreview: await signedUrl(pair.after_private_path),
      beforeBlob: null,
      afterBlob: null
    })));
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
    $("photo-pairs").innerHTML = photoPairs.map((pair, index) => `
      <article class="photo-pair" data-pair-index="${index}">
        <div class="photo-pair-head"><strong>照片組 ${index + 1}</strong><button class="remove-pair" type="button" data-remove-pair="${index}">移除此組</button></div>
        <div class="photo-meta">
          <input value="${escapeHtml(pair.label)}" data-pair-label="${index}" placeholder="角度，例如：正面">
          <input value="${escapeHtml(pair.followUpLabel)}" data-pair-follow-up="${index}" placeholder="追蹤時間，例如：療程後三個月">
        </div>
        <div class="photo-columns">
          ${photoUploadTemplate(pair, index, "before", "術前")}
          ${photoUploadTemplate(pair, index, "after", "術後")}
        </div>
      </article>`).join("");
    document.querySelectorAll("[data-remove-pair]").forEach(button => button.addEventListener("click", () => removePhotoPair(Number(button.dataset.removePair))));
    document.querySelectorAll("[data-pair-label]").forEach(input => input.addEventListener("input", () => photoPairs[Number(input.dataset.pairLabel)].label = input.value));
    document.querySelectorAll("[data-pair-follow-up]").forEach(input => input.addEventListener("input", () => photoPairs[Number(input.dataset.pairFollowUp)].followUpLabel = input.value));
    document.querySelectorAll("[data-photo-input]").forEach(input => input.addEventListener("change", event => {
      const [index, side] = input.dataset.photoInput.split(":");
      const file = event.target.files?.[0];
      if (file) startCrop(file, Number(index), side);
      input.value = "";
    }));
  }

  function photoUploadTemplate(pair, index, side, label) {
    const preview = side === "before" ? pair.beforePreview : pair.afterPreview;
    return `<label class="photo-upload">
      ${preview ? `<img src="${escapeHtml(preview)}" alt="${label}預覽">` : '<span class="photo-placeholder">＋<br>選擇並裁切照片</span>'}
      <input type="file" accept="image/jpeg,image/png,image/webp" data-photo-input="${index}:${side}" ${isEditable() ? "" : "disabled"}>
      <span class="photo-label">${label}</span>
    </label>`;
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

  async function uploadBlob(caseId, pair, side) {
    const blob = side === "before" ? pair.beforeBlob : pair.afterBlob;
    const existing = side === "before" ? pair.beforePrivatePath : pair.afterPrivatePath;
    if (!blob) return existing;
    const path = `${uid()}/${caseId}/${crypto.randomUUID()}-${side}.webp`;
    const { error } = await db.storage.from("case-drafts").upload(path, blob, { contentType: "image/webp", upsert: false });
    if (error) throw error;
    if (existing) await db.storage.from("case-drafts").remove([existing]);
    return path;
  }

  async function saveCase() {
    if (saving) return currentCase?.id || null;
    if (!isEditable()) throw new Error("此案例目前不可編輯");
    const title = $("case-title").value.trim();
    if (title.length < 2) throw new Error("請填寫案例名稱");
    const hasIncompletePair = photoPairs.some(pair => {
      const hasBefore = Boolean(pair.beforeBlob || pair.beforePrivatePath);
      const hasAfter = Boolean(pair.afterBlob || pair.afterPrivatePath);
      return (hasBefore || hasAfter) && !(hasBefore && hasAfter);
    });
    if (hasIncompletePair) throw new Error("照片組必須同時包含術前與術後");

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
        const paths = [removed.beforePrivatePath, removed.afterPrivatePath].filter(Boolean);
        if (paths.length) await db.storage.from("case-drafts").remove(paths);
        const result = await db.from("case_photo_pairs").delete().eq("id", removed.id);
        if (result.error) throw result.error;
      }

      const completePairs = photoPairs.filter(pair => (pair.beforeBlob || pair.beforePrivatePath) && (pair.afterBlob || pair.afterPrivatePath));
      for (let index = 0; index < completePairs.length; index++) {
        const pair = completePairs[index];
        const beforePath = await uploadBlob(caseId, pair, "before");
        const afterPath = await uploadBlob(caseId, pair, "after");
        const row = { case_id: caseId, label: pair.label.trim() || "正面", follow_up_label: pair.followUpLabel.trim(), sort_order: index, before_private_path: beforePath, after_private_path: afterPath };
        if (pair.id) {
          const { error } = await db.from("case_photo_pairs").update(row).eq("id", pair.id);
          if (error) throw error;
        } else {
          const { error } = await db.from("case_photo_pairs").insert(row);
          if (error) throw error;
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

  function startCrop(file, pairIndex, side) {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      cropState = { image, url, pairIndex, side };
      $("crop-zoom").value = "1";
      $("crop-x").value = "0";
      $("crop-y").value = "0";
      drawCrop();
      $("crop-dialog").showModal();
    };
    image.onerror = () => { URL.revokeObjectURL(url); toast("無法讀取這張圖片"); };
    image.src = url;
  }

  function drawCrop() {
    if (!cropState) return;
    const canvas = $("crop-canvas");
    const context = canvas.getContext("2d");
    const image = cropState.image;
    const zoom = Number($("crop-zoom").value);
    const base = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const scale = base * zoom;
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const maxX = Math.max(0, (width - canvas.width) / 2);
    const maxY = Math.max(0, (height - canvas.height) / 2);
    const x = (canvas.width - width) / 2 + Number($("crop-x").value) / 100 * maxX;
    const y = (canvas.height - height) / 2 + Number($("crop-y").value) / 100 * maxY;
    context.fillStyle = "#ddd";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, x, y, width, height);
  }

  async function confirmCrop() {
    if (!cropState) return;
    const output = document.createElement("canvas");
    output.width = 900;
    output.height = 1350;
    output.getContext("2d").drawImage($("crop-canvas"), 0, 0, output.width, output.height);
    const blob = await new Promise(resolve => output.toBlob(resolve, "image/webp", .86));
    if (!blob) { toast("圖片轉檔失敗"); return; }
    const pair = photoPairs[cropState.pairIndex];
    pair[`${cropState.side}Blob`] = blob;
    pair[`${cropState.side}Preview`] = URL.createObjectURL(blob);
    URL.revokeObjectURL(cropState.url);
    cropState = null;
    $("crop-dialog").close();
    renderPhotoPairs();
  }

  async function boot() {
    $("setup-warning").hidden = configured;
    $("login-form").querySelector("button").disabled = !configured;
    $("request-password-reset").disabled = !configured;
    if (!configured) return;
    const { data } = await db.auth.getSession();
    session = data.session;
    if (session) {
      if (isPasswordSetupFlow()) showPasswordSetup(); else await showApp();
    } else showLogin();
    db.auth.onAuthStateChange(async (event, nextSession) => {
      session = nextSession;
      if (!session) showLogin();
      else if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && isPasswordSetupFlow())) showPasswordSetup();
    });
  }

  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    $("login-message").textContent = "登入中...";
    const { data, error } = await db.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
    if (error) { $("login-message").textContent = "登入失敗，請確認帳號與密碼。"; return; }
    session = data.session;
    $("login-message").textContent = "";
    await showApp();
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
    await showApp();
  });
  $("logout-button").addEventListener("click", () => db.auth.signOut());
  $("new-case-button").addEventListener("click", newCase);
  $("close-editor-button").addEventListener("click", closeEditor);
  $("treatment-search").addEventListener("input", renderTreatments);
  $("add-photo-pair").addEventListener("click", () => { photoPairs.push(blankPair()); renderPhotoPairs(); });
  $("case-form").addEventListener("submit", async event => { event.preventDefault(); try { await saveCase(); } catch (error) { toast(error.message || "儲存失敗"); } });
  $("submit-review-button").addEventListener("click", submitReview);
  $("confirm-crop").addEventListener("click", confirmCrop);
  ["crop-zoom", "crop-x", "crop-y"].forEach(id => $(id).addEventListener("input", drawCrop));
  $("crop-dialog").addEventListener("close", () => { if (cropState?.url) URL.revokeObjectURL(cropState.url); cropState = null; });
  $("status-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    setStatusFilter(button.dataset.status);
    renderCaseList();
  });

  boot();
})();
