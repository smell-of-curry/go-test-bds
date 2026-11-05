import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatOpacity, localizeChatText } from "./chat";

describe("native chat expiry", () => {
  it("holds for ten seconds then uses the vanilla one-second in_quart fade", () => {
    assert.equal(chatOpacity(200, 10_200), 1);
    assert.equal(chatOpacity(200, 10_700), 0.9375);
    assert.equal(chatOpacity(200, 11_200), 0);
  });
  it("expires the actual V8 tick-zero joins before challenge tick8672", () => {
    assert.equal(chatOpacity(0, 8672 * 50), 0);
    assert.equal(chatOpacity(8671 * 50, 8672 * 50), 1);
  });
});

describe("late chat language loading", () => {
  const text = "§e%multiplayer.player.joined FilmCam3";
  const lang = { "multiplayer.player.joined": "%s joined the game" };
  it("retains the recorded line until its actual template is available", () => {
    assert.equal(localizeChatText(text, undefined), text);
    assert.equal(localizeChatText(text, lang), "§eFilmCam3 joined the game");
  });
  it("retains spaces within the one recorded argument", () => {
    assert.equal(
      localizeChatText("%joined Two Words", { joined: "%1$s joined" }),
      "Two Words joined",
    );
  });
  it("does not reinterpret ordinary text or guess multiple flattened arguments", () => {
    assert.equal(
      localizeChatText("multiplayer.player.joined FilmCam3", lang),
      "multiplayer.player.joined FilmCam3",
    );
    assert.equal(
      localizeChatText("%pair First Last Other", { pair: "%s fought %s" }),
      "%pair First Last Other",
    );
    assert.equal(
      localizeChatText("%pair First Other", { pair: "%1$s fought %2$s" }),
      "%pair First Other",
    );
  });
});
