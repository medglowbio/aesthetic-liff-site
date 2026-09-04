(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function parseList(value) {
    return [...new Set(String(value || "")
      .split(/[,，\n]/)
      .map(item => item.trim())
      .filter(Boolean))];
  }

  function createToast({ elementId = "admin-toast", duration = 3000 } = {}) {
    const element = document.getElementById(elementId);
    if (!element) throw new Error(`Missing toast element: ${elementId}`);
    let hideTimer = null;

    return message => {
      element.textContent = message;
      element.classList.add("show");
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        element.classList.remove("show");
        hideTimer = null;
      }, duration);
    };
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function revokeBlobUrl(url) {
    if (typeof url === "string" && url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("無法讀取這張圖片"));
      image.src = url;
    });
  }

  // Re-encodes an upload to WebP with metadata stripped, capping the longest edge.
  async function sanitizeImage(file, { maxEdge = 4096, quality = .94 } = {}) {
    const originalUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(originalUrl);
      const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
      const scale = Math.min(1, maxEdge / longestEdge);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob) throw new Error("圖片轉檔失敗");
      const preview = URL.createObjectURL(blob);
      return { blob, preview, image: await loadImage(preview) };
    } finally {
      URL.revokeObjectURL(originalUrl);
    }
  }

  window.AdminUI = Object.freeze({
    escapeHtml, parseList, createToast, clamp, revokeBlobUrl, loadImage, sanitizeImage
  });
})();
