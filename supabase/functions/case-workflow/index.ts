import { json, prepareWorkflowRequest } from "../_shared/workflow-request.ts";

type WorkflowAction = "created" | "submit" | "request_changes" | "publish" | "unpublish" | "archive";

Deno.serve(async request => {
  const prepared = await prepareWorkflowRequest(request);
  if (prepared.response) return prepared.response;
  const { client: userClient, auditClient, user, profile } = prepared.context;

  let body: { action?: WorkflowAction; caseId?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return json(request, 400, { error: "Invalid JSON" });
  }

  const action = body.action;
  const caseId = String(body.caseId || "").trim();
  const note = String(body.note || "").trim().slice(0, 1000);
  if (!action || !caseId) return json(request, 400, { error: "action and caseId are required" });

  const { data: caseItem, error: caseError } = await userClient
    .from("cases")
    .select(`
      *,
      case_treatments(treatment_id),
      case_photo_pairs(
        id,
        canvas_ratio,
        split_direction,
        before_private_path,
        after_private_path,
        before_public_path,
        after_public_path,
        published_canvas_ratio,
        published_split_direction
      )
    `)
    .eq("id", caseId)
    .maybeSingle();
  if (caseError) return json(request, 500, { error: `Case lookup failed: ${caseError.message}` });
  if (!caseItem) return json(request, 404, { error: "Case not found" });

  const reviewer = profile.role === "reviewer";
  const owner = caseItem.created_by === user.id;
  const event = async (eventType: string, eventNote = "") => {
    const { error } = await auditClient.from("case_events").insert({
      case_id: caseId,
      actor_id: user.id,
      event_type: eventType,
      note: eventNote
    });
    if (error) throw error;
  };

  try {
    if (action === "created") {
      if (!owner || caseItem.status !== "draft") return json(request, 403, { error: "This case cannot be recorded" });
      const { count } = await userClient
        .from("case_events")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .eq("event_type", "created");
      if (!count) await event("created", note);
      return json(request, 200, { ok: true, status: caseItem.status });
    }

    if (action === "submit") {
      if (!owner || !["draft", "changes_requested"].includes(caseItem.status)) {
        return json(request, 403, { error: "This case cannot be submitted" });
      }
      if (!caseItem.title || !caseItem.case_treatments?.length || !caseItem.case_photo_pairs?.length) {
        return json(request, 422, { error: "案例名稱、療程及至少一組術前術後照片皆為必填" });
      }
      // canvas_ratio and split_direction are NOT NULL with CHECK constraints, so the
      // database already guarantees a valid layout here.
      const incomplete = caseItem.case_photo_pairs.some((pair: Record<string, unknown>) => (
        !pair.before_private_path || !pair.after_private_path
      ));
      if (incomplete) return json(request, 422, { error: "每組照片都必須包含術前與術後" });
      const { error } = await userClient.from("cases").update({ status: "pending_review", submitted_at: new Date().toISOString() }).eq("id", caseId);
      if (error) throw error;
      await event("submitted", note);
      return json(request, 200, { ok: true, status: "pending_review" });
    }

    if (!reviewer) return json(request, 403, { error: "Reviewer permission required" });

    if (action === "request_changes") {
      if (caseItem.status !== "pending_review") return json(request, 409, { error: "Only pending cases can be returned" });
      if (!note) return json(request, 422, { error: "請填寫退回修改原因" });
      const { error } = await userClient.from("cases").update({ status: "changes_requested", reviewed_by: user.id }).eq("id", caseId);
      if (error) throw error;
      await event("changes_requested", note);
      return json(request, 200, { ok: true, status: "changes_requested" });
    }

    async function removePublishedImages() {
      const paths = caseItem.case_photo_pairs.flatMap((pair: Record<string, string | null>) => [pair.before_public_path, pair.after_public_path]).filter(Boolean) as string[];
      if (paths.length) await userClient.storage.from("case-published").remove(paths);
      await userClient.from("case_photo_pairs").update({
        before_public_path: null,
        after_public_path: null,
        published_canvas_ratio: null,
        published_split_direction: null
      }).eq("case_id", caseId);
    }

    if (action === "publish") {
      if (caseItem.status !== "pending_review") return json(request, 409, { error: "Only pending cases can be published" });
      if (!caseItem.consent_confirmed || !caseItem.consent_confirmed_by || !caseItem.consent_confirmed_at) {
        return json(request, 422, { error: "尚未完成影像公開授權確認" });
      }
      if (!caseItem.case_treatments?.length || !caseItem.case_photo_pairs?.length) {
        return json(request, 422, { error: "案例缺少療程或照片" });
      }

      const uploaded: string[] = [];
      try {
        for (const pair of caseItem.case_photo_pairs) {
          if (!pair.before_private_path || !pair.after_private_path) throw new Error("照片資料不完整");
          const publicationId = crypto.randomUUID();
          const beforePath = `${caseId}/${pair.id}-before-${publicationId}.webp`;
          const afterPath = `${caseId}/${pair.id}-after-${publicationId}.webp`;
          const beforeFile = await userClient.storage.from("case-drafts").download(pair.before_private_path);
          const afterFile = await userClient.storage.from("case-drafts").download(pair.after_private_path);
          if (beforeFile.error) throw beforeFile.error;
          if (afterFile.error) throw afterFile.error;
          const beforeUpload = await userClient.storage.from("case-published").upload(beforePath, beforeFile.data, { contentType: "image/webp", upsert: false });
          if (beforeUpload.error) {
            throw new Error(`術前公開圖片上傳失敗：${beforeUpload.error.message}`);
          }
          uploaded.push(beforePath);
          const afterUpload = await userClient.storage.from("case-published").upload(afterPath, afterFile.data, { contentType: "image/webp", upsert: false });
          if (afterUpload.error) {
            throw new Error(`術後公開圖片上傳失敗：${afterUpload.error.message}`);
          }
          uploaded.push(afterPath);
          const pairUpdate = await userClient.from("case_photo_pairs").update({
            before_public_path: beforePath,
            after_public_path: afterPath,
            published_canvas_ratio: pair.canvas_ratio,
            published_split_direction: pair.split_direction
          }).eq("id", pair.id);
          if (pairUpdate.error) throw pairUpdate.error;
        }

        const now = new Date().toISOString();
        const caseUpdate = await userClient.from("cases").update({ status: "published", reviewed_by: user.id, published_at: now, archived_at: null }).eq("id", caseId);
        if (caseUpdate.error) throw caseUpdate.error;
        await event("published", note);

        const previousPaths = caseItem.case_photo_pairs
          .flatMap((pair: Record<string, string | null>) => [pair.before_public_path, pair.after_public_path])
          .filter((path: string | null): path is string => typeof path === "string" && path.length > 0 && !uploaded.includes(path));
        if (previousPaths.length) {
          const cleanup = await userClient.storage.from("case-published").remove(previousPaths);
          if (cleanup.error) console.error("Previous published image cleanup failed", cleanup.error);
        }
        return json(request, 200, { ok: true, status: "published" });
      } catch (error) {
        const caseRollback = await userClient.from("cases").update({
          status: caseItem.status,
          reviewed_by: caseItem.reviewed_by ?? null,
          published_at: caseItem.published_at ?? null,
          archived_at: caseItem.archived_at ?? null
        }).eq("id", caseId);
        if (caseRollback.error) {
          console.error("Case publish rollback failed", caseRollback.error);
          throw new Error(`${error instanceof Error ? error.message : "發布失敗"}；案例狀態回復失敗：${caseRollback.error.message}`);
        }

        const pairRollbacks = await Promise.all(caseItem.case_photo_pairs.map((pair: Record<string, unknown>) => (
          userClient.from("case_photo_pairs").update({
            before_public_path: pair.before_public_path ?? null,
            after_public_path: pair.after_public_path ?? null,
            published_canvas_ratio: pair.published_canvas_ratio ?? null,
            published_split_direction: pair.published_split_direction ?? null
          }).eq("id", pair.id)
        )));
        const pairRollbackError = pairRollbacks.find(result => result.error)?.error;
        if (pairRollbackError) {
          console.error("Case photo publish rollback failed", pairRollbackError);
          throw new Error(`${error instanceof Error ? error.message : "發布失敗"}；照片狀態回復失敗：${pairRollbackError.message}`);
        }

        if (uploaded.length) {
          const cleanup = await userClient.storage.from("case-published").remove(uploaded);
          if (cleanup.error) console.error("Failed publish image cleanup failed", cleanup.error);
        }
        throw error;
      }
    }

    if (action === "unpublish") {
      if (caseItem.status !== "published") return json(request, 409, { error: "Case is not published" });
      await removePublishedImages();
      const { error } = await userClient.from("cases").update({ status: "changes_requested", reviewed_by: user.id, published_at: null }).eq("id", caseId);
      if (error) throw error;
      await event("unpublished", note);
      return json(request, 200, { ok: true, status: "changes_requested" });
    }

    if (action === "archive") {
      if (caseItem.status === "published") await removePublishedImages();
      const { error } = await userClient.from("cases").update({ status: "archived", reviewed_by: user.id, archived_at: new Date().toISOString(), published_at: null }).eq("id", caseId);
      if (error) throw error;
      await event("archived", note);
      return json(request, 200, { ok: true, status: "archived" });
    }

    return json(request, 400, { error: "Unsupported action" });
  } catch (error) {
    console.error(error);
    return json(request, 500, { error: error instanceof Error ? error.message : "Workflow failed" });
  }
});
