// Тесты разбора ответа и потока событий.
// Запуск: node test/run.mjs (из корня проекта)

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

// вырезаем из расширения куски, не зависящие от chrome.*
const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const core =
  cut("/* Разбор ответа модели */", "/* ------------------------------------------------------------------ */\n/* Общение с панелью") +
  cut("async function callServer(", "async function run(tabId, windowId, opts)") +
  "\nexport { parseAnswer, lettersOf, callServer };\n";

const tmp = path.join(os.tmpdir(), `thelper-core-${Date.now()}.mjs`);
fs.writeFileSync(tmp, core);
const { parseAnswer, lettersOf, callServer } = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}` +
      (ok ? "" : `\n     получил ${JSON.stringify(got)}\n     ожидал  ${JSON.stringify(want)}`),
  );
};

const sample = `ОТВЕТ: B
ТЕКСТ: Астана
УВЕРЕННОСТЬ: высокая
РАЗБОР: Столица Казахстана с 1997 года — Астана.
Город дважды переименовывали.`;

const p = parseAnswer(sample);
eq("поле ОТВЕТ", p.answer, "B");
eq("поле ТЕКСТ", p.option, "Астана");
eq("поле УВЕРЕННОСТЬ", p.confidence, "высокая");
eq("многострочный РАЗБОР", p.explanation.split("\n").length, 2);

eq("одна буква", lettersOf("B"), ["B"]);
eq("несколько букв", lettersOf("A, C"), ["A", "C"]);
eq("буквы через 'и'", lettersOf("A и D"), ["A", "D"]);
eq("буква со скобкой", lettersOf("B)"), ["B"]);
eq("числовой ответ не буква", lettersOf("42"), []);
eq("неизвестный ответ", lettersOf("?"), []);

const partial = parseAnswer("ОТВЕТ: A\nТЕКСТ: 3x");
eq("обрезанный поток", [partial.answer, partial.option], ["A", "3x"]);

// параметры под разные модели
const { modelParams } = await import(
  pathToFileURL(path.join(root, "server", "model-config.js")).href
);

const opus = modelParams("claude-opus-5", "high");
eq("Opus 5: адаптивные раздумья", opus.thinking, { type: "adaptive" });
eq("Opus 5: effort передаётся", opus.output_config, { effort: "high" });

const sonnet = modelParams("claude-sonnet-5", "medium");
eq("Sonnet 5: адаптивные раздумья", sonnet.thinking, { type: "adaptive" });
eq("Sonnet 5: effort передаётся", sonnet.output_config, { effort: "medium" });

const s46 = modelParams("claude-sonnet-4-6", "xhigh");
eq("Sonnet 4.6: xhigh понижается до high", s46.output_config, { effort: "high" });

const haiku = modelParams("claude-haiku-4-5", "low");
eq("Haiku: бюджет вместо adaptive", haiku.thinking, { type: "enabled", budget_tokens: 2000 });
eq("Haiku: effort не отправляется", haiku.output_config, undefined);
eq("Haiku: max_tokens больше бюджета", haiku.max_tokens > haiku.thinking.budget_tokens, true);

eq("неизвестный effort откатывается", modelParams("claude-opus-5", "чепуха").output_config, {
  effort: "medium",
});

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const w = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  res.write('event: delta\ndata: {"text":"ОТВЕТ: ');
  setTimeout(() => res.write('B\\n"}\n\n'), 20);
  setTimeout(() => w("delta", { text: "ТЕКСТ: Астана" }), 40);
  setTimeout(() => {
    w("done", { usage: { output_tokens: 7 }, ms: 12 });
    res.end();
  }, 60);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const events = [];
await callServer(
  { mode: "text" },
  { serverUrl: `http://127.0.0.1:${srv.address().port}`, token: "" },
  (e, d) => events.push([e, d]),
);
srv.close();

eq("событий получено", events.length, 3);
eq("склейка разрезанного кадра", events[0][1].text, "ОТВЕТ: B\n");
eq("последнее событие", events[2][0], "done");

// --- вырезание тегов <think> у открытых моделей ---
const { makeThinkStripper } = await import(
  pathToFileURL(path.join(root, "server", "providers.js")).href
);

const collect = (chunks) => {
  const s = makeThinkStripper();
  return chunks.map((c) => s.push(c)).join("") + s.flush();
};

