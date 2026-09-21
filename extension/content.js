// Панель и всплывающая подсказка. Живут в Shadow DOM, чтобы стили сайта не ломали их.

if (!window.__thelperLoaded) {
  window.__thelperLoaded = true;

  let host = null;
  let root = null;
  let panel = null;
  let panelBody = null;
  let panelDot = null;
  let toast = null;
  let toastTimer = null;

  let raw = "";
  let streaming = false;
  let display = "panel"; // panel | toast | minimal
  let corner = "br";
  let lastQuestion = null;
  let lastResult = null;

  const CSS = `
    :host { all: initial; }
    .panel {
      position: fixed; top: 80px; right: 24px; width: 380px; max-height: 70vh;
      display: flex; flex-direction: column; z-index: 2147483647;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e7e9ee; background: #14161c; border: 1px solid #2a2e39;
      border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.45); overflow: hidden;
    }
    .panel[hidden], .toast[hidden] { display: none; }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #1b1e27; border-bottom: 1px solid #2a2e39; cursor: grab; user-select: none;
    }
    .head.dragging { cursor: grabbing; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; flex: none; }
    .dot.busy { background: #f59e0b; animation: pulse 1s infinite; }
    .dot.err { background: #ef4444; }
    .dot.ok { background: #22c55e; }
    @keyframes pulse { 50% { opacity: .3; } }
    .title { font-weight: 600; font-size: 13px; flex: 1; letter-spacing: .2px; }
    .iconbtn { all: unset; cursor: pointer; padding: 3px 7px; border-radius: 7px; color: #9aa2b1; font-size: 15px; line-height: 1; }
    .iconbtn:hover { background: #272b36; color: #e7e9ee; }
    .body { padding: 12px; overflow: auto; flex: 1; }
    .bar { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #2a2e39; background: #1b1e27; }
    .btn { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 7px 8px; border-radius: 9px; background: #2a3040; color: #dfe3ea; font-size: 12.5px; font-weight: 500; }
    .btn:hover { background: #343c50; }
    .btn.primary { background: #2563eb; color: #fff; }
    .btn.primary:hover { background: #1d4ed8; }
    .status { color: #9aa2b1; font-size: 12.5px; }
    .answer { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; padding: 10px 12px;
      background: #16261b; border: 1px solid #1f5132; border-radius: 10px; }
    .answer .lbl { font-size: 11px; color: #8fb99f; text-transform: uppercase; letter-spacing: .6px; }
    .answer .val { font-size: 20px; font-weight: 700; color: #4ade80; }
    .opttext { margin: -4px 0 10px; color: #c7cdd8; font-size: 13px; }
    .conf { display: inline-block; margin-bottom: 10px; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; }
    .conf.high { background: #14361f; color: #6ee7a0; }
    .conf.mid { background: #3a2f12; color: #fbbf24; }
    .conf.low { background: #3a1a1a; color: #f87171; }
    .expl { color: #ccd2dd; white-space: pre-wrap; }
    .q { margin-bottom: 10px; padding: 8px 10px; background: #1a1d26; border-radius: 9px;
      color: #9aa2b1; font-size: 12.5px; max-height: 86px; overflow: auto; white-space: pre-wrap; }
    .err { color: #fca5a5; white-space: pre-wrap; }
    .meta { margin-top: 10px; color: #6b7280; font-size: 11px; }
    .raw { white-space: pre-wrap; color: #ccd2dd; }

    .toast {
      position: fixed; z-index: 2147483647; max-width: 340px;
      display: flex; align-items: center; gap: 11px; padding: 11px 15px;
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e7e9ee; background: rgba(20,22,28,.96); border: 1px solid #2a2e39;
      border-radius: 12px; box-shadow: 0 14px 38px rgba(0,0,0,.5);
      opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease;
      pointer-events: auto;
    }
    .toast.in { opacity: 1; transform: translateY(0); }
    .toast .big { font-size: 22px; font-weight: 700; color: #4ade80; line-height: 1; flex: none; }
    .toast .txt { font-size: 13px; color: #c7cdd8; overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
    .toast.bad .big { color: #f87171; font-size: 16px; }
    .toast .spin { width: 13px; height: 13px; border: 2px solid #3b4252; border-top-color: #3b82f6;
      border-radius: 50%; animation: spin .7s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .toast.br { right: 22px; bottom: 22px; }
    .toast.bl { left: 22px;  bottom: 22px; }
    .toast.tr { right: 22px; top: 22px; }
    .toast.tl { left: 22px;  top: 22px; }

    /* компактный вид: буква варианта или сам ответ */
    .toast.mini {
      padding: 4px 10px; gap: 6px; max-width: 280px; cursor: pointer;
      background: rgba(20,22,28,.78); border-color: rgba(60,66,80,.55);
      box-shadow: 0 6px 18px rgba(0,0,0,.35);
    }
    .toast.mini .big {
      font-size: 15px; font-weight: 600; color: #7ee2a8; max-width: 100%;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* вписанный ответ бывает длиннее буквы — уменьшаем, чтобы не разрасталось */
    .toast.mini .big.long { font-size: 13px; letter-spacing: .1px; }
    .toast.mini .big.xlong { font-size: 12px; font-weight: 500; }
    .toast.mini .txt { font-size: 12px; color: #98a1b0; }
    .toast.mini .spin { width: 10px; height: 10px; border-width: 2px; }
    .toast.mini.copied { border-color: #2f7d4f; background: rgba(22,38,27,.92); }
  `;

  /* ---------------------------------------------------------------- */

  function build() {
    host = document.createElement("div");
    host.id = "__thelper_root";
    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;

    panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="head">
        <span class="dot"></span>
        <span class="title">Test Helper</span>
        <button class="iconbtn" data-act="settings" title="Настройки">⚙</button>
        <button class="iconbtn" data-act="close" title="Закрыть (Esc)">✕</button>
      </div>
      <div class="body"><div class="status">Alt+Q — разобрать вопрос · Alt+A — решить и выбрать · Alt+S — по скриншоту</div></div>
      <div class="bar">
        <button class="btn primary" data-act="page">Разобрать</button>
        <button class="btn" data-act="auto">Выбрать</button>
        <button class="btn" data-act="shot">Скриншот</button>
        <button class="btn" data-act="copy">Копировать</button>
      </div>
    `;

    toast = document.createElement("div");
    toast.className = "toast";
    toast.hidden = true;

    root.append(style, panel, toast);
    attachHost();

    // Когда страница разворачивает свой блок на весь экран, всё за пределами
    // этого блока не рисуется. Переносим панель внутрь него и обратно.
    for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
      document.addEventListener(ev, attachHost, true);
    }

    panelBody = panel.querySelector(".body");
    panelDot = panel.querySelector(".dot");

    panel.addEventListener("click", (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === "close") panel.hidden = true;
      else if (act === "settings") chrome.runtime.sendMessage({ type: "open-options" });
      else if (act === "page") chrome.runtime.sendMessage({ type: "rerun", mode: "page" });
      else if (act === "auto") chrome.runtime.sendMessage({ type: "rerun", mode: "page", select: true });
      else if (act === "shot") chrome.runtime.sendMessage({ type: "rerun", mode: "screenshot" });
      else if (act === "copy") copyAnswer(e.target);
    });

    // наведение мышью не даёт подсказке исчезнуть
    toast.addEventListener("mouseenter", () => clearTimeout(toastTimer));
    toast.addEventListener("mouseleave", () => scheduleHide(1.5));

    // клик копирует ответ — пригодится там, где его надо вписывать
    toast.addEventListener("click", async () => {
      const value = (lastResult?.answer || "").trim();
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        toast.classList.add("copied");
        clearTimeout(toastTimer);
        setTimeout(() => toast.classList.remove("copied"), 600);
        scheduleHide(2);
      } catch {}
    });

    makeDraggable();
    restorePosition();

    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          if (!panel.hidden) panel.hidden = true;
          hideToast();
        }
      },
      true,
    );
  }

  function fullscreenRoot() {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    // Внутрь <iframe> вложить ничего нельзя: браузер такие узлы не рисует.
    // Тогда честнее остаться на месте, чем молча исчезнуть.
    if (!fs || fs.tagName === "IFRAME" || fs.tagName === "FRAME") {
      return document.documentElement;
    }
    return fs;
  }

  function attachHost() {
    if (!host) return;
    const target = fullscreenRoot();
    if (host.parentElement !== target) target.appendChild(host);
  }

  const ensure = () => {
    if (!host) build();
    else attachHost(); // вдруг полный экран включили до показа
  };

  function makeDraggable() {
    const handle = panel.querySelector(".head");
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;

    handle.addEventListener("mousedown", (e) => {
      if (e.target.dataset?.act) return;
      const r = panel.getBoundingClientRect();
      [dragging, sx, sy, ox, oy] = [true, e.clientX, e.clientY, r.left, r.top];
      handle.classList.add("dragging");
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = `${Math.max(4, Math.min(innerWidth - 120, ox + e.clientX - sx))}px`;
      panel.style.top = `${Math.max(4, Math.min(innerHeight - 60, oy + e.clientY - sy))}px`;
      panel.style.right = "auto";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      try {
        chrome.storage.local.set({ panelPos: { left: panel.style.left, top: panel.style.top } });
      } catch {}
    });
  }

  function restorePosition() {
    try {
      chrome.storage.local.get({ panelPos: null }, (r) => {
        if (r.panelPos?.left) {
          panel.style.left = r.panelPos.left;
          panel.style.top = r.panelPos.top;
          panel.style.right = "auto";
        }
      });
    } catch {}
  }

  const setDot = (state) => {
    if (panelDot) panelDot.className = `dot ${state}`;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /* ---------------------------- подсказка --------------------------- */

  function showToast(html, { bad = false, mini = display === "minimal" } = {}) {
    ensure();
    clearTimeout(toastTimer);
    toast.className = `toast ${corner}${mini ? " mini" : ""}${bad ? " bad" : ""}`;
    toast.innerHTML = html;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("in"));
  }

  function hideToast() {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.classList.remove("in");
    setTimeout(() => {
      if (toast && !toast.classList.contains("in")) toast.hidden = true;
    }, 220);
  }

  function scheduleHide(seconds) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, Math.max(0.5, seconds) * 1000);
  }

  /* ----------------------------- панель ----------------------------- */

  function parse(text) {
    const grab = (label, stop) => {
      const m = text.match(
        new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stop})\\s*:|$)`, "i"),
      );
      return m ? m[1].trim() : "";
    };
    return {
      answer: grab("ОТВЕТ", "ТЕКСТ|УВЕРЕННОСТЬ|РАЗБОР"),
      option: grab("ТЕКСТ", "УВЕРЕННОСТЬ|РАЗБОР"),
      confidence: grab("УВЕРЕННОСТЬ", "РАЗБОР"),
      explanation: grab("РАЗБОР", "\\u0000"),
    };
  }

  function confClass(c) {
    const s = String(c).toLowerCase();
    if (s.startsWith("выс")) return "high";
    if (s.startsWith("низ")) return "low";
    return "mid";
  }

  function renderPanel(fields) {
    ensure();
    const p = fields || parse(raw);
    const parts = [];

    if (lastQuestion) {
      const opts = lastQuestion.options?.length
        ? "\n" + lastQuestion.options.map((o) => `${o.letter}) ${o.text}`).join("\n")
        : "";
      parts.push(`<div class="q">${esc(lastQuestion.question + opts)}</div>`);
    }

    if (p.answer) {
      parts.push(`<div class="answer"><span class="lbl">Ответ</span><span class="val">${esc(p.answer)}</span></div>`);
      if (p.option && !["-", "—"].includes(p.option)) parts.push(`<div class="opttext">${esc(p.option)}</div>`);
      if (p.confidence) parts.push(`<span class="conf ${confClass(p.confidence)}">уверенность: ${esc(p.confidence)}</span>`);
      if (p.explanation) parts.push(`<div class="expl">${esc(p.explanation)}</div>`);
      else if (streaming) parts.push(`<div class="status">пишу разбор…</div>`);
    } else if (raw.trim()) {
      parts.push(`<div class="raw">${esc(raw)}</div>`);
    } else if (streaming) {
      parts.push(`<div class="status">Думаю над ответом…</div>`);
    }

    panelBody.innerHTML = parts.join("");
  }

  async function copyAnswer(btn) {
    try {
      await navigator.clipboard.writeText((lastResult?.raw || raw).trim());
      const old = btn.textContent;
      btn.textContent = "Готово";
      setTimeout(() => (btn.textContent = old), 1200);
    } catch {}
  }

  /* ---------------------------- сообщения --------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") {
      sendResponse({ ok: true });
      return true;
    }

    ensure();
    const quiet = Boolean(msg.quiet);

    switch (msg.type) {
      case "begin":
        display = msg.display || "panel";
        corner = msg.corner || "br";
        raw = "";
        lastResult = null;
        hideToast();
        if (!quiet) panel.hidden = false;
        break;

      case "toggle-panel":
        panel.hidden = !panel.hidden;
        if (!panel.hidden) renderPanel(lastResult);
        break;

      case "set-panel-visible":
        // прячем свой интерфейс, чтобы он не попал в скриншот
        if (!msg.visible) {
          panel.dataset.wasVisible = panel.hidden ? "0" : "1";
          panel.hidden = true;
          toast.hidden = true;
        } else {
          if (panel.dataset.wasVisible === "1") panel.hidden = false;
          if (toast.classList.contains("in")) toast.hidden = false;
        }
        break;

      case "status":
        setDot("busy");
        if (display === "minimal") showToast(`<div class="spin"></div>`);
        else if (quiet) showToast(`<div class="spin"></div><div class="txt">${esc(msg.text)}</div>`);
        else panelBody.innerHTML = `<div class="status">${esc(msg.text)}</div>`;
        break;

      case "question":
        lastQuestion = { question: msg.question, options: msg.options };
        break;

      case "start":
        raw = "";
        streaming = true;
        setDot("busy");
        if (!quiet) renderPanel();
        break;

      case "delta":
        raw += msg.text;
        renderPanel();
        break;

      case "stats":
        streaming = false;
        if (!quiet && msg.ms) {
          const who = msg.provider ? ` · ${esc(msg.provider)}` : "";
          panelBody.insertAdjacentHTML(
            "beforeend",
            `<div class="meta">${(msg.ms / 1000).toFixed(1)} с · ${msg.usage?.output_tokens ?? 0} токенов${who}</div>`,
          );
        }
        if (msg.stop_reason === "refusal") {
          setDot("err");
          if (quiet) showToast(`<div class="big">!</div><div class="txt">Отказ</div>`, { bad: true, mini: false });
          else panelBody.insertAdjacentHTML("beforeend", `<div class="err">Модель отказалась отвечать.</div>`);
        }
        break;

      case "result": {
        streaming = false;
        lastResult = msg;
        raw = msg.raw || raw;
        setDot("ok");

        if (display === "minimal") {
          // буква варианта, а если вписывать — сам ответ
          const value = (msg.answer || "?").trim();
          const mark = msg.selected ? " ✓" : "";
          const size = value.length > 14 ? " xlong" : value.length > 5 ? " long" : "";
          showToast(
            `<div class="big${size}" title="${esc(value)}">${esc(value)}${mark}</div>`,
          );
          scheduleHide(msg.seconds ?? 3);
        } else if (quiet) {
          const mark = msg.selected ? " ✓" : "";
          const text = msg.option && !["-", "—"].includes(msg.option) ? msg.option : msg.explanation || "";
          showToast(
            `<div class="big">${esc(msg.answer || "?")}${mark}</div><div class="txt">${esc(text)}</div>`,
          );
          scheduleHide(msg.seconds ?? 3);
        } else {
          renderPanel(msg);
          if (msg.selected) {
            panelBody.insertAdjacentHTML("beforeend", `<div class="meta">вариант выбран на странице</div>`);
          }
        }
        break;
      }

      case "error":
        streaming = false;
        setDot("err");
        if (quiet) {
          showToast(`<div class="big">!</div><div class="txt">${esc(msg.message)}</div>`, { bad: true, mini: false });
          scheduleHide(5);
        } else {
          panel.hidden = false;
          panelBody.innerHTML = `<div class="err">${esc(msg.message)}</div>`;
        }
        break;
    }
    return false;
  });
}
