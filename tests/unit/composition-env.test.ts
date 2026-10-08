import { describe, expect, it } from "vitest";
import { handoffAutoReleaseMs } from "../../src/composition";

describe("handoffAutoReleaseMs — HANDOFF_AUTO_RELEASE_HOURS parsing (FR-211)", () => {
  it("is undefined (never auto-release) when unset, empty, non-numeric, zero or negative", () => {
    expect(handoffAutoReleaseMs(undefined)).toBeUndefined();
    expect(handoffAutoReleaseMs("")).toBeUndefined();
    expect(handoffAutoReleaseMs("24h")).toBeUndefined();
    expect(handoffAutoReleaseMs("0")).toBeUndefined();
    expect(handoffAutoReleaseMs("-1")).toBeUndefined();
  });

  it("converts hours to milliseconds, fractions included", () => {
    expect(handoffAutoReleaseMs("24")).toBe(24 * 60 * 60 * 1000);
    expect(handoffAutoReleaseMs("0.5")).toBe(30 * 60 * 1000);
  });
});

describe("agentBudgetUsd — AGENT_BUDGET_USD parsing (005 FR-510)", () => {
  it("defaults to US$ 0.25 when unset or empty", async () => {
    const { agentBudgetUsd } = await import("../../src/composition");
    expect(agentBudgetUsd(undefined)).toBe(0.25);
    expect(agentBudgetUsd("")).toBe(0.25);
  });

  it("accepts a positive number and fails fast on anything else", async () => {
    const { agentBudgetUsd } = await import("../../src/composition");
    expect(agentBudgetUsd("0.1")).toBe(0.1);
    expect(agentBudgetUsd("2")).toBe(2);
    for (const bad of ["0", "-1", "abc", "Infinity", "0.25usd"]) {
      expect(() => agentBudgetUsd(bad)).toThrow(/AGENT_BUDGET_USD/);
    }
  });
});

describe("pricedModels — every configured model needs a price (005 FR-512)", () => {
  it("lists the primary model (env or default)", async () => {
    const { pricedModels } = await import("../../src/composition");
    expect(pricedModels({})).toEqual(["claude-sonnet-5-5"]);
    expect(pricedModels({ ANTHROPIC_MODEL: "claude-haiku-4-5" })).toEqual(["claude-haiku-4-5"]);
  });

  it("startup refuses an unpriced primary model", async () => {
    const { assertConfiguredModelsPriced } = await import("../../src/composition");
    expect(() => assertConfiguredModelsPriced({ ANTHROPIC_MODEL: "claude-unknown-9" })).toThrow(
      /claude-unknown-9/,
    );
    expect(() => assertConfiguredModelsPriced({})).not.toThrow();
  });
});

