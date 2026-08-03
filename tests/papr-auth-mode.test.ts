import { describe, expect, it } from "vitest";
import {
  buildAuth0AuthorizeUrl,
  buildAuth0LogoutUrl,
  formatAuth0CallbackError,
} from "../src/electron/ipc/paprLogin.js";

describe("Papr Auth0 login modes", () => {
  it("uses screen_hint=signup for new account flow", () => {
    const url = buildAuth0AuthorizeUrl({
      state: "test-state",
      codeChallenge: "challenge",
      mode: "signup",
    });

    expect(url.searchParams.get("screen_hint")).toBe("signup");
    expect(url.searchParams.get("state")).toBe("test-state");
  });

  it("omits signup hint for returning users and requests account picker", () => {
    const url = buildAuth0AuthorizeUrl({
      state: "test-state",
      codeChallenge: "challenge",
      mode: "login",
    });

    expect(url.searchParams.get("screen_hint")).toBeNull();
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("maps missing-account style Auth0 errors to signup guidance", () => {
    const message = formatAuth0CallbackError(
      "access_denied",
      "Wrong email or password",
    );

    expect(message).toContain("Create Account");
  });

  it("maps user-not-found descriptions to signup guidance", () => {
    const message = formatAuth0CallbackError(
      "invalid_request",
      "User does not exist",
    );

    expect(message).toContain("Create Account");
  });

  it("builds Auth0 logout URL with return_to param", () => {
    const url = new URL(buildAuth0LogoutUrl("https://papr.ai/logged-out"));

    expect(url.pathname).toBe("/v2/logout");
    expect(url.searchParams.get("return_to")).toBe("https://papr.ai/logged-out");
    expect(url.searchParams.get("client_id")).toBeTruthy();
  });
});
