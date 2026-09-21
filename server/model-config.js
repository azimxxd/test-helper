// Разные поколения моделей принимают разные параметры раздумий.
// Здесь одно место, где это знание живёт.

// Адаптивные раздумья: thinking: { type: "adaptive" }
const ADAPTIVE =
  /^claude-(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6)/;

// Полный набор уровней effort, включая xhigh
const EFFORT_FULL = /^claude-(fable-5|mythos-5|opus-5|opus-4-8|opus-4-7|sonnet-5)/;

// Поколение 4.6 знает effort, но без xhigh
const EFFORT_NO_XHIGH = /^claude-(opus-4-6|sonnet-4-6)/;

// Для старых моделей effort не существует, переводим его в бюджет токенов
const BUDGET = { low: 2000, medium: 4000, high: 8000, xhigh: 12000, max: 16000 };

export const EFFORTS = Object.keys(BUDGET);

export function modelParams(model, effort = "medium") {
  const level = EFFORTS.includes(effort) ? effort : "medium";

  if (ADAPTIVE.test(model)) {
    const params = { thinking: { type: "adaptive" }, max_tokens: 32000 };

    if (EFFORT_FULL.test(model)) {
      params.output_config = { effort: level };
    } else if (EFFORT_NO_XHIGH.test(model)) {
      params.output_config = { effort: level === "xhigh" ? "high" : level };
    }
    return params;
  }

  // Haiku 4.5 и всё, что старше: фиксированный бюджет раздумий,
  // max_tokens обязан быть больше бюджета.
  const budget = BUDGET[level];
  return {
    thinking: { type: "enabled", budget_tokens: budget },
    max_tokens: budget + 8000,
  };
}
