// Service worker: собирает вопрос со страницы, ходит на локальный сервер,
// стримит ответ обратно в панель.

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  effort: "medium",
  lang: "ru",
  highlight: false,
  sendContext: true,
  displayMode: "minimal", // panel | toast | minimal
  corner: "br", // угол экрана: br, bl, tr, tl
  toastSeconds: 3,
  autoSelect: false, // для Alt+Q; Alt+A выбирает всегда
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/* ------------------------------------------------------------------ */
/* Код, который исполняется внутри страницы (в каждом фрейме)          */
/* ------------------------------------------------------------------ */

function extractInPage() {
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clean = (s) =>
    String(s || "")
      .replace(/ /g, " ")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 3000);

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.closest("#__thelper_root")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < -50 || r.top > vh + 50) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };

  const labelFor = (input) => {
    const fromLabels = input.labels && input.labels[0];
    const cands = [
      fromLabels,
      input.closest("label"),
      input.getAttribute("aria-label") ? null : input.parentElement,
    ];
    for (const c of cands) {
      if (!c) continue;
      const t = clean(c.innerText || c.textContent);
      if (t) return { text: t, el: c };
    }
    const aria = input.getAttribute("aria-label");
    if (aria) return { text: clean(aria), el: input };
    const val = input.getAttribute("value");
    return { text: clean(val || ""), el: input };
  };

  const ancestorOf = (els) => {
    let node = els[0];
    while (node && !els.every((e) => node.contains(e))) node = node.parentElement;
    return node || document.body;
  };

  // Точка внимания: последняя позиция курсора, иначе центр экрана.
  const pointer = window.__thelperPointer;
  const ref =
    pointer && Date.now() - pointer.t < 120000 && pointer.y >= 0 && pointer.y <= vh
      ? pointer
      : { x: vw / 2, y: vh / 2 };

  const norm = Math.max(vw, vh);
  const distFromFocus = (els) => {
    let min = Infinity;
    for (const e of els) {
      const r = e.getBoundingClientRect();
      const dx = Math.max(r.left - ref.x, 0, ref.x - r.right);
      const dy = Math.max(r.top - ref.y, 0, ref.y - r.bottom);
      min = Math.min(min, Math.hypot(dx, dy));
    }
    return min / norm;
  };

  // Собираем кандидатов всеми способами сразу и потом сравниваем по очкам:
  // главный сигнал — насколько группа близка к центру экрана.
  const candidates = [];
  const seen = [];

  const addCandidate = (kind, opts) => {
    if (opts.length < 2 || opts.length > 12) return;
    const els = opts.map((o) => o.el);
    // не добавляем группу, если её элементы уже вошли в другую
    if (seen.some((prev) => els.some((e) => prev.includes(e)))) return;
    const totalLen = opts.reduce((a, o) => a + o.text.length, 0);
    if (totalLen < 2 || totalLen > 2500) return;
    seen.push(els);
    candidates.push({ kind, opts, els });
  };

  // --- способ 1: настоящие radio/checkbox ----------------------------
  const groups = new Map();
  for (const input of document.querySelectorAll(
    'input[type="radio"], input[type="checkbox"]',
  )) {
    if (!visible(input)) continue;
    const key = input.name || `__anon_${ancestorOf([input]).tagName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  }
  for (const [, inputs] of groups) {
    const opts = inputs
      .map((i) => {
        const l = labelFor(i);
        return { text: l.text, el: l.el, input: i };
      })
      .filter((o) => o.text);
    addCandidate("input", opts);
  }

  // --- способ 2: элементы с говорящими ролями и классами --------------
  const tagged = [...document.querySelectorAll(
    '[role="radio"], [role="option"], [class*="option" i], [class*="answer" i], [class*="variant" i], [class*="choice" i], [class*="otvet" i]',
  )].filter(visible);

  const byParent = new Map();
  for (const n of tagged) {
    const p = n.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(n);
  }
  for (const [, sibs] of byParent) {
    const opts = sibs
      .map((el) => ({ text: clean(el.innerText || el.textContent), el, input: null }))
      .filter((o) => o.text && o.text.length < 600);
    addCandidate("tagged", opts);
  }

  // --- способ 3: одинаковые соседние блоки (классы могут быть любыми) --
  const signature = (el) => `${el.tagName}.${el.className || ""}`;
  for (const parent of document.querySelectorAll("ul, ol, form, div, section, fieldset")) {
    const kids = [...parent.children].filter(visible);
    if (kids.length < 2 || kids.length > 12) continue;

    const bySig = new Map();
    for (const k of kids) {
      const sig = signature(k);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(k);
    }
    for (const [, sibs] of bySig) {
      const opts = sibs
        .map((el) => ({ text: clean(el.innerText || el.textContent), el, input: null }))
        .filter((o) => o.text && o.text.length < 300);
      if (opts.length !== sibs.length) continue; // часть блоков пустые — это не варианты
      addCandidate("siblings", opts);
    }
  }

  // Главная проверка: лежат ли варианты в том же блоке страницы, где курсор.
  // Это надёжнее расстояния, когда вопросы идут подряд.
  const hit = document.elementFromPoint(
    Math.min(vw - 1, Math.max(0, ref.x)),
    Math.min(vh - 1, Math.max(0, ref.y)),
  );

  const sharesBlockWithPointer = (el) => {
    if (!hit) return false;
    let node = hit;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.contains(el)) return true;
      node = node.parentElement;
    }
    return false;
  };

  const KIND_BONUS = { input: 14, tagged: 9, siblings: 3 };
  let best = null;
  for (const c of candidates) {
    const near = sharesBlockWithPointer(c.els[0]);
    const score =
      KIND_BONUS[c.kind] +
      c.opts.length * 3 -
      distFromFocus(c.els) * 110 +
      (near ? 30 : -40);
    if (!best || score > best.score) best = { ...c, score };
  }
  // Ничего подходящего рядом — значит вопрос со свободным ответом.
  if (best && best.score <= 0) best = null;

  // --- текст вопроса ---------------------------------------------------
  const textExcluding = (root, skip) => {
    skip.forEach((e) => e.setAttribute("data-thelper-skip", "1"));
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll('[data-thelper-skip], script, style, noscript, svg')
      .forEach((n) => n.remove());
    skip.forEach((e) => e.removeAttribute("data-thelper-skip"));
    return clean(clone.innerText || clone.textContent);
  };

  const selection = window.getSelection();
  const selected =
    selection && !selection.isCollapsed ? clean(selection.toString()) : "";

  let question = "";
  let options = [];

  if (best) {
    options = best.opts.map((o, i) => ({ letter: LETTERS[i] || String(i + 1), text: o.text }));
    window.__thelperOptionEls = best.opts.map((o) => o.input || o.el);

    let node = ancestorOf(best.els);
    for (let i = 0; i < 7 && node && node !== document.documentElement; i++) {
      const t = textExcluding(node, best.els);
      if (t.length >= 12) {
        question = t;
        break;
      }
      node = node.parentElement;
    }
  } else {
    window.__thelperOptionEls = [];
  }

  if (selected && (!question || selected.length > question.length)) {
    question = selected;
  }

  // Вопрос без вариантов: берём ближайший к курсору компактный блок текста.
  if (!question) {
    const blocks = [];
    for (const el of document.querySelectorAll(
      'h1,h2,h3,h4,h5,h6,p,li,td,label,div,span,article,section,legend',
    )) {
      if (!visible(el)) continue;
      const text = clean(el.innerText || el.textContent);
      if (text.length < 20 || text.length > 1500) continue;
      blocks.push({ el, text, d: distFromFocus([el]) });
    }
    // сначала близость (с допуском), при равной близости — самый короткий блок
    blocks.sort((a, b) => {
      const da = Math.round(a.d * 50);
      const db = Math.round(b.d * 50);
      return da !== db ? da - db : a.text.length - b.text.length;
    });
    question = blocks.length ? blocks[0].text : "";
  }

  const context = clean(document.body ? document.body.innerText : "").slice(0, 2500);

  const score =
    (question ? 25 : 0) +
    options.length * 8 +
    (selected ? 35 : 0) +
    (best ? 10 - distFromFocus(best.els) * 10 : 0);

  return {
    question,
    options,
    context,
    hasSelection: Boolean(selected),
    url: location.href,
    score: question ? score : 0,
  };
}

function selectInPage(letters) {
  const els = window.__thelperOptionEls || [];
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let done = 0;

  for (const letter of letters) {
    const idx = LETTERS.indexOf(String(letter).toUpperCase().trim());
    const el = els[idx];
    if (!el) continue;

    try {
      el.scrollIntoView({ block: "nearest" });
      if (el.tagName === "INPUT") {
        if (!el.checked) {
          el.click();
          // некоторые фреймворки не реагируют на .click() — дожимаем вручную
          if (!el.checked) {
            el.checked = true;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      } else {
        for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup"]) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        el.click();
      }
      done += 1;
    } catch {
      /* элемент мог исчезнуть */
    }
  }
  return done;
}

function highlightInPage(letters, clearOnly) {
  const els = window.__thelperOptionEls || [];
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  for (const el of els) {
    const target = el.tagName === "INPUT" ? el.closest("label") || el.parentElement : el;
    if (!target) continue;
    if (target.dataset.thelperPrevOutline !== undefined) {
      target.style.outline = target.dataset.thelperPrevOutline;
      target.style.backgroundColor = target.dataset.thelperPrevBg || "";
      delete target.dataset.thelperPrevOutline;
      delete target.dataset.thelperPrevBg;
    }
  }
  if (clearOnly) return true;

  let hit = false;
  for (const letter of letters) {
    const idx = LETTERS.indexOf(String(letter).toUpperCase().trim());
    const el = els[idx];
    if (!el) continue;
    const target = el.tagName === "INPUT" ? el.closest("label") || el.parentElement : el;
    if (!target) continue;
    target.dataset.thelperPrevOutline = target.style.outline || "";
    target.dataset.thelperPrevBg = target.style.backgroundColor || "";
    target.style.outline = "3px solid #22c55e";
    target.style.backgroundColor = "rgba(34,197,94,0.12)";
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    hit = true;
  }
  return hit;
}

/* ------------------------------------------------------------------ */
/* Сбор вопроса по всем фреймам                                        */
/* ------------------------------------------------------------------ */

async function collectQuestion(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: extractInPage,
    });
  } catch {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractInPage,
    });
  }

  const best = results
    .filter((r) => r && r.result && r.result.score > 0)
    .sort((a, b) => b.result.score - a.result.score)[0];

  if (!best) return null;
  return { ...best.result, frameId: best.frameId };
}

async function runInFrame(tabId, frameId, func, args) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId ?? 0] },
      func,
      args,
    });
    return res?.result;
  } catch {
    return null; // фрейм мог исчезнуть — не страшно
  }
}

const applyHighlight = (tabId, frameId, letters, clearOnly = false) =>
  runInFrame(tabId, frameId, highlightInPage, [letters, clearOnly]);

const applySelect = (tabId, frameId, letters) =>
  runInFrame(tabId, frameId, selectInPage, [letters]);

/* Разбор ответа модели */

const FIELD_RE = (label, stop) =>
  new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stop})\\s*:|$)`, "i");

