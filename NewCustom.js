/*
Owncast Custom JS - V2.5
Copyright 2026 Cobra Videoclub

V1.8:
- Hide the custom smile button when the Owncast chat UI is not visible on mobile
- Show it automatically when the chat panel is opened
- Keep V1.7 native-button detection fix and V1.6 mobile initialization fix
- Reduce full-page DOM scans
- Safer responsive picker positioning
- Cache emoji API after first successful load
- More robust mention recoloring
- Better contenteditable insertion fallback
- Avoid duplicate field observers
*/

function initOwncastCustom() {
  "use strict";

  const CHAT_INPUT_SELECTOR = "#chat-input-content-editable";
  const ADMIN_DISPLAY_NAME = "Cobra Videoclub 🐍";

  const SELECTOR_MESSAGE = '[class*="ChatUserMessage_message"]';
  const SELECTOR_USERNAME = '[class*="ChatUserMessage_userName"]';
  const SELECTOR_MESSAGE_ROOT =
    '[class*="ChatUserMessage_root"], [class*="ChatUserMessage_ownMessage"]';
  const SELECTOR_CHAT_ROOT =
    '[class*="ChatContainer_virtuoso"], #chat-container';
  const SELECTOR_CHAT_FIELD =
    '[class*="ChatTextField_root"], [class*="ChatContainer_chatTextField"]';

  const FALLBACK_BUTTON_SIZE = 34;
  const PANEL_MARGIN = 8;
  const PANEL_GAP = 12;

  let emojiList = [];
  let emojiLoaded = false;
  let isOpen = false;
  let observedField = null;

  const nameToColor = new Map();

  function normalizeSpaces(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function normalizeForCompare(name) {
    const clean = normalizeSpaces(name).toLowerCase();
    try {
      return clean.replace(/\s*[\p{Extended_Pictographic}\p{So}]+$/u, "");
    } catch {
      return clean;
    }
  }

  const ADMIN_KEY = normalizeForCompare(ADMIN_DISPLAY_NAME);

  function isAdminName(name) {
    return normalizeForCompare(name) === ADMIN_KEY;
  }

  function getChatBox() {
    return document.querySelector(CHAT_INPUT_SELECTOR);
  }

  function getChatFieldRoot() {
    return document.querySelector(SELECTOR_CHAT_FIELD);
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;

    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const viewportWidth =
      document.documentElement.clientWidth || window.innerWidth;

    const viewportHeight =
      window.visualViewport?.height ||
      document.documentElement.clientHeight ||
      window.innerHeight;

    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
    );
  }

  function getChatRoot() {
    return document.querySelector(SELECTOR_CHAT_ROOT) || document.body;
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
  }

  function queryIncludingRoot(root, selector) {
    if (!root) return [];

    const found = [];

    if (root instanceof Element && root.matches(selector)) {
      found.push(root);
    }

    if (root.querySelectorAll) {
      found.push(...root.querySelectorAll(selector));
    }

    return found;
  }

  function throttleRaf(fn) {
    let scheduled = false;
    let latestArgs = null;

    return (...args) => {
      latestArgs = args;
      if (scheduled) return;

      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn(...latestArgs);
      });
    };
  }

  function ensureCaretInside(el) {
    if (!el) return null;

    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const selection = win.getSelection?.();

    if (!selection) return null;

    try {
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) return selection;
      }

      const range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);

      selection.removeAllRanges();
      selection.addRange(range);

      return selection;
    } catch {
      return selection;
    }
  }

  function fireInput(el, text = "") {
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function insertTextAtCaret(el, text) {
    if (!el) return;

    el.focus();

    const doc = el.ownerDocument || document;
    const selection = ensureCaretInside(el);

    const currentText = el.textContent || "";
    const addSpaceBefore =
      currentText &&
      !currentText.endsWith(" ") &&
      text &&
      !text.startsWith(" ");

    const insertText = `${addSpaceBefore ? " " : ""}${text} `;

    try {
      if (
        typeof doc.execCommand === "function" &&
        (!doc.queryCommandSupported ||
          doc.queryCommandSupported("insertText"))
      ) {
        const inserted = doc.execCommand(
          "insertText",
          false,
          insertText
        );

        if (inserted) {
          fireInput(el, insertText);
          return;
        }
      }
    } catch {
      // Use Range fallback below.
    }

    try {
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();

        const node = doc.createTextNode(insertText);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);

        selection.removeAllRanges();
        selection.addRange(range);

        fireInput(el, insertText);
        return;
      }
    } catch {
      // Last-resort fallback below.
    }

    el.textContent = currentText + insertText;
    fireInput(el, insertText);
  }

  function collectUserColorsAndMarkAdmin(root = document) {
    const nameEls = queryIncludingRoot(root, SELECTOR_USERNAME);

    nameEls.forEach((el) => {
      const name = normalizeSpaces(el.textContent);
      if (!name) return;

      const color = getComputedStyle(el).color;
      if (color) nameToColor.set(name, color);

      el.classList.toggle("oc-admin-name", isAdminName(name));
    });
  }

  function applyMessageAccentColors(root = document) {
    const usernames = queryIncludingRoot(root, SELECTOR_USERNAME);

    usernames.forEach((usernameEl) => {
      const color = getComputedStyle(usernameEl).color;
      if (!color) return;

      const messageRoot =
        usernameEl.closest(SELECTOR_MESSAGE_ROOT) ||
        usernameEl.closest('[class*="ChatUserMessage_"]');

      if (!messageRoot) return;

      messageRoot.classList.add("oc-message-accent");
      messageRoot.style.setProperty("--oc-message-accent-color", color);
    });
  }

  function markEmoteOnlyMessages(root = document) {
    const scope = root?.querySelectorAll ? root : document;

    // Clear previous direct-image markers in this scope.
    if (root instanceof HTMLImageElement && root.matches("img.emoji")) {
      root.classList.remove("oc-emote-single-img");
    }

    scope
      .querySelectorAll?.("img.emoji.oc-emote-single-img")
      .forEach((img) => img.classList.remove("oc-emote-single-img"));

    const images = [];

    if (root instanceof HTMLImageElement && root.matches("img.emoji")) {
      images.push(root);
    }

    scope.querySelectorAll?.("img.emoji").forEach((img) => images.push(img));

    images.forEach((img) => {
      // Prefer Owncast's message content wrapper, but provide fallbacks
      // for alternate/mobile DOM layouts.
      const message =
        img.closest(SELECTOR_MESSAGE) ||
        img.closest('[class*="ChatUserMessage_messagePadding"]') ||
        img.parentElement;

      if (!message) return;

      const emojis = message.querySelectorAll("img.emoji");
      if (emojis.length !== 1) return;

      // Clone the message content and remove the emoji.
      // If nothing visible remains, this is an emote-only message.
      const clone = message.cloneNode(true);
      clone.querySelectorAll("img.emoji").forEach((emoji) => emoji.remove());

      const remainingText = (clone.textContent || "")
        .replace(/\u200B/g, "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, "")
        .trim();

      if (!remainingText) {
        img.classList.add("oc-emote-single-img");
        message.classList.add("oc-emote-single");
      } else {
        img.classList.remove("oc-emote-single-img");
        message.classList.remove("oc-emote-single");
      }
    });
  }

  function buildMentionRegex(names) {
    const sorted = [...names]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    if (!sorted.length) return null;

    const escaped = sorted.map((name) =>
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );

    return new RegExp(
      `(^|\\s)@(${escaped.join("|")})(?=$|\\s|[.,!?;:])`,
      "g"
    );
  }

  function colorizeMentionsInNode(msgEl) {
    if (!msgEl) return;

    const names = Array.from(nameToColor.keys());
    const rx = buildMentionRegex(names);
    if (!rx) return;

    const walker = document.createTreeWalker(
      msgEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue?.includes("@")) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          if (parent.closest(".oc-mention")) {
            return NodeFilter.FILTER_REJECT;
          }

          if (parent.closest("a, button, input, textarea")) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((textNode) => {
      const text = textNode.nodeValue || "";
      rx.lastIndex = 0;

      let match;
      let last = 0;
      let changed = false;

      const fragment = document.createDocumentFragment();

      while ((match = rx.exec(text)) !== null) {
        const full = match[0];
        const leading = match[1] || "";
        const name = match[2] || "";
        const start = match.index;

        fragment.appendChild(
          document.createTextNode(text.slice(last, start))
        );

        if (leading) {
          fragment.appendChild(
            document.createTextNode(leading)
          );
        }

        const span = document.createElement("span");
        span.className = "oc-mention";
        span.style.color =
          nameToColor.get(name) || "var(--mention-fallback)";
        span.textContent = `@${name}`;

        fragment.appendChild(span);

        last = start + full.length;
        changed = true;
      }

      if (!changed) return;

      fragment.appendChild(
        document.createTextNode(text.slice(last))
      );

      textNode.parentNode?.replaceChild(fragment, textNode);
    });
  }

  function colorizeMentionsInAllMessages(root = document) {
    const messages = queryIncludingRoot(root, SELECTOR_MESSAGE);
    messages.forEach(colorizeMentionsInNode);
  }

  function processChat(root = getChatRoot()) {
    collectUserColorsAndMarkAdmin(root);
    applyMessageAccentColors(root);
    markEmoteOnlyMessages(root);
    colorizeMentionsInAllMessages(root);
  }

  document.body.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const username = target.closest(SELECTOR_USERNAME);
    if (!username) return;

    const name = normalizeSpaces(username.textContent);
    if (!name) return;

    const color = getComputedStyle(username).color;
    if (color) nameToColor.set(name, color);

    insertTextAtCaret(getChatBox(), `@${name}`);
  });

  const btn = document.createElement("button");
  btn.className = "oc-emoji-btn oc-emoji-btn--fixed";
  btn.type = "button";
  btn.title = "Emotes";
  btn.setAttribute("aria-label", "Ouvrir les emotes");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "🙂";

  const panel = document.createElement("div");
  panel.className = "oc-emoji-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Emotes");

  panel.innerHTML = `
    <div class="oc-emoji-panel-header">
      <div class="oc-emoji-title">Emotes</div>
      <button
        class="oc-emoji-close"
        type="button"
        aria-label="Fermer"
      >✕</button>
    </div>
    <div class="oc-emoji-panel-body">
      <div class="oc-emoji-grid"></div>
      <div class="oc-emoji-empty" hidden>
        Aucune emote trouvée.
      </div>
    </div>
  `;

  document.body.append(btn, panel);

  const grid = panel.querySelector(".oc-emoji-grid");
  const empty = panel.querySelector(".oc-emoji-empty");
  const closeBtn = panel.querySelector(".oc-emoji-close");

  function normalizeEmojiApi(data) {
    if (Array.isArray(data)) {
      return data
        .map((item) => ({
          name: String(item?.name || ""),
          url: String(item?.url || ""),
        }))
        .filter((item) => item.name && item.url);
    }

    if (data && typeof data === "object") {
      return Object.entries(data)
        .map(([name, url]) => ({
          name: String(name),
          url: String(url),
        }))
        .filter((item) => item.name && item.url);
    }

    return [];
  }

  async function loadEmojis(force = false) {
    if (emojiLoaded && !force) return emojiList;

    try {
      const response = await fetch("/api/emoji", {
        cache: "no-store",
        credentials: "same-origin",
      });

      if (!response.ok) {
        throw new Error(
          `/api/emoji returned ${response.status}`
        );
      }

      const data = await response.json();

      emojiList = normalizeEmojiApi(data)
        .filter((emoji) => emoji.url.includes("/img/emoji/"))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          })
        );

      emojiLoaded = true;
    } catch (error) {
      console.error(
        "[oc-emotes] failed to load /api/emoji",
        error
      );

      emojiList = [];
      emojiLoaded = false;
    }

    return emojiList;
  }

  function renderGrid() {
    if (!grid || !empty) return;

    grid.replaceChildren();

    if (!emojiList.length) {
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    const fragment = document.createDocumentFragment();

    for (const emoji of emojiList) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "oc-emoji-tile";
      tile.title = `:${emoji.name}:`;
      tile.setAttribute(
        "aria-label",
        `Insérer :${emoji.name}:`
      );

      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = emoji.url;

      tile.appendChild(img);

      tile.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        insertTextAtCaret(
          getChatBox(),
          `:${emoji.name}:`
        );

        closePanel();
      });

      fragment.appendChild(tile);
    }

    grid.appendChild(fragment);
  }

  function openPanel() {
    isOpen = true;
    panel.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");

    positionOverlay();
    positionPanel();
    renderGrid();
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
  }

  closeBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });

  btn.addEventListener(
    "click",
    async (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (isOpen) {
        closePanel();
        return;
      }

      await loadEmojis();
      openPanel();
    },
    true
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen) {
      closePanel();
      btn.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (!isOpen) return;

    const target = event.target;
    if (!(target instanceof Node)) return;

    if (panel.contains(target) || btn.contains(target)) {
      return;
    }

    closePanel();
  });

  function findNativeEmojiButton() {
    const chatField = getChatFieldRoot();
    const scope = chatField || document;

    const buttons = Array.from(
      scope.querySelectorAll("button")
    ).filter((button) => button !== btn && !button.classList.contains("oc-emoji-btn"));

    const labeled = buttons.find((button) => {
      const label = String(
        button.getAttribute("aria-label") ||
          button.title ||
          ""
      ).toLowerCase();

      return (
        label.includes("emoji") ||
        label.includes("emote")
      );
    });

    if (labeled) return labeled;

    if (chatField) {
      const nearbyButtons = Array.from(
        chatField.querySelectorAll("button")
      ).filter((button) => button !== btn && !button.classList.contains("oc-emoji-btn"));

      if (nearbyButtons.length) {
        return nearbyButtons[nearbyButtons.length - 1];
      }
    }

    return null;
  }

  const positionOverlay = throttleRaf(() => {
    const chatField = getChatFieldRoot();

    // On mobile Owncast may keep the chat DOM mounted while the chat panel
    // itself is closed/off-screen. Do not show our fallback button then.
    if (!isElementVisible(chatField)) {
      btn.style.display = "none";
      if (isOpen) closePanel();
      return;
    }

    btn.style.display = "";

    const nativeBtn = findNativeEmojiButton();

    if (!nativeBtn?.parentElement) {
      if (btn.parentElement !== document.body) {
        document.body.appendChild(btn);
      }

      btn.classList.add("oc-emoji-btn--fixed");

      btn.style.position = "";
      btn.style.left = "";
      btn.style.top = "";
      btn.style.right = "";
      btn.style.bottom = "";
      btn.style.width = "";
      btn.style.height = "";

      return;
    }

    const parent = nativeBtn.parentElement;
    const parentStyle = getComputedStyle(parent);

    if (parentStyle.position === "static") {
      parent.style.position = "relative";
    }

    if (btn.parentElement !== parent) {
      parent.appendChild(btn);
    }

    btn.classList.remove("oc-emoji-btn--fixed");
    btn.style.position = "absolute";

    const nativeRect = nativeBtn.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    const left =
      nativeRect.left -
      parentRect.left +
      parent.scrollLeft;

    const top =
      nativeRect.top -
      parentRect.top +
      parent.scrollTop;

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.right = "";
    btn.style.bottom = "";

    btn.style.width =
      `${nativeRect.width || FALLBACK_BUTTON_SIZE}px`;

    btn.style.height =
      `${nativeRect.height || FALLBACK_BUTTON_SIZE}px`;

    nativeBtn.style.setProperty(
      "opacity",
      "0",
      "important"
    );

    nativeBtn.style.setProperty(
      "pointer-events",
      "none",
      "important"
    );
  });

  function positionPanel() {
    if (!isOpen) return;

    const buttonRect = btn.getBoundingClientRect();

    const viewportWidth =
      document.documentElement.clientWidth ||
      window.innerWidth;

    const viewportHeight =
      window.visualViewport?.height ||
      document.documentElement.clientHeight ||
      window.innerHeight;

    const panelRect = panel.getBoundingClientRect();

    const panelWidth =
      panelRect.width ||
      Math.min(360, viewportWidth - PANEL_MARGIN * 2);

    const panelHeight =
      panelRect.height ||
      Math.min(420, viewportHeight - PANEL_MARGIN * 2);

    let left = buttonRect.right - panelWidth;
    left = clamp(
      left,
      PANEL_MARGIN,
      viewportWidth - panelWidth - PANEL_MARGIN
    );

    const roomAbove =
      buttonRect.top - PANEL_GAP - PANEL_MARGIN;

    const roomBelow =
      viewportHeight -
      buttonRect.bottom -
      PANEL_GAP -
      PANEL_MARGIN;

    let top;

    if (
      roomAbove >= panelHeight ||
      roomAbove >= roomBelow
    ) {
      top = buttonRect.top - panelHeight - PANEL_GAP;
    } else {
      top = buttonRect.bottom + PANEL_GAP;
    }

    top = clamp(
      top,
      PANEL_MARGIN,
      viewportHeight - panelHeight - PANEL_MARGIN
    );

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "";
    panel.style.bottom = "";
  }

  const reposition = throttleRaf(() => {
    positionOverlay();

    if (isOpen) {
      positionPanel();
    }
  });

  window.addEventListener("resize", reposition, {
    passive: true,
  });

  window.addEventListener("orientationchange", reposition);

  window.visualViewport?.addEventListener(
    "resize",
    reposition,
    { passive: true }
  );

  window.visualViewport?.addEventListener(
    "scroll",
    reposition,
    { passive: true }
  );

  const fieldObserver = new MutationObserver(reposition);

  function attachFieldObserver() {
    const root = getChatFieldRoot();
    if (!root || root === observedField) return Boolean(root);

    fieldObserver.disconnect();
    observedField = root;

    fieldObserver.observe(root, {
      childList: true,
      subtree: true,
    });

    return true;
  }

  const chatObserver = new MutationObserver(
    throttleRaf((mutations) => {
      const roots = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            roots.add(node);
          }
        }
      }

      if (!roots.size) {
        processChat(getChatRoot());
      } else {
        const messageRoots = new Set();

        roots.forEach((root) => {
          collectUserColorsAndMarkAdmin(root);
          applyMessageAccentColors(root);

          if (root.matches?.(SELECTOR_MESSAGE)) {
            messageRoots.add(root);
          }

          const parentMessage = root.closest?.(SELECTOR_MESSAGE);
          if (parentMessage) {
            messageRoots.add(parentMessage);
          }

          root.querySelectorAll?.(SELECTOR_MESSAGE).forEach((message) => {
            messageRoots.add(message);
          });
        });

        if (messageRoots.size) {
          messageRoots.forEach((message) => {
            markEmoteOnlyMessages(message);
            colorizeMentionsInNode(message);
          });
        } else {
          roots.forEach((root) => {
            markEmoteOnlyMessages(root);
            colorizeMentionsInAllMessages(root);
          });
        }
      }

      // Owncast/React can update the emoji image independently of the
      // surrounding message, especially on mobile. Re-scan emoji-only
      // messages after every throttled chat mutation.
      markEmoteOnlyMessages(getChatRoot());

      attachFieldObserver();
      reposition();
    })
  );

  function attachChatObserver() {
    const root = getChatRoot();

    chatObserver.disconnect();

    chatObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function bootstrap() {
    processChat(getChatRoot());
    positionOverlay();
    attachFieldObserver();
    attachChatObserver();
  }

  loadEmojis().then(renderGrid);

  bootstrap();

  // Owncast mounts/replaces parts of the UI asynchronously.
  setTimeout(bootstrap, 300);
  setTimeout(bootstrap, 900);
  setTimeout(bootstrap, 1600);
}

if (document.readyState === "loading") {
  window.addEventListener("load", initOwncastCustom, { once: true });
} else {
  initOwncastCustom();
}
