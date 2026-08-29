import { json, prepareWorkflowRequest, type WorkflowClient } from "../_shared/workflow-request.ts";

type Action = "submit" | "request_changes" | "publish" | "unpublish" | "archive";
type EntityType = "category" | "subcategory" | "treatment";

function required(value: unknown) {
  return String(value ?? "").trim();
}

function validatePayload(type: EntityType, payload: Record<string, unknown>) {
  if (!required(payload.name)) return "名稱為必填";
  if (type === "category" && !required(payload.imageAlt)) return "分類圖片替代文字為必填";
  if (type === "subcategory" && !required(payload.categoryId)) return "所屬分類為必填";
  if (type === "treatment") {
    if (!required(payload.categoryId)) return "所屬分類為必填";
    if (!required(payload.shortDescription)) return "卡片簡短說明為必填";
    if (!required(payload.fullDescription)) return "完整說明為必填";
    if (!required(payload.imageAlt)) return "圖片替代文字為必填";
  }
  return "";
}

async function publishImage(client: WorkflowClient, draftPath: string, entityType: string, entityId: string) {
  if (!draftPath) return "";
  if (!draftPath.includes("/")) return draftPath;
  const { data, error } = await client.storage.from("treatment-drafts").download(draftPath);
  if (error) throw new Error(`核准圖片讀取失敗：${error.message}`);
  const publicPath = `${entityType}/${entityId}/${crypto.randomUUID()}.webp`;
  const upload = await client.storage.from("treatment-published").upload(publicPath, data, {
    contentType: "image/webp", upsert: false, cacheControl: "31536000"
  });
  if (upload.error) throw new Error(`核准圖片發布失敗：${upload.error.message}`);
  return client.storage.from("treatment-published").getPublicUrl(publicPath).data.publicUrl;
}

