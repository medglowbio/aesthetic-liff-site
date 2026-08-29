(function () {
  "use strict";

  function requireElement(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing auth gate element: ${id}`);
    return element;
  }

  function create({ hiddenViewIds = [] } = {}) {
    const gate = requireElement("auth-gate");
    const message = requireElement("auth-gate-message");
    const retry = requireElement("auth-gate-retry");
    const hiddenViews = hiddenViewIds.map(requireElement);

    function hideViews() {
      hiddenViews.forEach(view => { view.hidden = true; });
    }

    function showLoading(text = "正在確認登入狀態") {
      hideViews();
      gate.hidden = false;
      gate.setAttribute("aria-busy", "true");
      message.textContent = text;
      retry.hidden = true;
    }

    function showError(text) {
      showLoading(text);
      gate.setAttribute("aria-busy", "false");
      retry.hidden = false;
    }

    function hide() {
      gate.hidden = true;
    }

    retry.addEventListener("click", () => window.location.reload());
    return Object.freeze({ showLoading, showError, hide });
  }

  window.AdminAuthGate = Object.freeze({ create });
})();
