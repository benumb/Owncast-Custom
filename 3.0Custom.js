/*
Owncast Custom JS - V2.8.1
Copyright 2026 Cobra Videoclub

Owncast 0.3.x compatibility:
- Use Owncast's documented stable chat hooks (#chat-container / .chat-message_user)
- Stop depending on ChatUserMessage_* / ChatTextField_* as primary selectors
- Keep compatibility fallbacks for older/current DOM variants
- More robust chat input detection (contenteditable, textarea, input)
- More robust username detection inside user messages
- Safer native emoji-button replacement (never hides an unknown/send button)
- Keep mentions, user color accents, admin emphasis, emoji picker and emoji-only sizing
*/

function initOwncastCustom() {
  "use strict";

  const ADMIN_DISPLAY_NAME = "Cobra Videoclub 🐍";

  // Owncast-documented stable hooks.
  const SELECTOR_CHAT_ROOT = "#chat-container";
  const SELECTOR_MESSAGE_ROOT = ".chat-message_user";

  // Owncast does not currently document a stable selector for the chat input
  // or username element. Prefer semantic selectors, then compatibility fallbacks.
  const CHAT_INPUT_SELECTORS = [
    '#chat-container [contenteditable="true"][role="textbox"]',
    '#chat-container [contenteditable="true"]',
    '#chat-container textarea',
    '#chat-container input[type="text"]',
    '#chat-input-content-editable',
  ];

  const USERNAME_SELECTORS = [
    "[data-chat-username]",
    "[data-username]",
    '[class*="userName"]',
    '[class*="username"]',
    '[class*="UserName"]',
    '[class*="Username"]',
    '[class*="displayName"]',
    '[class*="DisplayName"]',
    '[class*="ChatUserMessage_userName"]',
  ];

  const FALLBACK_BUTTON_SIZE = 34;
  const PANEL_MARGIN = 8;
  const PANEL_GAP = 12;

  let emojiList = [];
  let emojiLoaded = false;
  let isOpen = false;
  let hiddenNativeButton = null;

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
    if (rect.width <= 0 || rect.height <= 0) return false;

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
    return document.querySelector(SELECTOR_CHAT_ROOT);
  }

  function getMessageRoots(root = getChatRoot() || document) {
    if (!root) return [];

    const found = [];
    if (root instanceof Element && root.matches(SELECTOR_MESSAGE_ROOT)) {
      found.push(root);
    }

    root
      .querySelectorAll?.(SELECTOR_MESSAGE_ROOT)
      .forEach((el) => found.push(el));

    return found;
  }

  function getChatBox() {
    const candidates = [];

    for (const selector of CHAT_INPUT_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => {
        if (!candidates.includes(el)) candidates.push(el);
      });
    }

    const usable = candidates.filter((el) => {
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        (el.disabled || el.readOnly)
      ) {
        return false;
      }
      return true;
    });

    return usable.find(isElementVisible) || usable[0] || null;
  }

  function getChatFieldRoot() {
    const input = getChatBox();
    const chatRoot = getChatRoot();
    if (!input) return null;

    // Walk upward and choose the smallest wrapper around the input that also
    // contains controls. This is more stable than generated React class names.
    let node = input instanceof Element ? input : null;
    let fallback = input.parentElement;

    for (let depth = 0; node && depth < 7; depth += 1) {
      if (node !== input && node.querySelector?.("button")) {
        return node;
      }

      fallback = node.parentElement || fallback;
      if (node === chatRoot) break;
      node = node.parentElement;
    }

    return fallback || input;
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
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

  function isPlausibleUsernameElement(el, messageRoot) {
    if (!(el instanceof Element)) return false;
    if (!messageRoot?.contains(el)) return false;
    if (el.closest(".oc-mention")) return false;
    if (el.matches("input, textarea, button")) return false;

    const text = normalizeSpaces(el.textContent);
    if (!text || text.length > 80 || /[\r\n]/.test(text)) return false;

    // Avoid choosing a wrapper containing most of the message content.
    if (el.querySelector("p, [contenteditable='true']")) return false;

    return true;
  }

  function findUsernameElement(messageRoot) {
    if (!(messageRoot instanceof Element)) return null;

    for (const selector of USERNAME_SELECTORS) {
      const candidates = messageRoot.querySelectorAll(selector);
      for (const candidate of candidates) {
        if (isPlausibleUsernameElement(candidate, messageRoot)) {
          return candidate;
        }
      }
    }

    // Fallback: Owncast historically applies each user's display color inline.
    // Prefer a concise, inline-colored element near the start of the message.
    const styled = Array.from(messageRoot.querySelectorAll("[style]")).filter(
      (el) => {
        const styleText = el.getAttribute("style") || "";
        return (
          /(^|;)\s*color\s*:/i.test(styleText) &&
          isPlausibleUsernameElement(el, messageRoot)
        );
      }
    );

    return styled[0] || null;
  }

  function getUsernameName(messageRoot) {
    const usernameEl = findUsernameElement(messageRoot);
    const name = normalizeSpaces(usernameEl?.textContent);
    return { usernameEl, name };
  }

  function dispatchInputEvent(el, insertedText = "") {
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: insertedText,
        })
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function setNativeFormValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function insertIntoFormControl(el, text) {
    const value = String(el.value || "");
    const start = Number.isInteger(el.selectionStart)
      ? el.selectionStart
      : value.length;
    const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start;

    const before = value.slice(0, start);
    const after = value.slice(end);
    const addSpaceBefore = before && !/\s$/.test(before) && text;
    const addSpaceAfter = !after || !/^\s/.test(after);
    const inserted = `${addSpaceBefore ? " " : ""}${text}${
      addSpaceAfter ? " " : ""
    }`;

    const nextValue = before + inserted + after;
    setNativeFormValue(el, nextValue);

    const nextCaret = before.length + inserted.length;
    try {
      el.setSelectionRange(nextCaret, nextCaret);
    } catch {
      // Some input types do not support selection ranges.
    }

    dispatchInputEvent(el, inserted);
  }

  function ensureCaretInside(el) {
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

  function insertIntoContentEditable(el, text) {
    const doc = el.ownerDocument || document;
    const selection = ensureCaretInside(el);
    const currentText = el.textContent || "";
    const addSpaceBefore = currentText && !/\s$/.test(currentText) && text;
    const inserted = `${addSpaceBefore ? " " : ""}${text} `;

    try {
      if (
        typeof doc.execCommand === "function" &&
        (!doc.queryCommandSupported || doc.queryCommandSupported("insertText"))
      ) {
        const ok = doc.execCommand("insertText", false, inserted);
        if (ok) {
          dispatchInputEvent(el, inserted);
          return;
        }
      }
    } catch {
      // Range fallback below.
    }

    try {
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();

        const node = doc.createTextNode(inserted);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);

        selection.removeAllRanges();
        selection.addRange(range);
        dispatchInputEvent(el, inserted);
        return;
      }
    } catch {
      // Last-resort fallback below.
    }

    el.textContent = currentText + inserted;
    dispatchInputEvent(el, inserted);
  }

  function insertTextAtCaret(el, text) {
    if (!el || !text) return false;

    el.focus();

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      insertIntoFormControl(el, text);
      return true;
    }

    if (el instanceof HTMLElement && el.isContentEditable) {
      insertIntoContentEditable(el, text);
      return true;
    }

    return false;
  }

  function collectUserColorsAndMarkAdmin(root = getChatRoot() || document) {
    for (const messageRoot of getMessageRoots(root)) {
      const { usernameEl, name } = getUsernameName(messageRoot);
      if (!usernameEl || !name) continue;

      const color = getComputedStyle(usernameEl).color;
      if (color) nameToColor.set(name, color);

      usernameEl.classList.toggle("oc-admin-name", isAdminName(name));
    }
  }

  function applyMessageAccentColors(root = getChatRoot() || document) {
    for (const messageRoot of getMessageRoots(root)) {
      const { usernameEl } = getUsernameName(messageRoot);
      if (!usernameEl) continue;

      const color = getComputedStyle(usernameEl).color;
      if (!color) continue;

      messageRoot.classList.add("oc-message-accent");
      messageRoot.style.setProperty("--oc-message-accent-color", color);
    }
  }

  function clearEmoteOnlyMarkers(root = getChatRoot() || document) {
    root
      .querySelectorAll?.(".oc-emote-single")
      .forEach((el) => el.classList.remove("oc-emote-single"));
    root
      .querySelectorAll?.("img.emoji.oc-emote-single-img")
      .forEach((img) => img.classList.remove("oc-emote-single-img"));
  }

  function findEmojiOnlyContainer(img, messageRoot) {
    let node = img.parentElement;
    let best = null;

    while (node && node !== messageRoot) {
      const emojis = node.querySelectorAll?.("img.emoji") || [];
      if (emojis.length === 1 && emojis[0] === img) {
        const clone = node.cloneNode(true);
        clone.querySelectorAll?.("img.emoji").forEach((emoji) => emoji.remove());

        const remainingText = (clone.textContent || "")
          .replace(/\u200B/g, "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, "")
          .trim();

        if (!remainingText) {
          best = node;
        } else if (best) {
          break;
        }
      }

      node = node.parentElement;
    }

    return best;
  }

  function markEmoteOnlyMessages(root = getChatRoot() || document) {
    if (!root?.querySelectorAll) return;

    clearEmoteOnlyMarkers(root);

    const messages = getMessageRoots(root);
    for (const messageRoot of messages) {
      const images = Array.from(messageRoot.querySelectorAll("img.emoji"));
      if (images.length !== 1) continue;

      const img = images[0];
      const container = findEmojiOnlyContainer(img, messageRoot);
      if (!container) continue;

      container.classList.add("oc-emote-single");
      img.classList.add("oc-emote-single-img");
    }
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

  function colorizeMentionsInMessage(messageRoot) {
    if (!(messageRoot instanceof Element)) return;

    const names = Array.from(nameToColor.keys());
    const rx = buildMentionRegex(names);
    if (!rx) return;

    const { usernameEl } = getUsernameName(messageRoot);

    const walker = document.createTreeWalker(
      messageRoot,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue?.includes("@")) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (usernameEl?.contains(parent)) return NodeFilter.FILTER_REJECT;
          if (parent.closest(".oc-mention")) return NodeFilter.FILTER_REJECT;
          if (parent.closest("a, button, input, textarea")) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
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

        fragment.appendChild(document.createTextNode(text.slice(last, start)));
        if (leading) {
          fragment.appendChild(document.createTextNode(leading));
        }

        const span = document.createElement("span");
        span.className = "oc-mention";
        span.style.color =
          nameToColor.get(name) || "var(--mention-fallback, #a970ff)";
        span.textContent = `@${name}`;
        fragment.appendChild(span);

        last = start + full.length;
        changed = true;
      }

      if (!changed) continue;

      fragment.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(fragment, textNode);
    }
  }

  function colorizeMentionsInAllMessages(root = getChatRoot() || document) {
    for (const messageRoot of getMessageRoots(root)) {
      colorizeMentionsInMessage(messageRoot);
    }
  }

  function processChat(root = getChatRoot()) {
    if (!root) return;
    collectUserColorsAndMarkAdmin(root);
    applyMessageAccentColors(root);
    markEmoteOnlyMessages(root);
    colorizeMentionsInAllMessages(root);
  }

  // Remove stale Cobra UI if the script is injected twice without a full reload.
  document
    .querySelectorAll(".oc-emoji-btn, .oc-emoji-panel")
    .forEach((el) => el.remove());

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
      <button class="oc-emoji-close" type="button" aria-label="Fermer">✕</button>
    </div>
    <div class="oc-emoji-panel-body">
      <div class="oc-emoji-grid"></div>
      <div class="oc-emoji-empty" hidden>Aucune emote trouvée.</div>
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
          url: String(item?.url || item?.emoji || item?.src || ""),
        }))
        .filter((item) => item.name && item.url);
    }

    if (data && Array.isArray(data.items)) {
      return normalizeEmojiApi(data.items);
    }

    if (data && typeof data === "object") {
      return Object.entries(data)
        .map(([name, value]) => {
          if (value && typeof value === "object") {
            return {
              name: String(value.name || name || ""),
              url: String(value.url || value.emoji || value.src || ""),
            };
          }
          return { name: String(name), url: String(value || "") };
        })
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
        throw new Error(`/api/emoji returned ${response.status}`);
      }

      const data = await response.json();
      emojiList = normalizeEmojiApi(data).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
      emojiLoaded = true;
    } catch (error) {
      console.error("[Cobra Owncast] failed to load /api/emoji", error);
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
      tile.setAttribute("aria-label", `Insérer :${emoji.name}:`);

      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = emoji.url;

      tile.appendChild(img);

      tile.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        const input = getChatBox();
        if (!insertTextAtCaret(input, `:${emoji.name}:`)) {
          console.warn("[Cobra Owncast] chat input not found for emoji insertion");
        }

        closePanel();
      });

      fragment.appendChild(tile);
    }

    grid.appendChild(fragment);
  }

  function openPanel() {
    if (!getChatBox()) return;

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

  function getButtonSearchText(button) {
    return [
      button.getAttribute("aria-label"),
      button.title,
      button.id,
      button.className,
      button.getAttribute("data-testid"),
      button.getAttribute("data-tooltip"),
      button.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function findNativeEmojiButton() {
    const chatField = getChatFieldRoot();
    if (!chatField) return null;

    const buttons = Array.from(chatField.querySelectorAll("button")).filter(
      (button) => button !== btn && !button.classList.contains("oc-emoji-btn")
    );

    return (
      buttons.find((button) => {
        const text = getButtonSearchText(button);
        return /(emoji|emote|smil|emotic)/i.test(text);
      }) || null
    );
  }

  function restoreNativeEmojiButton() {
    if (!hiddenNativeButton?.button) return;

    const { button, opacity, opacityPriority, pointerEvents, pointerPriority } =
      hiddenNativeButton;

    if (button.isConnected) {
      if (opacity) {
        button.style.setProperty("opacity", opacity, opacityPriority || "");
      } else {
        button.style.removeProperty("opacity");
      }

      if (pointerEvents) {
        button.style.setProperty(
          "pointer-events",
          pointerEvents,
          pointerPriority || ""
        );
      } else {
        button.style.removeProperty("pointer-events");
      }
    }

    hiddenNativeButton = null;
  }

  function hideNativeEmojiButton(button) {
    if (!button) return;
    if (hiddenNativeButton?.button === button) return;

    restoreNativeEmojiButton();

    hiddenNativeButton = {
      button,
      opacity: button.style.getPropertyValue("opacity"),
      opacityPriority: button.style.getPropertyPriority("opacity"),
      pointerEvents: button.style.getPropertyValue("pointer-events"),
      pointerPriority: button.style.getPropertyPriority("pointer-events"),
    };

    button.style.setProperty("opacity", "0", "important");
    button.style.setProperty("pointer-events", "none", "important");
  }

  const positionOverlay = throttleRaf(() => {
    const input = getChatBox();
    const chatField = getChatFieldRoot() || input;

    if (!input || !chatField || !isElementVisible(chatField)) {
      btn.style.display = "none";
      restoreNativeEmojiButton();
      if (isOpen) closePanel();
      return;
    }

    btn.style.display = "";

    const nativeBtn = findNativeEmojiButton();

    // If we already hid Owncast's native emoji button ourselves, opacity is 0.
    // Do not interpret that as "button disappeared", otherwise each reconcile
    // restores it and hides it again, producing a rapid flicker.
    const nativeBtnUsable =
      nativeBtn?.parentElement &&
      (hiddenNativeButton?.button === nativeBtn || isElementVisible(nativeBtn));

    if (!nativeBtnUsable) {
      restoreNativeEmojiButton();

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

    const left = nativeRect.left - parentRect.left + parent.scrollLeft;
    const top = nativeRect.top - parentRect.top + parent.scrollTop;

    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
    btn.style.right = "";
    btn.style.bottom = "";
    btn.style.width = `${nativeRect.width || FALLBACK_BUTTON_SIZE}px`;
    btn.style.height = `${nativeRect.height || FALLBACK_BUTTON_SIZE}px`;

    hideNativeEmojiButton(nativeBtn);
  });

  function positionPanel() {
    if (!isOpen) return;

    const buttonRect = btn.getBoundingClientRect();
    const viewportWidth =
      document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight =
      window.visualViewport?.height ||
      document.documentElement.clientHeight ||
      window.innerHeight;

    const panelRect = panel.getBoundingClientRect();
    const panelWidth =
      panelRect.width || Math.min(360, viewportWidth - PANEL_MARGIN * 2);
    const panelHeight =
      panelRect.height || Math.min(420, viewportHeight - PANEL_MARGIN * 2);

    let left = buttonRect.right - panelWidth;
    left = clamp(
      left,
      PANEL_MARGIN,
      viewportWidth - panelWidth - PANEL_MARGIN
    );

    const roomAbove = buttonRect.top - PANEL_GAP - PANEL_MARGIN;
    const roomBelow =
      viewportHeight - buttonRect.bottom - PANEL_GAP - PANEL_MARGIN;

    let top;
    if (roomAbove >= panelHeight || roomAbove >= roomBelow) {
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

  function markRealChatScroller() {
    const chatRoot = getChatRoot();
    if (!chatRoot) return;

    chatRoot
      .querySelectorAll(".oc-chat-scroller")
      .forEach((el) => el.classList.remove("oc-chat-scroller"));

    const virtuoso = chatRoot.querySelector('[data-virtuoso-scroller="true"]');
    if (virtuoso) {
      virtuoso.classList.add("oc-chat-scroller");
      return;
    }

    const candidates = Array.from(chatRoot.querySelectorAll("*"));
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      if (el.clientHeight <= 0) continue;

      const scrollRange = el.scrollHeight - el.clientHeight;
      const score = scrollRange + el.clientHeight;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }

    best?.classList.add("oc-chat-scroller");
  }

  const reconcile = throttleRaf(() => {
    const chatRoot = getChatRoot();
    if (chatRoot) processChat(chatRoot);
    markRealChatScroller();
    positionOverlay();
    if (isOpen) positionPanel();
  });

  document.body.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Username click -> insert @mention.
    const messageRoot = target.closest(SELECTOR_MESSAGE_ROOT);
    if (messageRoot) {
      const { usernameEl, name } = getUsernameName(messageRoot);
      if (usernameEl && name && usernameEl.contains(target)) {
        const color = getComputedStyle(usernameEl).color;
        if (color) nameToColor.set(name, color);
        insertTextAtCaret(getChatBox(), `@${name}`);
        return;
      }
    }

    // Close the custom emoji panel when clicking elsewhere.
    if (isOpen && !panel.contains(target) && !btn.contains(target)) {
      closePanel();
    }

    // Chat panels can be mounted/unmounted after a UI click on mobile.
    setTimeout(reconcile, 0);
  });

  window.addEventListener("resize", reconcile, { passive: true });
  window.addEventListener("orientationchange", reconcile);
  window.visualViewport?.addEventListener("resize", reconcile, {
    passive: true,
  });
  window.visualViewport?.addEventListener("scroll", reconcile, {
    passive: true,
  });

  const pageObserver = new MutationObserver((mutations) => {
    let relevant = false;

    for (const mutation of mutations) {
      const target = mutation.target;
      if (
        target instanceof Element &&
        (target.matches(SELECTOR_CHAT_ROOT) || target.closest(SELECTOR_CHAT_ROOT))
      ) {
        relevant = true;
        break;
      }

      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (
          node.matches?.(SELECTOR_CHAT_ROOT) ||
          node.matches?.(SELECTOR_MESSAGE_ROOT) ||
          node.querySelector?.(SELECTOR_CHAT_ROOT) ||
          node.querySelector?.(SELECTOR_MESSAGE_ROOT)
        ) {
          relevant = true;
          break;
        }
      }

      if (relevant) break;
    }

    if (relevant) reconcile();
  });

  pageObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  function bootstrap() {
    reconcile();
  }

  loadEmojis().then(renderGrid);
  bootstrap();

  // Owncast mounts/replaces parts of the viewer UI asynchronously.
  setTimeout(bootstrap, 300);
  setTimeout(bootstrap, 900);
  setTimeout(bootstrap, 1600);

  console.info("[Cobra Owncast] Custom JS V2.8.1 loaded");
}

if (document.readyState === "loading") {
  window.addEventListener("load", initOwncastCustom, { once: true });
} else {
  initOwncastCustom();
}
