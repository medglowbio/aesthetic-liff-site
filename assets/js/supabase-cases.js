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

  function publicImageUrl(path) {
    if (!path || !client) return "";
    return client.storage.from("case-published").getPublicUrl(path).data.publicUrl;
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
        label: pair.label || "對照照片",
        followUpLabel: pair.follow_up_label || "",
        canvasRatio: photoLayouts ? photoLayouts.normalizeRatio(pair.published_canvas_ratio) : "4:3",
        splitDirection: photoLayouts ? photoLayouts.normalizeDirection(pair.published_split_direction) : "horizontal",
        before: {
          src: publicImageUrl(pair.before_public_path),
          alt: `案例 ${row.id} ${pair.label || ""}術前照片`
        },
        after: {
          src: publicImageUrl(pair.after_public_path),
          alt: `案例 ${row.id} ${pair.label || ""}術後照片`
        }
      }));

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      displayOrder: row.display_order,
      concernTags: row.concern_tags || [],
      treatmentIds: [...new Set(treatments)],
      beforeAfterPairs: pairs,
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
          published_canvas_ratio,published_split_direction
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
