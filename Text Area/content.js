/**
 * Google Search Auto-Focus (ChatGPT-style)
 *
 * The moment you start typing anywhere on a Google Search page — without
 * clicking into a box first — this focuses the main search / AI prompt
 * input AND carries over the first character you typed, so you never
 * lose a keystroke. If you're already typing inside a text field, this
 * does nothing and lets you type normally.
 */

(function () {
  "use strict";

  // ---- 1. INTENT PROTECTION -------------------------------------------

  function isTypingContext(el) {
    if (!el) return false;

    const tag = el.tagName ? el.tagName.toLowerCase() : "";

    if (tag === "textarea") return true;

    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const nonTextTypes = [
        "checkbox", "radio", "button", "submit", "reset",
        "file", "range", "color", "image"
      ];
      return !nonTextTypes.includes(type);
    }

    // contenteditable elements (Google's AI/SGE prompt box is often one of these)
    if (el.isContentEditable) return true;

    return false;
  }

  // ---- 2. ROBUST DOM TARGETING ------------------------------------------

  const ARIA_LABEL_HINTS = [
    "search", "ask", "prompt", "message", "query", "type a message"
  ];

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    // Element must be somewhere within (or reasonably near) the viewport
    return rect.bottom > 0 && rect.top < window.innerHeight * 2;
  }

  function isCandidateInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = el.tagName.toLowerCase();

    if (tag === "textarea") return isVisible(el);

    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (!["search", "text"].includes(type)) return false;
      return isVisible(el);
    }

    if (el.isContentEditable) return isVisible(el);

    return false;
  }

  function ariaLabelMatches(el) {
    const label = (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      ""
    ).toLowerCase();
    return ARIA_LABEL_HINTS.some((hint) => label.includes(hint));
  }

  function findPromptBox() {
    // Gather every plausible candidate: real inputs/textareas plus
    // contenteditable elements (Google's newer AI conversation UI
    // frequently uses a contenteditable div instead of a <textarea>).
    const selector = [
      "textarea",
      'input[type="search"]',
      'input[type="text"]',
      '[contenteditable="true"]',
      '[contenteditable=""]'
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selector)).filter(
      isCandidateInput
    );

    if (candidates.length === 0) return null;

    // Preference 1: something with an aria-label / placeholder / title
    // that looks like a search or prompt field.
    const labeled = candidates.filter(ariaLabelMatches);
    const pool = labeled.length > 0 ? labeled : candidates;

    // Preference 2 (and fallback): the largest visible candidate by
    // on-screen area, since the "main" prompt box is almost always the
    // biggest text input on the page.
    let best = null;
    let bestArea = -1;

    for (const el of pool) {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }

    return best;
  }

  // ---- 3. CURSOR PLACEMENT + FIRST-CHARACTER INJECTION --------------------

  // Fires a real "input" event on the element so any JS Google has
  // listening for typing (e.g. React-controlled inputs, autocomplete,
  // AI suggestions) notices the change, exactly like a real keystroke would.
  function dispatchInputEvent(el) {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (e) {
      // Fail silently — worst case, the visible text is still correct.
    }
  }

  function focusInjectAndPlaceCursor(el, char) {
    el.focus();

    // Standard text inputs / textareas
    if (typeof el.setSelectionRange === "function" && "value" in el) {
      try {
        el.value = (el.value || "") + char;
        const len = el.value.length;
        el.setSelectionRange(len, len);
        dispatchInputEvent(el);
        return;
      } catch (e) {
        // Some input types throw on setSelectionRange; fall through.
      }
    }

    // contenteditable elements
    if (el.isContentEditable) {
      try {
        // Make sure the cursor is at the end before inserting, in case
        // there was already text sitting in the box.
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        // execCommand is old but still the most reliable cross-site way
        // to insert text into a contenteditable so the page's own JS
        // (React, etc.) picks it up like a normal keystroke.
        const inserted = document.execCommand("insertText", false, char);

        if (!inserted) {
          // Fallback: manually insert a text node at the cursor.
          const textNode = document.createTextNode(char);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          sel.removeAllRanges();
          sel.addRange(range);
          dispatchInputEvent(el);
        }
      } catch (e) {
        // Fail silently — focus() alone is still an acceptable outcome.
      }
    }
  }

  // ---- 4. ERROR HANDLING / RETRY ------------------------------------------

  function findPromptBoxWithRetry(maxAttempts, delayMs, onFound) {
    let attempts = 0;

    function attempt() {
      attempts += 1;
      let box = null;

      try {
        box = findPromptBox();
      } catch (e) {
        box = null; // fail silently, we'll just retry
      }

      if (box) {
        onFound(box);
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(attempt, delayMs);
      }
      // If we exhaust attempts, fail silently — no box found this time.
    }

    attempt();
  }

  // ---- Main key listener ------------------------------------------------

  // Matches a single printable letter, number, symbol, or space —
  // basically any key that would normally type a visible character.
  // Excludes things like "Enter", "Shift", "ArrowLeft", "F5", etc.,
  // which all have key names longer than one character.
  function isPrintableCharacter(key) {
    return typeof key === "string" && key.length === 1;
  }

  document.addEventListener(
    "keydown",
    function (event) {
      // Ignore modifier combos (Ctrl+C, Cmd+V, etc.) — those aren't
      // "starting to type," they're shortcuts.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (!isPrintableCharacter(event.key)) return;

      const active = document.activeElement;

      // INTENT PROTECTION: already typing somewhere? Do nothing —
      // let the keystroke behave completely normally.
      if (isTypingContext(active)) return;

      // Otherwise: hijack this keystroke, find the prompt box, focus it,
      // and carry the character over so nothing is lost.
      event.preventDefault();
      event.stopPropagation();

      findPromptBoxWithRetry(5, 150, function (box) {
        focusInjectAndPlaceCursor(box, event.key);
      });
    },
    true // capture phase, so we see the event before most page handlers
  );
})();