eq("текст без тегов проходит целиком", collect(["ОТВЕТ: B"]), "ОТВЕТ: B");
eq("блок мыслей вырезан", collect(["<think>рассуждаю</think>ОТВЕТ: B"]), "ОТВЕТ: B");
eq(
  "тег разрезан между кусками",
  collect(["<th", "ink>шум", "</thi", "nk>ОТВЕТ: C"]),
  "ОТВЕТ: C",
);
eq(
  "незакрытый блок мыслей не протекает",
  collect(["<think>думаю и обрываюсь"]),
  "",
);
eq("текст до тега сохраняется", collect(["хвост<think>шум</think>"]), "хвост");

// --- пауза перед повтором берётся из ответа провайдера ---
const serverSrc = fs.readFileSync(path.join(root, "server", "server.js"), "utf8");
const cutServer = (from, to) =>
  serverSrc.slice(serverSrc.indexOf(from), serverSrc.indexOf(to));

const retryCore =
  // подставляем то, что живёт вне вырезанного куска
  'const CTX = { title: "Google Gemini", provider: { keyEnv: "GEMINI_API_KEY" } };\n' +
  "const MAX_WAIT = 20000;\n" +
  cutServer("// Вытаскиваем рекомендованную паузу", "// Groq, Gemini, Cerebras") +
  "\nexport { hintedDelay, backoff, friendlyProviderError, CTX };\n";
const tmp2 = path.join(os.tmpdir(), `thelper-retry-${Date.now()}.mjs`);
fs.writeFileSync(tmp2, retryCore);
const {
  hintedDelay,
  backoff,
  friendlyProviderError,
  CTX: CTX_STUB,
} = await import(pathToFileURL(tmp2).href);
fs.unlinkSync(tmp2);

eq("пауза из поля retryDelay", hintedDelay('{"retryDelay":"13s"}'), 13);
eq("пауза из текста ошибки", hintedDelay("Please retry in 13.13637"), 13.13637);
eq("подсказки нет", hintedDelay("boom"), null);
eq("подсказка провайдера уважается", backoff(0, 13), 13500);

const retryStatus = serverSrc.match(/const RETRY_STATUS = new Set\(\[([^\]]+)\]\)/)[1];
eq("на лимит не повторяем", retryStatus.includes("429"), false);
eq("на перегрузку повторяем", retryStatus.includes("503"), true);
eq("очень долгая пауза обрезается", backoff(0, 999), 20000);
eq("без подсказки растущая пауза", backoff(0, null) >= 500, true);

// --- человеческий текст вместо сырой ошибки провайдера ---
const quota =
  'You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash Please retry in 54.8';
eq(
  "лимит объяснён словами",
  friendlyProviderError(CTX_STUB, 429, quota),
  "Лимит Google Gemini исчерпан: 20 запросов в минуту, повтори через 55 с",
);
eq(
  "неверный ключ",
  friendlyProviderError(CTX_STUB, 401, "bad key"),
  "Google Gemini не принял ключ. Проверь GEMINI_API_KEY в server/.env",
);
eq(
  "перегрузка",
  friendlyProviderError(CTX_STUB, 503, "high demand"),
  "Google Gemini сейчас перегружен, попробуй ещё раз",
);

// --- сквозная проверка пути OpenAI-совместимых провайдеров ---
const { spawn } = await import("node:child_process");

