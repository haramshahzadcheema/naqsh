import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDeterministicClock, createDeterministicIdGenerator } from "../src/deterministic.js";

describe("createDeterministicIdGenerator", () => {
  it("produces a stable, incrementing sequence per prefix", () => {
    const generateId = createDeterministicIdGenerator();
    assert.equal(generateId("envobj"), "envobj_0001");
    assert.equal(generateId("envobj"), "envobj_0002");
    assert.equal(generateId("envsess"), "envsess_0001");
    assert.equal(generateId("envobj"), "envobj_0003");
  });

  it("two independent generators produce identical sequences from the same call order", () => {
    const a = createDeterministicIdGenerator();
    const b = createDeterministicIdGenerator();
    const callsA = [a("envobj"), a("envobj"), a("chkpt")];
    const callsB = [b("envobj"), b("envobj"), b("chkpt")];
    assert.deepEqual(callsA, callsB);
  });

  it("two independent generators never share counter state", () => {
    const a = createDeterministicIdGenerator();
    const b = createDeterministicIdGenerator();
    a("envobj");
    a("envobj");
    assert.equal(b("envobj"), "envobj_0001", "consuming from generator a must not advance generator b");
  });
});

describe("createDeterministicClock", () => {
  it("starts at the given ISO timestamp and advances by stepMs on every call", () => {
    const clock = createDeterministicClock("2024-01-01T00:00:00.000Z", 1000);
    assert.equal(clock(), "2024-01-01T00:00:00.000Z");
    assert.equal(clock(), "2024-01-01T00:00:01.000Z");
    assert.equal(clock(), "2024-01-01T00:00:02.000Z");
  });

  it("defaults to a fixed epoch and 1000ms steps when called with no arguments", () => {
    const clock = createDeterministicClock();
    assert.equal(clock(), "2000-01-01T00:00:00.000Z");
    assert.equal(clock(), "2000-01-01T00:00:01.000Z");
  });

  it("two independent clocks never share state", () => {
    const a = createDeterministicClock("2024-01-01T00:00:00.000Z");
    const b = createDeterministicClock("2024-01-01T00:00:00.000Z");
    a();
    a();
    assert.equal(b(), "2024-01-01T00:00:00.000Z", "advancing clock a must not advance clock b");
  });

  it("rejects an invalid starting timestamp", () => {
    assert.throws(() => createDeterministicClock("not-a-date"), /not a valid ISO timestamp/);
  });
});
