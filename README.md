# ConcurrentHashArray

A fixed-capacity, open-addressed hash array in pure ECMAScript with per-slot compare-and-swap semantics for concurrent access. Keys are strings; values are any JavaScript value.

## Usage

```js
import { ConcurrentHashArray } from "concurrent-hash-array";

const map = new ConcurrentHashArray(256);
map.put("session:42", { userId: 42 });
map.get("session:42");      // { userId: 42 }
map.delete("session:42");   // true
map.has("session:42");      // false
map.entries();              // Array of [key, value] pairs (point-in-time snapshot)
```

## Why this exists

Lock-free hash maps in the academic sense (Harris-Michael split-ordered lists) need a linked structure and a memory-reclamation scheme that ECMAScript has no primitives for. Building that here would mean smuggling in a dependency or hand-rolling a GC scheme that fails in subtle ways. This library makes a different, stated trade-off: a fixed-capacity, open-addressed array where every mutation goes through a compare-and-swap transition on the target slot's state byte. Writers to the same key are serialized by the slot's state; readers see a consistent (key, value) pair at the moment they read it because state is read before key/value.

## Exports

- `ConcurrentHashArray` — the only export.

## API

- `new ConcurrentHashArray(capacity)` — `capacity` must be a positive integer. The table does not grow.
- `put(key, value)` — returns `true` on insert/replace, `false` if the table is full and the key is absent.
- `get(key)` — returns the value or `undefined`.
- `has(key)` — `get(key) !== undefined`.
- `delete(key)` — returns `true` if the key was present.
- `entries()` — returns `Array<[string, any]>` of live pairs at the moment of the call.
- `size` — number of live entries.
- `capacity` — the constructed capacity.

## Edge cases

The capacity is fixed at construction. Inserting a new key into a full table returns `false`; it does not throw, and it does not grow. If you need growth, allocate a new `ConcurrentHashArray`, copy via `entries()`, and swap the reference in the caller.

Readers may briefly observe a slot mid-replace (when a value for an existing key is being swapped) and treat it as absent for that probe. A retry of `get` will see the new value. This is the cost of avoiding a global lock on the replace path; it never returns stale data, only occasionally transiently-absent-then-present data during a concurrent value swap.

Keys are strings only. Mixing key types would require a discriminator and a more complex equality function; the brief asked for a small, focused library, so strings it is.
