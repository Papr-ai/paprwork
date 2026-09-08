import { describe, expect, it } from "vitest";
import {
  appAgentMainChatTabTitle,
  buildAppAgentMainChatMessage,
  findAppTabId,
} from "../ui/utils/openAppAgentMainChat";

describe("openAppAgentMainChat", () => {
  it("builds Pen chat message with app, sub-agent, and user request", () => {
    const message = buildAppAgentMainChatMessage({
      appId: "app-123",
      appTitle: "Deck Builder",
      subAgentId: "deck-agent",
      subAgentName: "Build my deck",
      userMessage: "Figure these out for papr work",
    });

    expect(message).toContain('mini-app "Deck Builder" (appId: app-123)');
    expect(message).toContain('useAgentId: "deck-agent"');
    expect(message).toContain("delegate_task");
    expect(message).toContain("My request: Figure these out for papr work");
  });

  it("includes welcome text as context without treating it as the user request", () => {
    const message = buildAppAgentMainChatMessage({
      appId: "app-123",
      appTitle: "Deck Builder",
      subAgentId: "deck-agent",
      subAgentName: "Build my deck",
      welcomeMessage: "Send me buyer details and I will build the deck.",
    });

    expect(message).toContain("Embedded assistant intro");
    expect(message).not.toContain("My request:");
  });

  it("truncates long tab titles", () => {
    expect(
      appAgentMainChatTabTitle(
        "Very Long Application Name That Should Truncate",
        "Another Long Sub Agent Name",
      ).length,
    ).toBeLessThanOrEqual(40);
  });

  it("finds an open app tab by entity id", () => {
    expect(
      findAppTabId(
        [
          { id: "chat-1", type: "chat", entityId: "1" },
          { id: "app-abc", type: "app", entityId: "abc" },
        ],
        "abc",
      ),
    ).toBe("app-abc");
  });
});
