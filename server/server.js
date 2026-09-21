// Локальный прокси к Claude API.
// Держит ключ у себя, расширение ходит только сюда.

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic, {
  AnthropicError,
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { modelParams, EFFORTS } from "./model-config.js";
import { PROVIDERS, reasoningEffort, makeThinkStripper } from "./providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(here, ".env"));
} catch {
  // .env может не быть — тогда читаем переменные окружения как есть
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN = process.env.THELPER_TOKEN || "";

const PROVIDER_NAME = PROVIDERS[process.env.THELPER_PROVIDER]
  ? process.env.THELPER_PROVIDER
  : "anthropic";

// Всё, что нужно для похода к одному провайдеру, в одном объекте:
// так основного и запасного можно гонять одним и тем же кодом.
function contextFor(name, primary) {
  const provider = PROVIDERS[name];
  return {
    name,
    provider,
    title: provider.title,
    // переопределения из .env относятся только к основному провайдеру
    model: (primary && process.env.THELPER_MODEL) || provider.model,
    baseUrl:
      (primary ? process.env.THELPER_BASE_URL : process.env.THELPER_FALLBACK_BASE_URL) ||
      provider.baseUrl,
    apiKey: process.env[provider.keyEnv] || "",
    client: provider.kind === "anthropic" ? new Anthropic() : null,
  };
}

const PRIMARY = contextFor(PROVIDER_NAME, true);

// Запасной включается, только если он задан, отличается от основного и с ключом
const FALLBACK_NAME = process.env.THELPER_FALLBACK;
const FALLBACK =
  PROVIDERS[FALLBACK_NAME] && FALLBACK_NAME !== PROVIDER_NAME
    ? contextFor(FALLBACK_NAME, false)
    : null;

if (!PRIMARY.apiKey && !(PROVIDER_NAME === "anthropic" && process.env.ANTHROPIC_AUTH_TOKEN)) {
  console.error(
    `[!] Не задан ${PRIMARY.provider.keyEnv}. Создай server/.env по образцу .env.example.`,
  );
}
if (FALLBACK && !FALLBACK.apiKey) {
  console.error(`[!] Запасной ${FALLBACK.title} без ключа (${FALLBACK.provider.keyEnv}), он выключен.`);
}

const LANGS = {
  ru: "русский",
  kk: "казахский",
  en: "английский",
  auto: "тот же язык, на котором задан вопрос",
};

// Короткий режим: нужен только вариант ответа, разбор не запрашиваем —
// это экономит и время, и токены.
function briefPrompt(lang) {
  const langName = LANGS[lang] || LANGS.auto;
  return `Ты — помощник для решения тестовых вопросов. Тебе дают вопрос: текстом со страницы или скриншотом.

Задача: определить правильный ответ.

Правила:
- Отвечай СТРОГО в формате ниже. Никакого текста до или после него.
- Если даны варианты — выбери букву из списка. Если правильных несколько, перечисли через запятую: A, C
- Если вариантов нет, вопрос со вписываемым ответом: поставь в ОТВЕТ только само значение — число, слово или короткое выражение. Не больше 40 символов, без пояснений и без повтора условия.
- Единицу измерения добавляй, только если её требует условие. Дробь пиши так, как просит задание: 28,27 или 28.27.
- Если вопрос нечитаем — поставь в ОТВЕТ знак ?
- Считай аккуратно: перепроверь арифметику и единицы измерения перед ответом.
- Рассуждай про себя, в ответ выноси только результат. Язык: ${langName}.

Формат ответа:
ОТВЕТ: <буква(ы) или краткий ответ>
ТЕКСТ: <дословный текст выбранного варианта, или прочерк если вариантов нет>
УВЕРЕННОСТЬ: <высокая|средняя|низкая>`;
}

function systemPrompt(lang) {
  const langName = LANGS[lang] || LANGS.auto;
  return `Ты — помощник для решения тестовых вопросов. Тебе дают вопрос: текстом со страницы или скриншотом.

Задача: определить правильный ответ и коротко объяснить его.

Правила:
- Отвечай СТРОГО в формате ниже. Никакого текста до или после него.
- Если даны варианты — выбери букву из списка. Если правильных несколько, перечисли через запятую: A, C
- Если вариантов нет — оставь в ОТВЕТ сам ответ (число, слово, формулу).
- Если вопрос нечитаем или обрезан — поставь в ОТВЕТ знак ? и напиши в РАЗБОР, чего не хватает.
- Не выдумывай варианты, которых нет в списке.
- Считай аккуратно: перепроверь арифметику и единицы измерения перед ответом.
- Язык объяснения: ${langName}.

Формат ответа:
ОТВЕТ: <буква(ы) или краткий ответ>
ТЕКСТ: <дословный текст выбранного варианта, или прочерк если вариантов нет>
УВЕРЕННОСТЬ: <высокая|средняя|низкая>
РАЗБОР: <2-4 предложения>`;
}

const promptFor = (body) =>
  body.brief ? briefPrompt(body.lang) : systemPrompt(body.lang);

const IMAGE_PROMPT =
  "На скриншоте — страница с тестовым вопросом. Найди сам вопрос и варианты ответа, затем реши его. Буквы вариантов бери из тех, что видны на картинке (A, B, C… или 1, 2, 3…).";

function decodeImage(raw) {
  const m = String(raw || "").match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/);
  if (!m) throw new HttpError(400, "Некорректный скриншот");
  return { mediaType: m[1], data: m[3], dataUrl: raw };
}

