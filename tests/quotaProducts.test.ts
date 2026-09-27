import { describe, expect, it } from "vitest";
import {
  canonicalQuotaMeters,
  compactQuotaStatus,
  isZCodeConfigured,
  moveQuotaProduct,
  quotaEmptyStateText,
  quotaProductStatusText,
  quotaTabOrder,
  quotaTabShowsWarning,
} from "../src/lib/quotaProducts";
import { ProviderRateLimit, QuotaProduct, RateLimitProvider } from "../src/lib/types";

describe("quota product presentation", () => {
  const grok: QuotaProduct = { provider: "grok", displayName: "Grok", availability: "ready", isDetected: true };

  it("distinguishes a discovered unread product from a known no-data result", () => {
    expect(quotaProductStatusText(grok)).toBe("已检测 · 未读取");
    expect(quotaProductStatusText(grok, undefined, "bigModel", { provider: "grok", status: { kind: "noData" } })).toBe("已检测 · 无数据");
  });

  it.each([
    ["ok", "读取成功"], ["disabled", "未启用"], ["unauthorized", "需重新登录"],
    ["retryableError", "读取失败 · 可重试"], ["error", "读取失败"],
  ] as const)("shows %s independently from discovery", (kind, label) => {
    const status = kind === "error" ? { kind, message: "must not be displayed" } : { kind };
    expect(quotaProductStatusText(grok, undefined, "bigModel", { provider: "grok", status })).toBe(`已检测 · ${label}`);
  });

  it("does not borrow another card's status", () => {
    expect(quotaProductStatusText(grok, undefined, "bigModel", { provider: "codex", status: { kind: "noData" } })).toBe("已检测 · 未读取");
  });

  it("separates regional credentials from discovery", () => {
    const product: QuotaProduct = { provider: "zcode", displayName: "ZCode", availability: "ready", isDetected: false };
    const credentials = { bigModelConfigured: true, zAiConfigured: false };
    expect(quotaProductStatusText(product, credentials, "zAI")).toBe("未检测到 · 需配置 API Key");
    expect(quotaProductStatusText(product, credentials, "bigModel")).toBe("未检测到 · API Key 已配置 · 未读取");
  });

  it("keeps pending protocol distinct from a disabled snapshot", () => {
    expect(quotaProductStatusText({ ...grok, provider: "cursor", availability: "pendingProtocol" }, undefined, "bigModel", { provider: "cursor", status: { kind: "disabled" } })).toBe("已检测 · 待接入");
  });

  it("describes discovery separately from protocol readiness", () => {
    const pending: QuotaProduct = {
      provider: "cursor",
      displayName: "Cursor",
      availability: "pendingProtocol",
      isDetected: true,
    };
    expect(quotaProductStatusText(pending)).toBe("已检测 · 待接入");
  });

  it("tracks ZCode regional credentials independently", () => {
    const status = { bigModelConfigured: true, zAiConfigured: false };
    expect(isZCodeConfigured(status, "bigModel")).toBe(true);
    expect(isZCodeConfigured(status, "zAI")).toBe(false);
  });

  it("shortens a settings row to the one fact it can act on", () => {
    expect(compactQuotaStatus("未检测到 · API Key 已配置 · 未读取")).toBe("已配置");
    expect(compactQuotaStatus("已检测 · 需配置 API Key")).toBe("待配置");
    expect(compactQuotaStatus("未检测到 · 需配置 API Key")).toBe("待配置");
    expect(compactQuotaStatus("已检测 · 待接入")).toBe("已检测 · 待接入");
  });
});

describe("quota meter layout", () => {
  it("puts generic periods first from shortest to longest", () => {
    const ordered = canonicalQuotaMeters([
      { id: "mcp", label: "MCP", utilization: 4, windowDuration: 30 * 86_400 },
      { id: "weekly", label: "Weekly", utilization: 30 },
      { id: "sonnet", label: "Sonnet", utilization: 40, windowDuration: 7 * 86_400 },
      { id: "five-hour", label: "5h", utilization: 10, windowDuration: 5 * 3_600 },
      { id: "extra", label: "额外", utilization: 50 },
    ]);

    expect(ordered.map((meter) => meter.label)).toEqual([
      "5h", "7d", "MCP", "Sonnet", "额外",
    ]);
    expect(ordered[1].windowDuration).toBe(7 * 86_400);
  });
});