function parseAnswer(text) {
  const grab = (label, stop) => {
    const m = text.match(FIELD_RE(label, stop));
    return m ? m[1].trim() : "";
  };
  return {
    answer: grab("ОТВЕТ", "ТЕКСТ|УВЕРЕННОСТЬ|РАЗБОР"),
    option: grab("ТЕКСТ", "УВЕРЕННОСТЬ|РАЗБОР"),
    confidence: grab("УВЕРЕННОСТЬ", "РАЗБОР"),
    explanation: grab("РАЗБОР", "\\u0000"),
  };
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function lettersOf(answer) {
  return answer
    .split(/[,;/]|\s+и\s+/)
    .map((s) => s.trim().replace(/[).\]]+$/, ""))
    .filter((s) => s.length === 1 && LETTERS.includes(s.toUpperCase()))
    .map((s) => s.toUpperCase());
}

/* ------------------------------------------------------------------ */
/* Общение с панелью                                                   */
/* ------------------------------------------------------------------ */

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return true;
    } catch {
      return false;
    }
  }
}

async function send(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    /* панель закрыта */
  }
}

async function captureScreenshot(tabId, windowId) {
  await send(tabId, { type: "set-panel-visible", visible: false });
  await new Promise((r) => setTimeout(r, 120));
  try {
    return await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 85,
    });
  } finally {
    await send(tabId, { type: "set-panel-visible", visible: true });
  }
}