// Текстовая часть запроса — одинаковая для всех провайдеров
function questionText(body) {
  const question = String(body.question || "").trim();
  if (!question) throw new HttpError(400, "Пустой вопрос");

  let text = `ВОПРОС:\n${question}`;

  const options = Array.isArray(body.options) ? body.options : [];
  if (options.length) {
    text +=
      "\n\nВАРИАНТЫ:\n" +
      options.map((o) => `${o.letter}) ${String(o.text).trim()}`).join("\n");
  }

  const context = String(body.context || "").trim();
  if (context) {
    text +=
      "\n\nКОНТЕКСТ СТРАНИЦЫ (может содержать мусор, используй только если он помогает):\n" +
      context.slice(0, 4000);
  }
  return text;
}

function buildAnthropicContent(body) {
  if (body.mode !== "image") return [{ type: "text", text: questionText(body) }];
  const img = decodeImage(body.image);
  return [
    { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
    { type: "text", text: IMAGE_PROMPT },
  ];
}

function buildOpenAIMessages(body) {
  const system = { role: "system", content: promptFor(body) };

  if (body.mode !== "image") {
    return [system, { role: "user", content: questionText(body) }];
  }

  const img = decodeImage(body.image);
  return [
    system,
    {
      role: "user",
      content: [
        { type: "text", text: IMAGE_PROMPT },
        { type: "image_url", image_url: { url: img.dataUrl } },
      ],
    },
  ];
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Anthropic: сначала пробуем серверные fallback'и на случай отказа
// классификатора, при отказе беты — обычный поток.
async function streamAnthropic(ctx, body, effort, emit) {
  const params = {
    model: ctx.model,
    ...modelParams(ctx.model, effort),
    system: promptFor(body),
    messages: [{ role: "user", content: buildAnthropicContent(body) }],
  };

  let emitted = 0;
  const onDelta = (t) => {
    emitted += 1;
    emit("delta", { text: t });
  };

  try {
    return await pumpAnthropic(
      ctx.client.beta.messages.stream({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }),
      onDelta,
    );
  } catch (err) {
    const betaProblem =
      err?.status === 400 &&
      /beta|fallback|unsupported/i.test(String(err?.message || ""));
    if (emitted > 0 || !betaProblem) throw err;
    return await pumpAnthropic(ctx.client.messages.stream(params), onDelta);
  }
}

async function pumpAnthropic(stream, onDelta) {
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      onDelta(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  return {
    stop_reason: final.stop_reason,
    stop_details: final.stop_details ?? null,
    usage: {
      input_tokens: final.usage?.input_tokens ?? 0,
      output_tokens: final.usage?.output_tokens ?? 0,
    },
  };
}

// Бесплатные тарифы часто отвечают 429 и 503. Повторяем, пока ничего
// не отдали клиенту: для него это выглядит просто как чуть более долгий ответ.
// 429 сюда намеренно не входит: провайдер называет точную паузу, она обычно
// десятки секунд, а лишние попытки только тратят остаток квоты. Честнее
// сразу сказать пользователю, сколько ждать.
const RETRY_STATUS = new Set([500, 502, 503, 504]);
const RETRIES = Number(process.env.THELPER_RETRIES ?? 3);
const MAX_WAIT = 20000; // дольше ждать ответа на вопрос теста нет смысла

async function fetchWithRetry(ctx, payload) {
  let last = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${ctx.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ctx.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      last = new HttpError(502, `${ctx.title}: нет связи (${err.message})`);
      if (attempt === RETRIES) throw last;
      await sleep(backoff(attempt, null));
      continue;
    }

    if (res.ok && res.body) return res;

    const text = await res.text().catch(() => "");
    last = new HttpError(res.status, friendlyProviderError(ctx, res.status, text));

    if (!RETRY_STATUS.has(res.status) || attempt === RETRIES) throw last;

    // Gemini кладёт нужную паузу не в заголовок, а в тело ответа
    const hinted = res.headers.get("retry-after") ?? hintedDelay(text);

    // Ждать минуту ради одного вопроса бессмысленно: честно говорим об этом
    if (Number(hinted) * 1000 > MAX_WAIT) throw last;

    const wait = backoff(attempt, hinted);
    console.log(
      `[retry] ${res.status} от ${ctx.title}, пауза ${Math.round(wait / 1000)} с, попытка ${attempt + 2}`,
    );
    await sleep(wait);
  }
  throw last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Вытаскиваем рекомендованную паузу из тела ответа: у Gemini это поле
// retryDelay в details, а в тексте — фраза "Please retry in N".
function hintedDelay(text) {
  const field = text.match(/"retryDelay"\s*:\s*"([\d.]+)s?"/);
  if (field) return Number(field[1]);
  const phrase = text.match(/retry in ([\d.]+)/i);
  return phrase ? Number(phrase[1]) : null;
}

// Превращаем многословную ошибку провайдера в короткую понятную фразу
function friendlyProviderError(ctx, status, text) {
  if (status === 429) {
    const limit = text.match(/limit:\s*(\d+)/);
    const wait = hintedDelay(text);
    let msg = `Лимит ${ctx.title} исчерпан`;
    if (limit) msg += `: ${limit[1]} запросов в минуту`;
    if (wait) msg += `, повтори через ${Math.ceil(wait)} с`;
    return msg;
  }
  if (status === 401 || status === 403) {
    return `${ctx.title} не принял ключ. Проверь ${ctx.provider.keyEnv} в server/.env`;
  }
  if (status >= 500) {
    return `${ctx.title} сейчас перегружен, попробуй ещё раз`;
  }
  return `${ctx.title}: ${text.slice(0, 200)}`;
}

function backoff(attempt, retryAfter) {
  const hinted = Number(retryAfter) * 1000;
  // ждём ровно столько, сколько просит провайдер, плюс небольшой запас
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted + 500, MAX_WAIT);
  return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250;
}

// Groq, Gemini, Cerebras, OpenRouter — один формат на всех
async function streamOpenAICompatible(ctx, body, effort, emit) {
  if (body.mode === "image" && !ctx.provider.vision) {
    throw new HttpError(
      400,
      `${ctx.title} не умеет читать картинки. Используй Alt+Q или переключись на Gemini либо Anthropic.`,
    );
  }

  const payload = {
    model: ctx.model,
    messages: buildOpenAIMessages(body),
    stream: true,
    max_tokens: 8000,
    stream_options: { include_usage: true },
  };
  if (ctx.provider.reasoning) payload.reasoning_effort = reasoningEffort(effort);

  const res = await fetchWithRetry(ctx, payload);

  const strip = makeThinkStripper();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finish = null;

  const send = (text) => {
    if (text) emit("delta", { text });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // неполный кадр, ждём следующий
      }

      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) send(strip.push(choice.delta.content));
      if (choice?.finish_reason) finish = choice.finish_reason;

      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens ?? 0,
          output_tokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }
  }
  send(strip.flush());

  return {
    stop_reason: finish === "length" ? "max_tokens" : "end_turn",
    stop_details: null,
    usage,
  };
}