describe("empty quota card copy", () => {
  const noData = (extra: Partial<ProviderRateLimit>): ProviderRateLimit => ({
    provider: "codex",
    status: { kind: "noData" },
    ...extra,
  });

  it("says a refresh is in flight instead of reporting a verdict", () => {
    expect(quotaEmptyStateText(noData({ emptyReason: "limitReached" }), false, true)).toBe(
      "正在读取订阅配额…",
    );
  });

  it("repeats the live source's own verdict when it reported one", () => {
    expect(quotaEmptyStateText(noData({ emptyReason: "limitReached" }), true)).toBe(
      "本期订阅配额已用满 · 等待额度重置",
    );
    expect(quotaEmptyStateText(noData({ emptyReason: "noWindow" }), true)).toBe(
      "当前没有生效的额度窗口",
    );
  });

  it("never borrows 「已用满」 for a source that cannot tell", () => {
    for (const snapshot of [noData({}), noData({ emptyReason: null })]) {
      expect(quotaEmptyStateText(snapshot, true)).toBe("暂未读取到订阅配额数据");
      expect(quotaEmptyStateText(snapshot, false)).toBe("未检测到本机安装或登录");
      expect(quotaEmptyStateText(snapshot, true)).not.toContain("已用满");
    }
  });

  it("separates a detected product from one that is not installed", () => {
    const product: ProviderRateLimit = { provider: "grok", status: { kind: "noData" } };
    expect(quotaEmptyStateText(product, true)).toBe("暂未读取到订阅配额数据");
    expect(quotaEmptyStateText(product, false)).toBe("未检测到本机安装或登录");
  });
});

describe("tab strip model", () => {
  const catalog: RateLimitProvider[] = ["codex", "claudeCode", "kimi-code", "zcode", "grok", "cursor", "opencode-go"];

  it("lists enabled products first, then the grey ones, each in stored order", () => {
    const stored: RateLimitProvider[] = ["opencode-go", "grok", "cursor", "codex", "claudeCode"];
    const order = quotaTabOrder(catalog, ["grok", "codex"], stored);

    expect(order.slice(0, 2)).toEqual(["grok", "codex"]);
    expect(new Set(order.slice(2))).toEqual(new Set(["opencode-go", "cursor", "claudeCode", "kimi-code", "zcode"]));
    // Every catalog product keeps a tab: an id the stored order forgot is
    // appended rather than dropped, and a ghost id disappears.
    expect(order).toHaveLength(catalog.length);
  });

  it("ignores ids that are no longer in the catalog", () => {
    const order = quotaTabOrder(catalog, ["codex"], ["codex", "ghost-product" as RateLimitProvider]);
    expect(order).not.toContain("ghost-product");
    expect(order[0]).toBe("codex");
  });

  it("keeps the stored order as render order after a drop", () => {
    const stored: RateLimitProvider[] = ["codex", "claudeCode", "grok", "kimi-code"];
    const enabled: RateLimitProvider[] = ["codex", "claudeCode", "grok"];

    expect(moveQuotaProduct(stored, enabled, "grok", "codex")).toEqual([
      "grok", "codex", "claudeCode", "kimi-code",
    ]);
  });

  it("drops past the last tab at the end of the dragged product's own group", () => {
    const stored: RateLimitProvider[] = ["codex", "claudeCode", "grok", "kimi-code"];
    const enabled: RateLimitProvider[] = ["codex", "claudeCode"];

    // grok is disabled, so "the end" is the end of the grey group, not of the row.
    expect(moveQuotaProduct(stored, enabled, "grok", null)).toEqual([
      "codex", "claudeCode", "kimi-code", "grok",
    ]);
  });

  it("normalizes a cross-group drop back into the dragged product's group", () => {
    const stored: RateLimitProvider[] = ["codex", "kimi-code"];
    const enabled: RateLimitProvider[] = ["codex"];

    // Dropping the grey kimi-code onto the enabled codex cannot lift it above it.
    expect(moveQuotaProduct(stored, enabled, "kimi-code", "codex")).toEqual(["codex", "kimi-code"]);
  });

  it("marks enabled products whose last read is not ok, and only those", () => {
    const enabled: RateLimitProvider[] = ["codex", "opencode-go"];
    const notEntitled: ProviderRateLimit = {
      provider: "opencode-go",
      status: { kind: "noData" },
      emptyReason: "notEntitled",
    };

    expect(quotaTabShowsWarning("opencode-go", enabled, notEntitled, false)).toBe(true);
    // A healthy read, a disabled product and a product with no snapshot yet stay plain.
    expect(quotaTabShowsWarning("codex", enabled, { provider: "codex", status: { kind: "ok" } }, false)).toBe(false);
    expect(quotaTabShowsWarning("grok", enabled, notEntitled, false)).toBe(false);
    expect(quotaTabShowsWarning("codex", enabled, undefined, false)).toBe(false);
    // A fetch in flight is not a problem: the card shows its spinner.
    expect(quotaTabShowsWarning("opencode-go", enabled, notEntitled, true)).toBe(false);
  });
});

describe("empty state reasons", () => {
  it("names the product for a missing subscription", () => {
    expect(
      quotaEmptyStateText({ provider: "opencode-go", status: { kind: "noData" }, emptyReason: "notEntitled" },
        true, false, "OpenCode Go"),
    ).toBe("未订阅 OpenCode Go");
  });

  it("explains a Claude session that has no plan windows", () => {
    expect(
      quotaEmptyStateText({ provider: "claudeCode", status: { kind: "noData" }, emptyReason: "sessionWithoutPlanLimits" },
        true),
    ).toBe("当前登录方式不含订阅额度（API Key / Bedrock / Vertex）");
  });
});
