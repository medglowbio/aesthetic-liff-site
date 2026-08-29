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

  window.AdminUI = Object.freeze({ escapeHtml, parseList, createToast });
})();
