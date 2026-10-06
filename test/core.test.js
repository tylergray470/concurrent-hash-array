import { test } from "node:test";
import assert from "node:assert/strict";

import { ConcurrentHashArray } from "../src/index.js";

test("constructor rejects non-positive or non-integer capacity", () => {
  assert.throws(() => new ConcurrentHashArray(0), RangeError);
  assert.throws(() => new ConcurrentHashArray(-1), RangeError);
  assert.throws(() => new ConcurrentHashArray(1.5), RangeError);
  assert.throws(() => new ConcurrentHashArray(NaN), RangeError);
});

test("put then get returns the inserted value", () => {
  const m = new ConcurrentHashArray(8);
  assert.equal(m.put("a", 1), true);
  assert.equal(m.get("a"), 1);
  assert.equal(m.has("a"), true);
});

test("get on missing key returns undefined", () => {
  const m = new ConcurrentHashArray(8);
  assert.equal(m.get("missing"), undefined);
  assert.equal(m.has("missing"), false);
});

test("put replaces existing value and returns true", () => {
  const m = new ConcurrentHashArray(8);
  m.put("k", "v1");
  assert.equal(m.put("k", "v2"), true);
  assert.equal(m.get("k"), "v2");
  assert.equal(m.size, 1);
});

test("delete removes a key and returns true", () => {
  const m = new ConcurrentHashArray(8);
  m.put("k", "v");
  assert.equal(m.delete("k"), true);
  assert.equal(m.get("k"), undefined);
  assert.equal(m.size, 0);
});

test("delete on missing key returns false", () => {
  const m = new ConcurrentHashArray(8);
  assert.equal(m.delete("nope"), false);
});

test("delete then reinsert works (tombstone reuse)", () => {
  const m = new ConcurrentHashArray(8);
  m.put("k", 1);
  m.delete("k");
  assert.equal(m.put("k", 2), true);
  assert.equal(m.get("k"), 2);
  assert.equal(m.size, 1);
});

test("colliding keys do not stomp each other", () => {
  // With capacity 4, two keys that hash to the same slot probe to the next.
  const m = new ConcurrentHashArray(4);
  m.put("a", 1);
  m.put("b", 2);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 2);
  assert.equal(m.size, 2);
});

test("table full of distinct keys returns false on overflow", () => {
  const m = new ConcurrentHashArray(3);
  assert.equal(m.put("a", 1), true);
  assert.equal(m.put("b", 2), true);
  assert.equal(m.put("c", 3), true);
  assert.equal(m.put("d", 4), false);
  assert.equal(m.size, 3);
});

test("reinsert after delete when table was full succeeds", () => {
  const m = new ConcurrentHashArray(3);
  m.put("a", 1);
  m.put("b", 2);
  m.put("c", 3);
  assert.equal(m.put("d", 4), false);
  m.delete("a");
  assert.equal(m.put("d", 4), true);
  assert.equal(m.get("d"), 4);
});

test("entries returns all live pairs", () => {
  const m = new ConcurrentHashArray(8);
  m.put("x", 10);
  m.put("y", 20);
  m.delete("x");
  m.put("z", 30);
  const pairs = m.entries().sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(pairs, [["y", 20], ["z", 30]]);
});

test("capacity is reported as constructed", () => {
  const m = new ConcurrentHashArray(16);
  assert.equal(m.capacity, 16);
});

test("values of any type can be stored", () => {
  const m = new ConcurrentHashArray(8);
  const obj = { nested: [1, 2, 3] };
  m.put("obj", obj);
  m.put("null", null);
  m.put("zero", 0);
  m.put("empty", "");
  assert.equal(m.get("obj"), obj);
  assert.equal(m.get("null"), null);
  assert.equal(m.get("zero"), 0);
  assert.equal(m.get("empty"), "");
});

test("large insertion of sequential integer-string keys", () => {
  const m = new ConcurrentHashArray(1000);
  for (let i = 0; i < 1000; i++) {
    assert.equal(m.put("k" + i, i), true);
  }
  for (let i = 0; i < 1000; i++) {
    assert.equal(m.get("k" + i), i);
  }
  assert.equal(m.size, 1000);
});

test("interleaved put/get/delete sequence is consistent", () => {
  const m = new ConcurrentHashArray(32);
  for (let i = 0; i < 32; i++) m.put("k" + i, i);
  for (let i = 0; i < 32; i += 2) m.delete("k" + i);
  for (let i = 0; i < 32; i++) {
    if (i % 2 === 0) {
      assert.equal(m.get("k" + i), undefined);
    } else {
      assert.equal(m.get("k" + i), i);
    }
  }
  assert.equal(m.size, 16);
});
