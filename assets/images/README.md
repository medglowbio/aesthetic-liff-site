# Image assets

這個資料夾保留公開網站直接載入的靜態圖片，以及 `index.html` 內嵌療程備援所需的既有圖片。

正式療程、保養品與分類圖片請從 `/admin/catalog.html` 上傳。後台會裁切為 WebP 4:3（1200 x 900 px），草稿與正式圖片分別儲存在 Supabase Storage；不需再手動修改 `index.html` 的 `DETAIL_MAP`。

刪除這裡的既有圖片前，需同時確認程式碼、內嵌備援資料與 Supabase 已發布目錄均未引用該檔案。
