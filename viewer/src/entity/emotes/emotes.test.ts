import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { builtinEmote, registerNativeEmotes, WAVE_EMOTE_ID } from "./index";
import { sampleAnimationPoses } from "../animation";
import { createDefaultHost } from "../../molang";

// Synthetic parser fixture, deliberately not a real emote or a shipped fallback.
const fixture = {
  schemaVersion: 1,
  emotes: [
    {
      id: "00000000-0000-0000-0000-000000000001",
      animationName: "animation.fixture",
      document: {
        animations: {
          "animation.fixture": {
            animation_length: 4.5,
            bones: {
              head: { rotation: { "0": [0, 0, 0], "4.5": [45, 0, 0] } },
            },
          },
        },
      },
    },
  ],
};

test("native registry uses metadata, retains timing and rejects corrupt replacement atomically", () => {
  registerNativeEmotes(fixture);
  const anim = builtinEmote(fixture.emotes[0].id)!;
  assert.equal(anim.animationLength, 4.5);
  assert.equal(builtinEmote(WAVE_EMOTE_ID), null);
  assert.throws(() =>
    registerNativeEmotes({
      ...fixture,
      emotes: [...fixture.emotes, ...fixture.emotes],
    }),
  );
  assert.equal(builtinEmote(fixture.emotes[0].id), anim);
  assert.equal(sampleAnimationPoses(anim, 4, createDefaultHost()).size, 1);
  assert.equal(sampleAnimationPoses(anim, 4.6, createDefaultHost()).size, 0);
});

const imported = new URL(
  "../../../.cache/emotes/runtime.json",
  import.meta.url,
);
test(
  "installed native wave samples its original multi-bone keyframes",
  { skip: !existsSync(imported) },
  () => {
    const dataset = JSON.parse(readFileSync(imported, "utf8"));
    registerNativeEmotes(dataset);
    for (const entry of dataset.emotes) {
      const anim = builtinEmote(entry.id)!;
      for (let t = 0; t <= anim.animationLength; t += 1 / 60) {
        for (const pose of sampleAnimationPoses(
          anim,
          t,
          createDefaultHost(),
        ).values()) {
          assert.ok(
            [...pose.rotation, ...pose.position, ...pose.scale].every(
              Number.isFinite,
            ),
          );
        }
      }
    }
    const wave = builtinEmote(WAVE_EMOTE_ID)!;
    assert.equal(wave.identifier, "animation.overhead_wave");
    assert.ok(wave.bones.size >= 7);
    assert.notEqual(wave.animationLength, 3);
  },
);
