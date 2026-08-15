import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeStatus,
  encodeInstruction,
  INSTRUCTION_PREFIX,
  msToTicks,
  STATUS_PREFIX,
  type InstructionEnvelope,
} from "../../protocol";

describe("protocol", () => {
  it("encodeInstruction prefixes a JSON envelope", () => {
    const envelope: InstructionEnvelope<"chat"> = {
      id: "1",
      action: "chat",
      parameters: { message: "hi" },
      timeoutMs: 1000,
    };
    const encoded = encodeInstruction(envelope);
    assert.equal(encoded.startsWith(INSTRUCTION_PREFIX), true);
    assert.deepEqual(
      JSON.parse(encoded.slice(INSTRUCTION_PREFIX.length)),
      envelope,
    );
  });

  it("decodeStatus parses a well-formed STATUS reply", () => {
    const decoded = decodeStatus(
      `${STATUS_PREFIX}${JSON.stringify({
        id: "7",
        status: "success",
        data: { ok: true },
      })}`,
    );
    assert.deepEqual(decoded, {
      id: "7",
      status: "success",
      data: { ok: true },
    });
  });

  it("decodeStatus rejects non-protocol and malformed messages", () => {
    assert.equal(decodeStatus("hello"), undefined);
    assert.equal(decodeStatus(`${STATUS_PREFIX}{not-json`), undefined);
    assert.equal(decodeStatus(INSTRUCTION_PREFIX + "{}"), undefined);
  });

  it("msToTicks rounds up and never returns less than 1", () => {
    assert.equal(msToTicks(1), 1);
    assert.equal(msToTicks(50), 1);
    assert.equal(msToTicks(1000), 20);
    assert.equal(msToTicks(1001), 21);
  });
});
