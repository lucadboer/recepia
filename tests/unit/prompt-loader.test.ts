import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  loadPromptArtifact,
  PROMPT_ARTIFACT,
  PROMPT_VERSION,
} from "../../src/agent/system-prompt";
import { TOOL_NAMES } from "../../src/agent/tool-schemas";
import { CLINIC_TIMEZONE, ROUTINE_TYPES } from "../../src/config";

// T409 — the system prompt is a versioned artifact (prompts/system/vNNN.md + CHANGELOG);
// its id `vNNN+<sha256[:7]>` follows the file content and is recorded on every call.

const NOW = new Date("2026-06-15T12:00:00Z");
const ctx = { now: NOW, timezone: CLINIC_TIMEZONE };

function tmpPrompts(files: Record<string, string>): { systemDir: string; changelogPath: string } {
  const root = mkdtempSync(join(tmpdir(), "recepia-prompts-"));
  const systemDir = join(root, "system");
  mkdirSync(systemDir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(name === "CHANGELOG.md" ? join(root, name) : join(systemDir, name), content);
  }
  return { systemDir, changelogPath: join(root, "CHANGELOG.md") };
}

const CHANGELOG_V1 = "# System prompt changelog\n\n## v001 — 2026-10-06\n- initial\n";

describe("prompt artifact loader", () => {
  it("loads the newest vNNN.md and derives version = vNNN+sha256[:7]", () => {
    const art = loadPromptArtifact(
      tmpPrompts({ "v001.md": "Você é a secretária.\n", "CHANGELOG.md": CHANGELOG_V1 }),
    );
    expect(art.id).toBe("v001");
    expect(art.version).toMatch(/^v001\+[0-9a-f]{7}$/);
    expect(art.template).toBe("Você é a secretária.\n");
  });

  it("the version changes when the file content changes (and only then)", () => {
    const a = loadPromptArtifact(tmpPrompts({ "v001.md": "A\n", "CHANGELOG.md": CHANGELOG_V1 }));
    const b = loadPromptArtifact(tmpPrompts({ "v001.md": "A\n", "CHANGELOG.md": CHANGELOG_V1 }));
    const c = loadPromptArtifact(tmpPrompts({ "v001.md": "A!\n", "CHANGELOG.md": CHANGELOG_V1 }));
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
    expect(c.version.startsWith("v001+")).toBe(true);
  });

  it("picks the highest version number when several files exist", () => {
    const art = loadPromptArtifact(
      tmpPrompts({
        "v001.md": "old\n",
        "v002.md": "new\n",
        "CHANGELOG.md": `${CHANGELOG_V1}\n## v002 — 2026-10-07\n- tweak\n`,
      }),
    );
    expect(art.id).toBe("v002");
    expect(art.template).toBe("new\n");
  });

  it("fails fast when prompts/system has no vNNN.md", () => {
    expect(() => loadPromptArtifact(tmpPrompts({ "CHANGELOG.md": CHANGELOG_V1 }))).toThrow(
      /no prompt artifact/i,
    );
    expect(() =>
      loadPromptArtifact(tmpPrompts({ "draft.md": "x", "CHANGELOG.md": CHANGELOG_V1 })),
    ).toThrow(/no prompt artifact/i);
  });

  it("fails fast when the CHANGELOG lacks an entry for the newest version", () => {
    expect(() =>
      loadPromptArtifact(
        tmpPrompts({ "v001.md": "a\n", "v002.md": "b\n", "CHANGELOG.md": CHANGELOG_V1 }),
      ),
    ).toThrow(/CHANGELOG.*v002/);
    expect(() =>
      loadPromptArtifact(tmpPrompts({ "v001.md": "a\n", "CHANGELOG.md": "# empty\n" })),
    ).toThrow(/CHANGELOG.*v001/);
  });

  it("fails fast when the CHANGELOG file is missing", () => {
    const { systemDir } = tmpPrompts({ "v001.md": "a\n" });
    expect(() =>
      loadPromptArtifact({ systemDir, changelogPath: join(systemDir, "nope.md") }),
    ).toThrow(/CHANGELOG/);
  });
});

describe("buildSystemPrompt — versioned text (FR-409) + dated line (FR-213)", () => {
  it("returns { text, version } with the repository artifact's version", () => {
    const p = buildSystemPrompt(ctx);
    expect(p.version).toBe(PROMPT_VERSION);
    expect(p.version).toBe(PROMPT_ARTIFACT.version);
    expect(p.version).toMatch(/^v\d{3}\+[0-9a-f]{7}$/);
    expect(p.text.length).toBeGreaterThan(200);
  });

  it("renders the placeholders: routine types and the allowlisted tools", () => {
    const { text } = buildSystemPrompt(ctx);
    expect(text).not.toContain("{{");
    expect(text).toContain(ROUTINE_TYPES.join(", "));
    for (const name of Object.values(TOOL_NAMES)) expect(text).toContain(name);
  });

  it("keeps the static part byte-identical across calls; only the LAST line is dated", () => {
    const a = buildSystemPrompt(ctx).text.split("\n");
    const b = buildSystemPrompt({ ...ctx, now: new Date("2026-06-17T19:30:00Z") }).text.split("\n");
    expect(a.slice(0, -1)).toEqual(b.slice(0, -1));
    expect(a.at(-1)).not.toEqual(b.at(-1));
    expect(a.at(-1)).toContain("segunda-feira");
    expect(b.at(-1)).toContain("quarta-feira");
  });

  it("cacheablePrefixLength marks the static block: identical across instants, dated line after it", () => {
    const a = buildSystemPrompt(ctx);
    const b = buildSystemPrompt({ ...ctx, now: new Date("2026-06-17T19:30:00Z") });
    expect(a.cacheablePrefixLength).toBeGreaterThan(200);
    expect(a.cacheablePrefixLength).toBe(b.cacheablePrefixLength);
    expect(a.text.slice(0, a.cacheablePrefixLength)).toBe(b.text.slice(0, b.cacheablePrefixLength));
    expect(a.text.slice(a.cacheablePrefixLength)).toContain("segunda-feira");
    expect(a.text.slice(0, a.cacheablePrefixLength)).not.toContain("Hoje é");
  });

  it("renders a given artifact (so a test can pin the exact instructions)", () => {
    const art = loadPromptArtifact(
      tmpPrompts({
        "v001.md": "Tipos: {{routine_types}}. Tools: {{tool_names}}.\n",
        "CHANGELOG.md": CHANGELOG_V1,
      }),
    );
    const p = buildSystemPrompt(ctx, art);
    expect(p.version).toBe(art.version);
    expect(p.text.split("\n")[0]).toBe(
      `Tipos: ${ROUTINE_TYPES.join(", ")}. Tools: ${Object.values(TOOL_NAMES).join(", ")}.`,
    );
  });
});
