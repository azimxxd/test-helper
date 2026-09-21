const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8787",
  token: "",
  effort: "medium",
  lang: "ru",
  highlight: false,
  sendContext: true,
  displayMode: "minimal",
  corner: "br",
  toastSeconds: 3,
  autoSelect: false,
};

const fields = Object.keys(DEFAULTS);
const el = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS, (cfg) => {
  for (const f of fields) {
    const node = el(f);
    if (node.type === "checkbox") node.checked = cfg[f];
    else node.value = cfg[f];
  }
  checkHealth(cfg.serverUrl, cfg.token);
});

el("save").addEventListener("click", () => {
  const cfg = {};
  for (const f of fields) {
    const node = el(f);
    if (node.type === "checkbox") cfg[f] = node.checked;
    else if (node.type === "number") cfg[f] = Number(node.value) || DEFAULTS[f];
    else cfg[f] = node.value.trim();
  }
  if (!cfg.serverUrl) cfg.serverUrl = DEFAULTS.serverUrl;

  chrome.storage.sync.set(cfg, () => {
    el("saved").classList.add("on");
    setTimeout(() => el("saved").classList.remove("on"), 1500);
    checkHealth(cfg.serverUrl, cfg.token);
  });
});

async function checkHealth(url, token) {
  const box = el("health");
  box.textContent = "Проверяю сервер…";
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      headers: token ? { "x-thelper-token": token } : {},
    });
    const data = await res.json();
    box.innerHTML = `<span style="color:#4ade80">● сервер на связи</span> · модель ${data.model}${data.auth ? " · токен включён" : ""}`;
  } catch {
    box.innerHTML = `<span style="color:#f87171">● сервер не отвечает</span> — запусти <code>npm start</code> в папке server`;
  }
}