function runWith(ctx, body, effort, emit) {
  return ctx.provider.kind === "anthropic"
    ? streamAnthropic(ctx, body, effort, emit)
    : streamOpenAICompatible(ctx, body, effort, emit);
}

// Переключаться на запасного есть смысл только пока ничего не отдали
// клиенту и только если сбой временный: лимит, перегрузка, обрыв связи.
function worthFallback(err, body, ctx) {
  if (!ctx || !ctx.apiKey) return false;
  if (body.mode === "image" && !ctx.provider.vision) return false;
  const status = err?.status;
  return status === 429 || status === 502 || (status >= 500 && status < 600);
}

async function streamAnswer(body, emit) {
  const effort = EFFORTS.includes(body.effort) ? body.effort : "medium";

  let emitted = 0;
  const count = (event, data) => {
    if (event === "delta") emitted += 1;
    emit(event, data);
  };

  try {
    const res = await runWith(PRIMARY, body, effort, count);
    return { ...res, provider: PRIMARY.title };
  } catch (err) {
    if (emitted > 0 || !worthFallback(err, body, FALLBACK)) throw err;

    console.log(`[fallback] ${PRIMARY.title} не ответил, пробуем ${FALLBACK.title}`);
    emit("notice", { text: `${PRIMARY.title} занят, отвечает ${FALLBACK.title}` });

    const res = await runWith(FALLBACK, body, effort, emit);
    return { ...res, provider: FALLBACK.title, fellBack: true };
  }
}