async function callServer(payload, settings, onEvent) {
  const headers = { "content-type": "application/json" };
  if (settings.token) headers["x-thelper-token"] = settings.token;

  const res = await fetch(`${settings.serverUrl.replace(/\/$/, "")}/solve`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Сервер ответил ${res.status}. ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const evLine = raw.match(/^event: (.+)$/m);
      const dataLine = raw.match(/^data: (.+)$/m);
      if (!evLine || !dataLine) continue;
      onEvent(evLine[1], JSON.parse(dataLine[1]));
    }
  }
}

async function run(tabId, windowId, opts) {
  const settings = await getSettings();
  const source = opts.source; // "page" | "screenshot"
  const select = opts.select ?? settings.autoSelect;
  const quiet = opts.quiet ?? settings.displayMode !== "panel";
  const display = opts.quiet === true && settings.displayMode === "panel"
    ? "toast"
    : settings.displayMode;

  if (!(await ensureContentScript(tabId))) return;

  await send(tabId, { type: "begin", quiet, display, corner: settings.corner });
  await send(tabId, {
    type: "status",
    quiet,
    text: source === "screenshot" ? "Скриншот…" : "Ищу вопрос…",
  });

  let payload;
  let frameId = 0;

  try {
    if (source === "screenshot") {
      payload = { mode: "image", image: await captureScreenshot(tabId, windowId) };
    } else {
      const found = await collectQuestion(tabId);
      if (!found?.question) {
        await send(tabId, {
          type: "error",
          quiet,
          message: "Не нашёл вопрос. Выдели его мышкой или сними скриншот (Alt+S).",
        });
        return;
      }
      frameId = found.frameId ?? 0;
      payload = {
        mode: "text",
        question: found.question,
        options: found.options,
        context: settings.sendContext && !found.hasSelection ? found.context : "",
      };
      await send(tabId, {
        type: "question",
        quiet,
        question: found.question,
        options: found.options,
      });
    }
  } catch (err) {
    await send(tabId, { type: "error", quiet, message: String(err.message || err) });
    return;
  }

  payload.effort = settings.effort;
  payload.lang = settings.lang;
  payload.brief = display === "minimal";

  await send(tabId, { type: "start", quiet });
  await applyHighlight(tabId, frameId, [], true);

  let raw = "";
  let failed = false;

  try {
    await callServer(payload, settings, (event, data) => {
      if (event === "delta") {
        raw += data.text;
        if (!quiet) send(tabId, { type: "delta", text: data.text });
      } else if (event === "notice") {
        if (!quiet) send(tabId, { type: "status", quiet, text: data.text });
      } else if (event === "error") {
        failed = true;
        send(tabId, { type: "error", quiet, message: data.message });
      } else if (event === "done") {
        send(tabId, { type: "stats", quiet, ...data });
      }
    });
  } catch (err) {
    const msg = String(err.message || err);
    await send(tabId, {
      type: "error",
      quiet,
      message: /Failed to fetch|NetworkError/i.test(msg)
        ? `Нет связи с ${settings.serverUrl}. Запусти сервер: npm start в папке server.`
        : msg,
    });
    return;
  }

  if (failed) return;

  const parsed = parseAnswer(raw);
  const letters = payload.mode === "text" ? lettersOf(parsed.answer) : [];
  let selected = 0;

  if (select && letters.length) {
    selected = (await applySelect(tabId, frameId, letters)) || 0;
  } else if (settings.highlight && letters.length) {
    await applyHighlight(tabId, frameId, letters);
  }

  await send(tabId, {
    type: "result",
    quiet,
    seconds: Number(settings.toastSeconds) || 3,
    selected,
    raw,
    ...parsed,
  });
}

/* ------------------------------------------------------------------ */
/* Точки входа                                                         */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) run(tab.id, tab.windowId, { source: "page" });
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  if (command === "ask-page") {
    run(tab.id, tab.windowId, { source: "page" });
  } else if (command === "ask-screenshot") {
    run(tab.id, tab.windowId, { source: "screenshot" });
  } else if (command === "auto-answer") {
    run(tab.id, tab.windowId, { source: "page", select: true, quiet: true });
  } else if (command === "toggle-panel") {
    await ensureContentScript(tab.id);
    send(tab.id, { type: "toggle-panel" });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "thelper-solve",
    title: "Решить через Test Helper",
    contexts: ["selection", "page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "thelper-solve" && tab?.id) {
    run(tab.id, tab.windowId, { source: "page" });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "rerun" && sender.tab?.id) {
    run(sender.tab.id, sender.tab.windowId, {
      source: msg.mode === "screenshot" ? "screenshot" : "page",
      select: Boolean(msg.select),
      quiet: false,
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
