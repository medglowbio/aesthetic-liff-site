(function () {
  "use strict";

  const config = window.SUPABASE_CONFIG || {};
  const photoLayouts = window.CasePhotoLayouts;
  const configured = Boolean(
    config.url &&
    config.publishableKey &&
    window.supabase &&
    typeof window.supabase.createClient === "function"
  );
  const client = configured
    ? window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  function publicImageUrl(path, type = "image") {
    if (!path || !client) return "";
    return client.storage.from(type === "video" ? "case-video-published" : "case-published").getPublicUrl(path).data.publicUrl;
  }

  function mapCase(row) {
    const treatments = (row.case_treatments || [])
      .map(item => item.treatment_id)
      .filter(Boolean);
    const pairs = (row.case_photo_pairs || [])
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
      .map(pair => ({
        id: pair.id,
        layoutKind: pair.published_layout_kind || "comparison",
        label: pair.label || "案例素材",
        followUpLabel: pair.follow_up_label || "",
        canvasRatio: photoLayouts ? photoLayouts.normalizeRatio(pair.published_canvas_ratio) : "4:3",
        splitDirection: photoLayouts ? photoLayouts.normalizeDirection(pair.published_split_direction) : "horizontal",
        before: {
          src: publicImageUrl(pair.before_public_path, pair.published_before_media_type),
          type: pair.published_before_media_type || "image",
          poster: publicImageUrl(pair.before_poster_public_path, "video"),
          meta: pair.published_before_video_meta || null,
          alt: `案例 ${row.id} ${pair.label || ""}${pair.published_layout_kind === "single" ? "素材" : "術前素材"}`
        },
        after: {
          src: publicImageUrl(pair.after_public_path, pair.published_after_media_type),
          type: pair.published_after_media_type || "image",
          poster: publicImageUrl(pair.after_poster_public_path, "video"),
          meta: pair.published_after_video_meta || null,
          alt: `案例 ${row.id} ${pair.label || ""}術後素材`
        }
      }));

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      displayOrder: row.display_order,
      concernTags: row.concern_tags || [],
      treatmentIds: [...new Set(treatments)],
      mediaGroups: pairs,
      beforeAfterPairs: pairs, // compatibility for existing consumers
      summary: row.summary || "",
      consentConfirmed: row.consent_confirmed === true
    };
  }

  async function loadPublishedCases() {
    if (!client) return { configured: false, cases: null };
    const { data, error } = await client
      .from("cases")
      .select(`
        id,title,status,display_order,concern_tags,summary,consent_confirmed,
        case_treatments(treatment_id),
        case_photo_pairs(
          id,label,follow_up_label,sort_order,before_public_path,after_public_path,
          published_canvas_ratio,published_split_direction,published_layout_kind,
          published_before_media_type,published_after_media_type,
          before_poster_public_path,after_poster_public_path,published_before_video_meta,published_after_video_meta
        )
      `)
      .eq("status", "published")
      .eq("consent_confirmed", true)
      .order("display_order", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    return { configured: true, cases: (data || []).map(mapCase) };
  }

  window.CaseRepository = { configured, client, loadPublishedCases, publicImageUrl };
})();
