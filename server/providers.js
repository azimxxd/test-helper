// Каталог провайдеров. Все, кроме Anthropic, совместимы с форматом OpenAI,
// поэтому для них хватает одного кода.

export const PROVIDERS = {
  anthropic: {
    title: "Anthropic",
    kind: "anthropic",
    model: "claude-sonnet-5",
    keyEnv: "ANTHROPIC_API_KEY",
    vision: true,
    free: false,
    note: "самый точный, платный",
  },

  gemini: {
    title: "Google Gemini",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.8-flash",
    keyEnv: "GEMINI_API_KEY",
    vision: true,
    reasoning: true,
    free: true,
    note: "бесплатно, понимает скриншоты, ключ из aistudio.google.com",
  },

  groq: {
    title: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyEnv: "GROQ_API_KEY",
    vision: false,
    reasoning: true,
    free: true,
    note: "бесплатно, очень быстро, сильная математика, но без скриншотов",
  },

  cerebras: {
    title: "Cerebras",
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "qwen-3-235b-a22b-instruct-2507",
    keyEnv: "CEREBRAS_API_KEY",
    vision: false,
    reasoning: false,
    free: true,
    note: "бесплатно, крупная модель, без скриншотов",
  },

  openrouter: {
    title: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-r1:free",
    keyEnv: "OPENROUTER_API_KEY",
    vision: false,
    reasoning: false,
    free: true,
    note: "бесплатно, сильные рассуждения, но суточный лимит небольшой",
  },
};

// У моделей с рассуждениями свои названия уровней усилий
export function reasoningEffort(effort) {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high"; // high, xhigh и max
}

// Некоторые открытые модели пишут ход мысли прямо в текст, в тегах <think>.
// Вырезаем их на лету, не ломая разрезанные между кусками теги.
export function makeThinkStripper() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let buf = "";
  let inside = false;

  const step = (chunk, last) => {
    buf += chunk;
    let out = "";

    for (;;) {
      if (!inside) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          const keep = last ? 0 : Math.min(buf.length, OPEN.length - 1);
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        out += buf.slice(0, i);
        buf = buf.slice(i + OPEN.length);
        inside = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          const keep = last ? 0 : Math.min(buf.length, CLOSE.length - 1);
          buf = buf.slice(buf.length - keep);
          break;
        }
        buf = buf.slice(j + CLOSE.length);
        inside = false;
      }
    }
    return out;
  };

  return { push: (chunk) => step(chunk, false), flush: () => step("", true) };
}