describe("fallback provider wiring (005 FR-513)", () => {
  const FULL = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    FALLBACK_LLM_BASE_URL: "https://example.test/v1",
    FALLBACK_LLM_API_KEY: "k",
    FALLBACK_LLM_MODEL: "claude-haiku-4-5",
  };

  it("fallbackConfig: all three → config, none → null, partial → fail fast", async () => {
    const { fallbackConfig } = await import("../../src/composition");
    expect(fallbackConfig({})).toBeNull();
    expect(fallbackConfig(FULL)).toEqual({
      baseUrl: FULL.FALLBACK_LLM_BASE_URL,
      apiKey: "k",
      model: "claude-haiku-4-5",
    });
    expect(() => fallbackConfig({ FALLBACK_LLM_BASE_URL: "x" })).toThrow(/FALLBACK_LLM_/);
  });

  it("buildLlm wraps the primary in FallbackLLM only when configured; pricedModels includes the fallback model", async () => {
    const { buildLlm, pricedModels, assertConfiguredModelsPriced } = await import(
      "../../src/composition"
    );
    const { FallbackLLM } = await import("../../src/adapters/llm/fallback-llm");
    const { AnthropicLLM } = await import("../../src/adapters/llm/anthropic-llm");
    expect(buildLlm({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBeInstanceOf(AnthropicLLM);
    const wrapped = buildLlm(FULL);
    expect(wrapped).toBeInstanceOf(FallbackLLM);
    expect(wrapped.model).toBe("claude-sonnet-5-5");
    expect(pricedModels(FULL)).toEqual(["claude-sonnet-5-5", "claude-haiku-4-5"]);
    expect(() =>
      assertConfiguredModelsPriced({ ...FULL, FALLBACK_LLM_MODEL: "gpt-unpriced" }),
    ).toThrow(/gpt-unpriced/);
  });
});

describe("review fix — no SDK retries on the primary when a fallback exists", () => {
  it("primary maxRetries is 0 with a fallback and the SDK default without", async () => {
    const { buildLlm } = await import("../../src/composition");
    const { FallbackLLM } = await import("../../src/adapters/llm/fallback-llm");
    const { AnthropicLLM } = await import("../../src/adapters/llm/anthropic-llm");
    const plain = buildLlm({ ANTHROPIC_API_KEY: "sk-ant-test" }) as InstanceType<
      typeof AnthropicLLM
    >;
    expect(plain.maxRetries).toBeUndefined();
    const wrapped = buildLlm({
      ANTHROPIC_API_KEY: "sk-ant-test",
      FALLBACK_LLM_BASE_URL: "https://example.test/v1",
      FALLBACK_LLM_API_KEY: "k",
      FALLBACK_LLM_MODEL: "claude-haiku-4-5",
    }) as InstanceType<typeof FallbackLLM>;
    expect((wrapped.primary as InstanceType<typeof AnthropicLLM>).maxRetries).toBe(0);
  });
});

// T720 (007) — reminder settings from the environment; the official channel needs a template.
describe("reminderSettings", () => {
  it("defaults: on, 24 h lead, 3 h notice, no template", async () => {
    const { reminderSettings } = await import("../../src/composition");
    expect(reminderSettings({})).toEqual({
      enabled: true,
      leadMs: 24 * 3_600_000,
      noticeLeadMs: 3 * 3_600_000,
      template: null,
    });
  });

  it("reads the knobs and the template (language defaults to pt_BR)", async () => {
    const { reminderSettings } = await import("../../src/composition");
    expect(
      reminderSettings({
        REMINDERS_ENABLED: "false",
        REMINDER_LEAD_HOURS: "26",
        UNCONFIRMED_NOTICE_LEAD_HOURS: "2",
        WHATSAPP_REMINDER_TEMPLATE: "lembrete_consulta",
      }),
    ).toEqual({
      enabled: false,
      leadMs: 26 * 3_600_000,
      noticeLeadMs: 2 * 3_600_000,
      template: { name: "lembrete_consulta", language: "pt_BR" },
    });
  });

  it("rejects a notice lead that is not shorter than the reminder lead, and non-positive hours", async () => {
    const { reminderSettings } = await import("../../src/composition");
    expect(() =>
      reminderSettings({ REMINDER_LEAD_HOURS: "3", UNCONFIRMED_NOTICE_LEAD_HOURS: "3" }),
    ).toThrow(/shorter/);
    expect(() => reminderSettings({ REMINDER_LEAD_HOURS: "0" })).toThrow(/REMINDER_LEAD_HOURS/);
  });

  it("official channel + reminders on + no template → fails fast; otherwise fine", async () => {
    const { reminderSettings } = await import("../../src/composition");
    expect(() => reminderSettings({ MESSAGING_PROVIDER: "cloud" })).toThrow(
      /WHATSAPP_REMINDER_TEMPLATE/,
    );
    expect(
      reminderSettings({ MESSAGING_PROVIDER: "cloud", REMINDERS_ENABLED: "false" }).enabled,
    ).toBe(false);
    expect(
      reminderSettings({ MESSAGING_PROVIDER: "cloud", WHATSAPP_REMINDER_TEMPLATE: "t" }).template
        ?.name,
    ).toBe("t");
    expect(reminderSettings({ MESSAGING_PROVIDER: "evolution" }).template).toBeNull();
  });
});