let fakeCalls = 0;
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    fakeRequest = JSON.parse(body);
    fakeCalls += 1;

    // первый запрос — перегрузка, сервер обязан повторить сам
    if (fakeCalls === 1) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      res.end('{"error":{"message":"high demand"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const d = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    d({ choices: [{ delta: { content: "<think>прики" } }] });
    d({ choices: [{ delta: { content: "дываю</think>ОТВЕТ: B\n" } }] });
    d({ choices: [{ delta: { content: "ТЕКСТ: Астана" }, finish_reason: "stop" }] });
    d({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
let fakeRequest = null;
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;

const appPort = 8791;
const child = spawn(process.execPath, [path.join(root, "server", "server.js")], {
  env: {
    ...process.env,
    PORT: String(appPort),
    THELPER_PROVIDER: "groq",
    THELPER_BASE_URL: `http://127.0.0.1:${fakePort}`,
    GROQ_API_KEY: "test-key",
  },
  stdio: "ignore",
});

const waitFor = async (url, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("сервер не поднялся");
};

const health = await (await waitFor(`http://127.0.0.1:${appPort}/health`)).json();
eq("health: провайдер", health.provider, "Groq");
eq("health: модель", health.model, "openai/gpt-oss-120b");
eq("health: ключ виден", health.key, true);

const solved = await fetch(`http://127.0.0.1:${appPort}/solve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    mode: "text",
    question: "Столица Казахстана?",
    options: [{ letter: "A", text: "Алматы" }, { letter: "B", text: "Астана" }],
    effort: "high",
  }),
});
const sse = await solved.text();

const deltas = [...sse.matchAll(/^event: delta\ndata: (.+)$/gm)].map(
  (m) => JSON.parse(m[1]).text,
);
const doneLine = sse.match(/^event: done\ndata: (.+)$/m);

eq("мысли модели не попали в ответ", deltas.join("").includes("прикидываю"), false);
eq("ответ собрался", deltas.join(""), "ОТВЕТ: B\nТЕКСТ: Астана");
eq("статистика получена", JSON.parse(doneLine[1]).usage, {
  input_tokens: 40,
  output_tokens: 12,
});
eq("уровень усилий передан провайдеру", fakeRequest.reasoning_effort, "high");
eq("варианты попали в запрос", fakeRequest.messages[1].content.includes("B) Астана"), true);
eq("перегрузка вызвала повтор", fakeCalls, 2);
eq("обычный режим просит разбор", fakeRequest.messages[0].content.includes("РАЗБОР"), true);

// короткий режим: разбор не запрашивается вовсе
await fetch(`http://127.0.0.1:${appPort}/solve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mode: "text", question: "2+2?", brief: true }),
}).then((r) => r.text());

eq("короткий режим без разбора", fakeRequest.messages[0].content.includes("РАЗБОР"), false);
eq(
  "короткий режим всё ещё просит ответ",
  fakeRequest.messages[0].content.includes("ОТВЕТ:"),
  true,
);

child.kill();
fake.close();

// --- запасной провайдер подхватывает, когда у основного кончился лимит ---
const limited = http.createServer((req, res) => {
  req.resume();
  res.writeHead(429, { "content-type": "application/json" });
  res.end(
    '{"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 42"}}',
  );
});
let backupSaw = null;
const backup = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    backupSaw = JSON.parse(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"ОТВЕТ: 7"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => limited.listen(0, "127.0.0.1", r));
await new Promise((r) => backup.listen(0, "127.0.0.1", r));

const fbPort = 8793;
const fbChild = spawn(process.execPath, [path.join(root, "server", "server.js")], {
  env: {
    ...process.env,
    PORT: String(fbPort),
    THELPER_PROVIDER: "gemini",
    THELPER_BASE_URL: `http://127.0.0.1:${limited.address().port}`,
    GEMINI_API_KEY: "primary-key",
    THELPER_FALLBACK: "groq",
    THELPER_FALLBACK_BASE_URL: `http://127.0.0.1:${backup.address().port}`,
    GROQ_API_KEY: "backup-key",
  },
  stdio: "ignore",
});

const fbHealth = await (await waitFor(`http://127.0.0.1:${fbPort}/health`)).json();
eq("запасной виден в health", fbHealth.fallback, "Groq");

const fbSse = await (
  await fetch(`http://127.0.0.1:${fbPort}/solve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "text", question: "3x - 5 = 16", brief: true }),
  })
).text();

eq("о переключении предупредили", /event: notice/.test(fbSse), true);
eq(
  "ответ пришёл от запасного",
  [...fbSse.matchAll(/^event: delta\ndata: (.+)$/gm)].map((m) => JSON.parse(m[1]).text).join(""),
  "ОТВЕТ: 7",
);
const fbDone = JSON.parse(fbSse.match(/^event: done\ndata: (.+)$/m)[1]);
eq("источник ответа назван", fbDone.provider, "Groq");
eq("отмечено как переключение", fbDone.fellBack, true);
eq("запасной получил вопрос", backupSaw.messages[1].content.includes("3x - 5 = 16"), true);

// картинку запасному без зрения не отдаём
const imgSse = await (
  await fetch(`http://127.0.0.1:${fbPort}/solve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "image",
      image: "data:image/png;base64,iVBORw0KGgo=",
    }),
  })
).text();
eq("скриншот не уходит к слепому запасному", /event: notice/.test(imgSse), false);
eq("про лимит сказано понятно", /Лимит Google Gemini исчерпан/.test(imgSse), true);

fbChild.kill();
limited.close();
backup.close();

console.log(fails ? `\n${fails} тест(ов) упало` : "\nвсе тесты прошли");
process.exit(fails ? 1 : 0);