Deno.serve(async request => {
  const prepared = await prepareWorkflowRequest(request);
  if (prepared.response) return prepared.response;
  const { client, user, profile } = prepared.context;

  let body: { action?: Action; revisionId?: string; entityType?: EntityType; entityId?: string; note?: string };
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON" }); }
  const action = body.action;
  const note = String(body.note || "").trim().slice(0, 1000);
  if (!action) return json(400, { error: "action is required" });

  const reviewer = profile.role === "reviewer";
  const event = async (revision: Record<string, unknown>, type: string) => {
    const result = await client.from("catalog_events").insert({
      revision_id: revision.id, entity_type: revision.entity_type, entity_id: revision.entity_id,
      actor_id: user.id, event_type: type, note
    });
    if (result.error) throw result.error;
  };

  try {
    if (action === "unpublish" || (action === "archive" && !body.revisionId)) {
      if (!reviewer) return json(403, { error: "Reviewer permission required" });
      const type = body.entityType;
      const id = required(body.entityId);
      if (!type || !id) return json(400, { error: "entityType and entityId are required" });
      const status = action === "archive" ? "archived" : "unpublished";
      if (type === "category" && action === "archive") {
        const { count } = await client.from("treatment_catalog").select("id", { count: "exact", head: true })
          .eq("category_id", id).eq("status", "published").eq("active", true);
        if (count) return json(409, { error: "此分類仍有已發布療程，請先移動或下架相關療程" });
      }
      const table = type === "category" ? "treatment_categories" : type === "subcategory" ? "treatment_subcategories" : "treatment_catalog";
      const changes: Record<string, unknown> = { status };
      if (type === "treatment") changes.active = false;
      const result = await client.from(table).update(changes).eq("id", id);
      if (result.error) throw result.error;
      await client.from("catalog_events").insert({ entity_type: type, entity_id: id, actor_id: user.id, event_type: action === "archive" ? "archived" : "unpublished", note });
      return json(200, { ok: true, status });
    }

    const { data: revision, error } = await client.from("catalog_revisions").select("*").eq("id", body.revisionId).maybeSingle();
    if (error) throw error;
    if (!revision) return json(404, { error: "Revision not found" });
    const owner = revision.created_by === user.id;

    if (action === "submit") {
      if (!owner || !["draft", "changes_requested"].includes(revision.status)) return json(403, { error: "此修訂無法送審" });
      const validation = validatePayload(revision.entity_type, revision.payload || {});
      if (validation) return json(422, { error: validation });
      const result = await client.from("catalog_revisions").update({ status: "pending_review", submitted_at: new Date().toISOString() }).eq("id", revision.id);
      if (result.error) throw result.error;
      await event(revision, "submitted");
      return json(200, { ok: true, status: "pending_review" });
    }

    if (!reviewer) return json(403, { error: "Reviewer permission required" });
    if (action === "request_changes") {
      if (revision.status !== "pending_review") return json(409, { error: "僅待審修訂可退回" });
      if (!note) return json(422, { error: "請填寫退回修改原因" });
      const result = await client.from("catalog_revisions").update({ status: "changes_requested", reviewed_by: user.id, note }).eq("id", revision.id);
      if (result.error) throw result.error;
      await event(revision, "changes_requested");
      return json(200, { ok: true, status: "changes_requested" });
    }
    if (action !== "publish") return json(400, { error: "Unsupported action" });
    if (revision.status !== "pending_review") return json(409, { error: "僅待審修訂可發布" });

    const payload = { ...(revision.payload || {}) } as Record<string, unknown>;
    const validation = validatePayload(revision.entity_type, payload);
    if (validation) return json(422, { error: validation });
    if (required(payload.imageDraftPath)) {
      payload.image = await publishImage(client, required(payload.imageDraftPath), revision.entity_type, revision.entity_id);
    }
    const now = new Date().toISOString();

    if (revision.entity_type === "category") {
      const row = {
        id: revision.entity_id, group_key: required(payload.group) || "type", name: required(payload.name),
        summary: required(payload.summary), icon: required(payload.icon), image_url: required(payload.image),
        image_alt: required(payload.imageAlt), image_focus_x: Number(payload.imageFocusX ?? 50), image_focus_y: Number(payload.imageFocusY ?? 50),
        sort_order: Number(payload.sortOrder ?? 100), visible: payload.visible !== false, status: "published",
        reviewed_by: user.id, published_at: now
      };
      const result = await client.from("treatment_categories").upsert(row, { onConflict: "id" });
      if (result.error) throw result.error;
    } else if (revision.entity_type === "subcategory") {
      const row = {
        id: revision.entity_id, category_id: required(payload.categoryId), name: required(payload.name),
        sort_order: Number(payload.sortOrder ?? 100), visible: payload.visible !== false, status: "published",
        reviewed_by: user.id, published_at: now
      };
      const result = await client.from("treatment_subcategories").upsert(row, { onConflict: "id" });
      if (result.error) throw result.error;
    } else {
      const categoryId = required(payload.categoryId);
      const { data: category } = await client.from("treatment_categories").select("name").eq("id", categoryId).maybeSingle();
      if (!category) return json(422, { error: "所屬分類尚未發布" });
      const row = {
        id: revision.entity_id, name: required(payload.name), category_id: categoryId, category_name: category.name,
        content_type: required(payload.contentType) || "treatment", device_subtitle: required(payload.device),
        short_description: required(payload.shortDescription), tags: Array.isArray(payload.tags) ? payload.tags : [],
        license_name: required(payload.licenseName), license_no: required(payload.licenseNo), full_description: required(payload.fullDescription),
        suitable: required(payload.suitable), info: Array.isArray(payload.info) ? payload.info : [], pre_notes: required(payload.preNotes),
        post_notes: required(payload.postNotes), image_url: required(payload.image), image_alt: required(payload.imageAlt),
        image_caption: required(payload.imageCaption), image_focus_x: Number(payload.imageFocusX ?? 50), image_focus_y: Number(payload.imageFocusY ?? 50),
        sort_order: Number(payload.sortOrder ?? 100), visible: payload.visible !== false, active: true, status: "published",
        reviewed_by: user.id, published_at: now
      };
      const result = await client.from("treatment_catalog").upsert(row, { onConflict: "id" });
      if (result.error) throw result.error;
      const subcategoryIds = Array.isArray(payload.subcategoryIds) ? payload.subcategoryIds.map(String) : [];
      const remove = await client.from("treatment_subcategory_links").delete().eq("treatment_id", revision.entity_id);
      if (remove.error) throw remove.error;
      if (subcategoryIds.length) {
        const links = subcategoryIds.map((id, index) => ({ treatment_id: revision.entity_id, subcategory_id: id, sort_order: index * 10 + 10 }));
        const add = await client.from("treatment_subcategory_links").insert(links);
        if (add.error) throw add.error;
      }
    }

    const result = await client.from("catalog_revisions").update({
      status: "published", payload, reviewed_by: user.id, published_at: now
    }).eq("id", revision.id);
    if (result.error) throw result.error;
    await event(revision, "published");
    return json(200, { ok: true, status: "published" });
  } catch (error) {
    console.error(error);
    return json(500, { error: error instanceof Error ? error.message : "Catalog workflow failed" });
  }
});
