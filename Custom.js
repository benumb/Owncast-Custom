// =========================================================
// Owncast custom front tweaks
// - Custom emote picker from /api/emoji (no search)
// - Custom button overlays native emoji button (same parent, absolute) => click ALWAYS works
// - Mentions inside chat messages get SAME color as mentioned username
// =========================================================

window.addEventListener("load", () => {
  const CHAT_INPUT_SELECTOR = "#chat-input-content-editable";

  const ADMIN_DISPLAY_NAME = "Cobra Videoclub 🐍";

  const SELECTOR_MESSAGE =
    "[class^='ChatUserMessage_message'], [class*=' ChatUserMessage_message']";
  const SELECTOR_USERNAME =
    "[class^='ChatUserMessage_userName'], [class*=' ChatUserMessage_userName']";

  let emojiList = [];
  let isOpen = false;

  // =========================================================
  // Utils
  // =========================================================
  const nameToColor = new Map();

  function normalizeSpaces(s) {
    return (s || "").trim().replace(/\s+/g, " ");
  }

  function normalizeForCompare(name) {
    const clean = normalizeSpaces(name).toLowerCase();
    return clean.replace(/\s*[\p{Extended_Pictographic}\p{So}]+$/u, "");
  }

  const ADMIN_KEY = normalizeForCompare(ADMIN_DISPLAY_NAME);
  function isAdminName(name) {
    return normalizeForCompare(name) === ADMIN_KEY;
  }

  function getChatBox() {
    return document.querySelector(CHAT_INPUT_SELECTOR);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function throttleRaf(fn) {
    let scheduled = false;
    return (...args) => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn(...args);
      });
    };
  }

  // =========================================================
  // Insert into contenteditable (best-effort)
  // =========================================================
  function ensureCaretInside(el) {
    if (!el) return null;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const sel = win.getSelection ? win.getSelection() : null;
    if (!sel) return null;

    try {
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) return sel;
      }
      const endRange = doc.createRange();
      endRange.selectNodeContents(el);
      endRange.collapse(false);
      sel.removeAllRanges();
      sel.addRange(endRange);
      return sel;
    } catch {
      return sel;
    }
  }

  function fireInput(el) {
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function insertTextAtCaret(el, text) {
    if (!el) return;
    el.focus();

    const doc = el.ownerDocument || document;
    ensureCaretInside(el);

    const addSpaceBefore =
      el.textContent && !el.textContent.endsWith(" ") && text && !text.startsWith(" ");
    const insertText = (addSpaceBefore ? " " : "") + text + " ";

    // execCommand often works best for contenteditable
    try {
      if (doc.queryCommandSupported && doc.queryCommandSupported("insertText")) {
        doc.execCommand("insertText", false, insertText);
        fireInput(el);
        return;
      }
    } catch {}

    // fallback
    el.textContent = (el.textContent || "") + insertText;
    fireInput(el);
  }

  // =========================================================
  // Collect colors + mark admin
  // =========================================================
  function collectUserColorsAndMarkAdmin(root = document) {
    const nameEls = root.querySelectorAll(SELECTOR_USERNAME);
    nameEls.forEach((el) => {
      const name = normalizeSpaces(el.textContent || "");
      if (!name) return;

      const color = getComputedStyle(el).color;
      if (color) nameToColor.set(name, color);

      if (isAdminName(name)) el.classList.add("oc-admin-name");
      else el.classList.remove("oc-admin-name");
    });
  }

  // =========================================================
  // Emote-only messages
  // =========================================================
  function markEmoteOnlyMessages(root = document) {
    const messages = root.querySelectorAll(SELECTOR_MESSAGE);
    messages.forEach((msgEl) => {
      msgEl.classList.remove("oc-emote-single");

      const emojis = msgEl.querySelectorAll("img.emoji");
      if (emojis.length !== 1) return;

      const clone = msgEl.cloneNode(true);
      clone.querySelectorAll("img.emoji").forEach((e) => e.remove());

      const text = (clone.textContent || "").replace(/\s+/g, "").trim();
      if (!text) msgEl.classList.add("oc-emote-single");
    });
  }

  // =========================================================
  // Mention coloring inside chat messages
  // =========================================================
  function buildMentionRegex(names) {
    const sorted = [...names].sort((a, b) => b.length - a.length);
    const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!escaped.length) return null;

    // match " @Name" or start-of-text "@Name"
    return new RegExp(`(^|\\s)@(${escaped.join("|")})(?!\\S)`, "g");
  }

  function colorizeMentionsInNode(msgEl) {
    if (!msgEl) return;
    if (msgEl.dataset && msgEl.dataset.ocMentionsDone === "1") return;

    const names = Array.from(nameToColor.keys()).filter(Boolean);
    const rx = buildMentionRegex(names);
    if (!rx) return;

    const walker = document.createTreeWalker(
      msgEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || node.nodeValue.indexOf("@") === -1) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest(".oc-mention")) return NodeFilter.FILTER_REJECT;
          if (p.closest("a, button, input, textarea")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((textNode) => {
      const text = textNode.nodeValue;
      rx.lastIndex = 0;

      let m;
      let last = 0;
      let changed = false;
      const frag = document.createDocumentFragment();

      while ((m = rx.exec(text)) !== null) {
        const full = m[0];
        const leading = m[1] || "";
        const name = m[2] || "";
        const start = m.index;

        frag.appendChild(document.createTextNode(text.slice(last, start)));
        if (leading) frag.appendChild(document.createTextNode(leading));

        const span = document.createElement("span");
        span.className = "oc-mention";
        span.style.color = nameToColor.get(name) || "var(--mention-fallback)";
        span.textContent = "@" + name;

        frag.appendChild(span);

        last = start + full.length;
        changed = true;
      }

      if (!changed) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    });

    msgEl.dataset.ocMentionsDone = "1";
  }

  function colorizeMentionsInAllMessages(root = document) {
    const messages = root.querySelectorAll(SELECTOR_MESSAGE);
    messages.forEach((msgEl) => colorizeMentionsInNode(msgEl));
  }

  // =========================================================
  // Click username => insert @name into input
  // =========================================================
  document.body.addEventListener("click", (event) => {
    const el = event.target.closest(SELECTOR_USERNAME);
    if (!el) return;

    const name = normalizeSpaces(el.textContent || "");
    if (!name) return;

    const color = getComputedStyle(el).color;
    if (color) nameToColor.set(name, color);

    insertTextAtCaret(getChatBox(), "@" + name);
  });

  // =========================================================
  // Custom Emoji Picker UI (no search)
  // =========================================================
  const btn = document.createElement("button");
  btn.className = "oc-emoji-btn oc-emoji-btn--fixed";
  btn.type = "button";
  btn.title = "Emotes";
  btn.setAttribute("aria-label", "Open emotes");
  btn.textContent = "🙂";

  const panel = document.createElement("div");
  panel.className = "oc-emoji-panel";
  panel.innerHTML = `
    <div class="oc-emoji-panel-header">
      <div class="oc-emoji-title">Emotes</div>
      <button class="oc-emoji-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="oc-emoji-panel-body">
      <div class="oc-emoji-grid"></div>
      <div class="oc-emoji-empty" style="display:none;">Aucune emote trouvée.</div>
    </div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const grid = panel.querySelector(".oc-emoji-grid");
  const empty = panel.querySelector(".oc-emoji-empty");
  const closeBtn = panel.querySelector(".oc-emoji-close");

  function normalizeEmojiApi(data) {
    if (Array.isArray(data)) {
      return data
        .map((x) => ({ name: String(x.name || ""), url: String(x.url || "") }))
        .filter((x) => x.name && x.url);
    }
    if (data && typeof data === "object") {
      return Object.entries(data)
        .map(([name, url]) => ({ name: String(name), url: String(url) }))
        .filter((x) => x.name && x.url);
    }
    return [];
  }

  async function loadEmojis() {
    try {
      const res = await fetch("/api/emoji", { cache: "no-store" });
      const data = await res.json();
      emojiList = normalizeEmojiApi(data)
        .filter((e) => (e.url || "").includes("/img/emoji/"))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error("[oc-emotes] failed to load /api/emoji", err);
      emojiList = [];
    }
  }

  function renderGrid() {
    grid.innerHTML = "";

    if (!emojiList.length) {
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";

    for (const e of emojiList) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "oc-emoji-tile";
      tile.title = `:${e.name}:`;

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = e.name;
      img.src = e.url;

      tile.appendChild(img);

      tile.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        insertTextAtCaret(getChatBox(), `:${e.name}:`);
        closePanel();
      });

      grid.appendChild(tile);
    }
  }

  function openPanel() {
    isOpen = true;
    panel.classList.add("is-open");
    positionOverlay(); // ensures right placement
    positionPanel();
    renderGrid();
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove("is-open");
  }

  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePanel();
  });

  // IMPORTANT: capture click early so nothing steals it
  btn.addEventListener(
    "click",
    async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) {
        closePanel();
        return;
      }
      await loadEmojis();
      openPanel();
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closePanel();
  });

  document.addEventListener("click", (e) => {
    if (!isOpen) return;
    const t = e.target;
    if (panel.contains(t) || btn.contains(t)) return;
    closePanel();
  });

  // =========================================================
  // Overlay positioning: SAME PARENT as native emoji button
  // =========================================================
  function getChatFieldRoot() {
    return (
      document.querySelector("[class^='ChatTextField_root'], [class*=' ChatTextField_root']") ||
      document.querySelector("[class^='ChatContainer_chatTextField'], [class*=' ChatContainer_chatTextField']") ||
      null
    );
  }

  function findNativeEmojiButton() {
    const chatField = getChatFieldRoot();
    const scope = chatField || document;

    const btns = Array.from(scope.querySelectorAll("button"));

    const labeled = btns.find((b) => {
      const t = ((b.getAttribute("aria-label") || b.title || "") + "").toLowerCase();
      return t.includes("emoji") || t.includes("emote");
    });
    if (labeled) return labeled;

    const near = chatField ? Array.from(chatField.querySelectorAll("button")) : [];
    if (near.length) return near[near.length - 1];

    return null;
  }

  const positionOverlay = throttleRaf(() => {
    const nativeBtn = findNativeEmojiButton();

    if (!nativeBtn || !nativeBtn.parentElement) {
      // fallback fixed
      if (!btn.classList.contains("oc-emoji-btn--fixed")) btn.classList.add("oc-emoji-btn--fixed");
      btn.style.left = "";
      btn.style.top = "";
      btn.style.right = "16px";
      btn.style.bottom = "72px";
      return;
    }

    const parent = nativeBtn.parentElement;

    // ensure parent is a positioning context
    const ps = getComputedStyle(parent);
    if (ps.position === "static") parent.style.position = "relative";

    // move our button into same parent
    if (btn.parentElement !== parent) parent.appendChild(btn);

    btn.classList.remove("oc-emoji-btn--fixed");
    btn.style.position = "absolute";

    // overlay exactly on native button position inside parent
    // (offsetLeft/Top are relative to offsetParent; in practice here it's ok once in same parent)
    const left = nativeBtn.offsetLeft;
    const top = nativeBtn.offsetTop;
    const w = nativeBtn.offsetWidth || 34;
    const h = nativeBtn.offsetHeight || 34;

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.width = `${w}px`;
    btn.style.height = `${h}px`;

    // make native effectively "hidden" but still present
    nativeBtn.style.setProperty("opacity", "0", "important");
    nativeBtn.style.setProperty("pointer-events", "none", "important");
  });

  function positionPanel() {
    const r = btn.getBoundingClientRect();
    const panelW = 360;
    const panelH = 420;

    const left = clamp(r.right - panelW, 8, window.innerWidth - panelW - 8);
    const top = clamp(r.top - panelH - 12, 8, window.innerHeight - panelH - 8);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "";
    panel.style.bottom = "";
  }

  window.addEventListener("resize", () => {
    positionOverlay();
    if (isOpen) positionPanel();
  });

  // Observe only the chat field for re-renders
  const fieldObserver = new MutationObserver(() => {
    positionOverlay();
    if (isOpen) positionPanel();
  });

  function attachFieldObserver() {
    const root = getChatFieldRoot();
    if (!root) return false;
    fieldObserver.observe(root, { childList: true, subtree: true });
    return true;
  }

  // =========================================================
  // Chat observer (throttled)
  // =========================================================
  const chatObserver = new MutationObserver(
    throttleRaf(() => {
      collectUserColorsAndMarkAdmin(document);
      markEmoteOnlyMessages(document);
      colorizeMentionsInAllMessages(document);
      positionOverlay();
      if (isOpen) positionPanel();
    })
  );
  chatObserver.observe(document.body, { childList: true, subtree: true });

  // Bootstrap (Owncast mounts async)
  function bootstrapOnce() {
    collectUserColorsAndMarkAdmin(document);
    markEmoteOnlyMessages(document);
    colorizeMentionsInAllMessages(document);
    positionOverlay();
    attachFieldObserver();
  }

  loadEmojis().then(() => renderGrid());

  bootstrapOnce();
  setTimeout(bootstrapOnce, 300);
  setTimeout(bootstrapOnce, 900);
  setTimeout(bootstrapOnce, 1600);
});