function describeError(err) {
  if (err instanceof HttpError) return err.message;
  if (err instanceof AuthenticationError)
    return "Ключ API не принят. Проверь ANTHROPIC_API_KEY в server/.env";
  if (err instanceof RateLimitError)
    return "Лимит запросов исчерпан, подожди немного";
  if (err instanceof APIConnectionError) return "Нет связи с API Anthropic";
  if (err instanceof APIError)
    return `Ошибка API ${err.status ?? ""}: ${err.message}`.trim();
  if (err instanceof AnthropicError && /auth|api.?key/i.test(err.message))
    return "Ключ API не найден. Создай server/.env и впиши ANTHROPIC_API_KEY.";
  return String(err?.message || err);
}

// Разрешаем только расширение: у страниц origin http(s), их preflight не пройдёт.
function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-thelper-token");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Vary", "Origin");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new HttpError(413, "Слишком большой запрос"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new HttpError(400, "Некорректный JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        provider: PRIMARY.title,
        model: PRIMARY.model,
        key: Boolean(PRIMARY.apiKey),
        fallback: FALLBACK && FALLBACK.apiKey ? FALLBACK.title : null,
        auth: Boolean(TOKEN),
      }),
    );
    return;
  }

  if (req.method !== "POST" || req.url !== "/solve") {
    res.writeHead(404).end("not found");
    return;
  }

  if (TOKEN && req.headers["x-thelper-token"] !== TOKEN) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Неверный токен доступа" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Важно: слушаем res, а не req — 'close' на req срабатывает сразу после
  // того, как тело запроса дочитано, и заглушил бы все события.
  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  try {
    const body = await readBody(req);
    const started = Date.now();
    const result = await streamAnswer(body, (e, d) => {
      if (!closed) emit(e, d);
    });
    emit("done", { ...result, ms: Date.now() - started });
    console.log(
      `[ok] ${body.mode} · ${result.usage.input_tokens}→${result.usage.output_tokens} токенов · ${Date.now() - started} мс`,
    );
  } catch (err) {
    const message = describeError(err);
    console.error("[err]", message);
    if (!closed) emit("error", { message });
  } finally {
    if (!closed) res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Test Helper сервер слушает http://${HOST}:${PORT}`);
  console.log(`Провайдер: ${PRIMARY.title}${PRIMARY.provider.free ? " (бесплатный тариф)" : ""}`);
  console.log(`Модель: ${PRIMARY.model}`);
  if (!PRIMARY.apiKey) console.log(`Ключ: не задан (${PRIMARY.provider.keyEnv})`);
  console.log(
    FALLBACK && FALLBACK.apiKey
      ? `Запасной: ${FALLBACK.title} (${FALLBACK.model})`
      : "Запасной: не задан",
  );
  console.log(TOKEN ? "Токен доступа: включён" : "Токен доступа: выключен (THELPER_TOKEN не задан)");
});
