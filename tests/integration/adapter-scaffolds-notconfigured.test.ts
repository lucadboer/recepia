import { describe, expect, it } from "vitest";
import { GoogleCalendar } from "../../src/adapters/calendar/google-calendar";
import { AnthropicLLM } from "../../src/adapters/llm/anthropic-llm";
import { CloudApiMessaging } from "../../src/adapters/messaging/cloud-api-messaging";
import { EvolutionMessaging } from "../../src/adapters/messaging/evolution-messaging";
import { NotConfigured } from "../../src/domain/errors";

// Pass "" to force the not-configured branch regardless of ambient env (default
// params only kick in for `undefined`).
describe("real adapter scaffolds — needs-creds boundary", () => {
  it("AnthropicLLM throws NotConfigured without an API key", () => {
    expect(() => new AnthropicLLM("")).toThrow(NotConfigured);
  });
  it("EvolutionMessaging throws NotConfigured without creds", () => {
    expect(() => new EvolutionMessaging("", "", "")).toThrow(NotConfigured);
  });
  it("CloudApiMessaging throws NotConfigured without creds", () => {
    expect(() => new CloudApiMessaging("", "")).toThrow(NotConfigured);
  });
  it("GoogleCalendar throws NotConfigured without creds", () => {
    expect(() => new GoogleCalendar("", "")).toThrow(NotConfigured);
  });
});
