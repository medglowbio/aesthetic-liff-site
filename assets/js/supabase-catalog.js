(function () {
  "use strict";

  const config = window.SUPABASE_CONFIG || {};
  const configured = Boolean(config.url && config.publishableKey && window.supabase);
  const client = configured
    ? window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true }
      })
    : null;
  const CACHE_KEY = "aespa-published-treatment-catalog-v1";

  function normalizeCatalog(value) {
    const catalog = typeof value === "string" ? JSON.parse(value) : value;
    if (!catalog || !Array.isArray(catalog.categories) || !Array.isArray(catalog.treatments)) {
      throw new Error("療程目錄資料格式不正確");
    }
    return catalog;
  }

  function readCache() {
    try {
      const value = localStorage.getItem(CACHE_KEY);
      return value ? normalizeCatalog(JSON.parse(value)) : null;
    } catch (error) {
      console.warn("Unable to read treatment catalog cache", error);
      return null;
    }
  }

  function writeCache(catalog) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(catalog));
    } catch (error) {
      console.warn("Unable to save treatment catalog cache", error);
    }
  }

  async function loadPublishedCatalog() {
    const cached = readCache();
    if (!client) return { catalog: cached, source: cached ? "cache" : "fallback", error: null };

    try {
      const { data, error } = await client.rpc("get_published_treatment_catalog");
      if (error) throw error;
      const catalog = normalizeCatalog(data);
      writeCache(catalog);
      return { catalog, source: "network", error: null };
    } catch (error) {
      console.error("Unable to load published treatment catalog", error);
      return { catalog: cached, source: cached ? "cache" : "fallback", error };
    }
  }

  window.CatalogRepository = {
    configured,
    client,
    loadPublishedCatalog
  };
})();
