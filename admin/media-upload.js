(function () {
  "use strict";
  const media = window.CaseMedia;
  function fileType(file) {
    if (/\.(jpe?g|png|webp)$/i.test(file.name) && (!file.type || /^image\/(jpeg|png|webp)$/.test(file.type))) return "image";
    if (/\.mp4$/i.test(file.name) && (!file.type || file.type === "video/mp4")) return "video";
    throw new Error("請選擇 JPEG、PNG、WebP 照片或 H.264 MP4 影片");
  }
  function waitEvent(target, name, action) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("影片讀取逾時，請重新匯出 MP4")), 20000);
      function finish(error) {
        clearTimeout(timer); target.removeEventListener(name, done); target.removeEventListener("error", failed);
        if (error) reject(error); else resolve();
      }
      const done = () => finish();
      const failed = () => finish(new Error("此瀏覽器無法播放影片，請匯出 H.264／AAC MP4"));
      target.addEventListener(name, done, {once:true}); target.addEventListener("error", failed, {once:true});
      action();
    });
  }
  async function prepareVideo(file) {
    const meta = await media.inspectMp4((start,end) => file.slice(start,end).arrayBuffer(), file.size);
    const video = document.createElement("video");
    const preview = URL.createObjectURL(file);
    video.muted = true; video.playsInline = true; video.preload = "auto";
    try {
      await waitEvent(video, "loadeddata", () => {video.src = preview; video.load();});
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > media.MAX_SECONDS) throw new Error("影片需為 60 秒以內");
      if (video.duration > .5) await waitEvent(video, "seeked", () => {video.currentTime = .5;});
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const posterBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", .86));
      if (!posterBlob) throw new Error("無法產生影片封面，請重新匯出影片");
      return { blob:file, preview, meta, posterBlob, posterPreview:URL.createObjectURL(posterBlob) };
    } catch (error) { URL.revokeObjectURL(preview); throw error; }
    finally { video.pause(); video.removeAttribute("src"); video.load(); }
  }
  async function uploadVideo({db, config, file, path, signal, onProgress}) {
    if (!window.tus) throw new Error("續傳元件未載入，請重新整理後重試");
    const url = new URL(config.url);
    if (url.hostname.endsWith(".supabase.co")) url.hostname = url.hostname.replace(".supabase.co", ".storage.supabase.co");
    const {data, error} = await db.auth.getSession();
    if(error || !data?.session) throw new Error("登入已過期，請重新登入");
    return new Promise((resolve,reject) => {
      let settled = false;
      const finish = error => {
        if(settled) return; settled=true; signal?.removeEventListener("abort", cancel);
        if(error) reject(error); else resolve();
      };
      const upload = new window.tus.Upload(file, {
        endpoint: `${url.origin}/storage/v1/upload/resumable`,
        chunkSize: 6 * 1024 * 1024, retryDelays: [0,1000,3000,5000],
        uploadDataDuringCreation:true, removeFingerprintOnSuccess:true,
        headers: {authorization:`Bearer ${data.session.access_token}`,apikey:config.publishableKey},
        metadata:{bucketName:"case-video-drafts",objectName:path,contentType:"video/mp4",cacheControl:"3600"},
        fingerprint:async () => `case-video:${data.session.user.id}:${path}:${file.size}:${file.lastModified}`,
        onBeforeRequest:async req => {
          const {data:current,error:sessionError} = await db.auth.getSession();
          if(sessionError || !current?.session) throw new Error("登入已過期，請重新登入");
          req.setHeader("authorization", `Bearer ${current.session.access_token}`);
        },
        onProgress:(sent,total) => onProgress(Math.round(sent / total * 100)),
        onError:error => finish(new Error(`影片上傳失敗，可再次儲存以續傳：${error.message}`)),
        onSuccess:() => finish()
      });
      function cancel() {
        upload.abort(false).then(() => finish(new DOMException("上傳已取消，再次儲存可續傳", "AbortError")), finish);
      }
      signal?.addEventListener("abort", cancel, {once:true});
      if(signal?.aborted) {cancel();return;}
      upload.findPreviousUploads().then(previous => {
        if(signal?.aborted || settled) return;
        if(previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }).catch(finish);
    });
  }
  window.CaseMediaUpload = Object.freeze({fileType,prepareVideo,uploadVideo});
})();
