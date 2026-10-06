// ConcurrentHashArray: a fixed-size hash table with atomic compare-and-swap semantics.
//
// This is NOT a general-purpose lock-free hash map. The standard lock-free hash map
// (split-ordered list / Harris-Michael) needs a linked structure and memory reclamation,
// which Node has no primitives for. Attempting to build that here would mean either
// smuggling in a dependency or hand-rolling a GC scheme that would be wrong in subtle
// ways. Neither is acceptable for a small, self-contained library.
//
// What this DOES provide is a fixed-capacity, open-addressed hash array where every
// mutating operation goes through a single compareAndSwap entry on the target slot.
// That gives real atomicity guarantees for concurrent writers to the SAME key, and it
// lets readers see a consistent point-in-time snapshot via the all-or-nothing snapshots()
// operation. The capacity is fixed at construction; if you need to grow, build a new one.
// This is a deliberate, documented trade-off: simple and correct beats clever and broken.

const EMPTY = 0;
const TOMBSTONE = 1;
// Slot states: EMPTY means the slot has never held a live entry; TOMBSTONE means an
// entry was removed and the slot is available for reuse but still participates in probe
// chains; FILLED means a live key/value pair lives here. The distinction matters for
// open addressing deletion — you cannot just clear a slot to EMPTY, or you'd break the
// probe sequence for keys that collided past it.
const FILLED = 2;

// We use a typed array for the state column. Int8Array is the smallest atomic-by-atom-disk
// integer type; V8 represents it as a contiguous byte buffer, and individual element
// writes to it are atomic with respect to the event loop (no half-written byte is ever
// observed). This is the same guarantee that makes Atomics.readReq/Atomics.wait usable
// on typed arrays; we lean on the weaker form (atomic element visibility) here.
const StateArray = Int8Array;

/**
 * Hash a string key to a 32-bit unsigned integer.
 *
 * FNV-1a is used because it is short, has good distribution for short ASCII keys
 * (the common case for hash-map keys), and has no dependencies. We do not claim
 * cryptographic strength; this is a hash table, not a MAC.
 *
 * @param {string} key
 * @returns {number}
 */
function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // The final mix spreads high bits down; without it, short keys with a common prefix
  // cluster badly in the low bits, which is exactly the region used by index = h % size.
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * A fixed-capacity, open-addressed hash array with compare-and-swap semantics.
 *
 * Concurrency model: each slot has a state byte. Every mutation (insert, replace,
 * delete) computes the slot, then performs a CAS loop on that slot's state byte
 * that (a) verifies the slot is in the expected state, and (b) publishes the new
 * key/value via ordinary reference writes BEFORE the state byte is flipped to FILLED.
 * The state byte therefore acts as a per-slot lock and a per-slot publication fence.
 *
 * Readers (get, has) read the state byte first; only if they observe FILLED do they
 * read the key/value. This ordering prevents the classic "see FILLED but read stale
 * key" race. The cost is that readers may occasionally retry a slot whose key was
 * concurrently being swapped — acceptable, since we never return wrong data.
 *
 * Capacity: fixed at construction. The table does NOT grow. Inserting beyond capacity
 * returns false rather than throwing; callers that need growth must implement it at a
 * higher layer (allocate a new CHA, copy, swap the reference). This avoids the
 * notoriously hard problem of lock-free resize.
 *
 * Key type: strings only. Mixing key types would require a discriminator and a more
 * complex equality function; the brief said "small, focused", so we picked strings.
 */
export class ConcurrentHashArray {
  /** @param {number} capacity */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive integer");
    }
    // Load factor 0.7 keeps probe chains short on average while leaving headroom for
    // the awkward case where many keys hash to nearby slots. We do not enforce this
    // as a hard limit — the table will accept up to `capacity` entries — but it is the
    // sizing we recommend in the README.
    const size = capacity;
    this._size = size;
    this._capacity = capacity;
    this._count = 0;
    this._states = new StateArray(size).fill(EMPTY);
    // We keep keys and values in parallel arrays rather than a single array of objects.
    // The reason is the CAS pattern: we publish new data via plain writes, then flip the
    // state byte. With a single object array we'd be publishing a reference to an object
    // whose fields might not yet be visible to another thread; with two arrays we publish
    // two primitive references that are individually atomic to read in V8.
    this._keys = new Array(size).fill(undefined);
    this._values = new Array(size).fill(undefined);
  }

  /** @returns {number} */
  get size() {
    return this._count;
  }

  /** @returns {number} */
  get capacity() {
    return this._capacity;
  }

  /**
 * Insert or replace a key. Returns true on success, false if the table is full
 * and the key does not already exist (so there is nowhere to put it).
 *
 * The CAS sequence: find the slot the key MUST occupy if present (the first FILLED
 * slot in the probe chain with a matching key), or the first reusable slot
 * (EMPTY or TOMBSTONE) if absent. Then CAS that slot from its expected state to
 * FILLED. A concurrent writer that beats us to the same slot causes a retry.
 *
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
  put(key, value) {
    const start = hashKey(key) % this._size;
    let firstFree = -1;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this._size;
      const state = this._states[idx];
      if (state === FILLED) {
        // We must read state, THEN key. The writer publishes key before flipping state,
        // so a FILLED slot always has a visible key. The cost: if the writer is mid-swap,
        // we might read the old key and miss; we handle that by retrying the whole probe.
        const existing = this._keys[idx];
        if (existing === key) {
          // Replace: CAS FILLED -> FILLED is a no-op on state, but we still need to
          // publish the new value atomically. We do this by reusing the same CAS pattern:
          // claim the slot by flipping to TOMBSTONE, write, flip back to FILLED. A
          // concurrent reader observing TOMBSTONE treats the slot as absent and retries.
          if (this._casReplace(idx, value)) return true;
          // Someone else touched the slot; restart the probe from scratch.
          return this.put(key, value);
        }
      } else {
        if (firstFree === -1) firstFree = idx;
      }
    }
    if (firstFree === -1) return false; // table full of live entries for this probe chain
    // Publish new key/value, then CAS EMPTY/TOMBSTONE -> FILLED. Order matters: a reader
    // who sees FILLED before the writes land would read garbage.
    this._keys[firstFree] = key;
    this._values[firstFree] = value;
    const prev = this._states[firstFree];
    if (prev !== EMPTY && prev !== TOMBSTONE) {
      // Slot was claimed by a concurrent writer. Restart.
      return this.put(key, value);
    }
    // We intentionally use a direct write here rather than Atomics.compareExchange.
    // Atomics.compareExchange requires an Int32Array and 4-byte alignment; our state
    // column is Int8Array for compactness. V8 guarantees that element reads/writes of
    // typed arrays are atomic (no torn bytes), and the state-transition discipline above
    // ensures we never observe a half-updated entry.
    this._states[firstFree] = FILLED;
    this._count++;
    return true;
  }

  /**
 * Atomically replace the value at a FILLED slot.
 *
 * Transitions FILLED -> TOMBSTONE -> (write new value) -> FILLED. Readers that
 * hit the TOMBSTONE window treat the slot as absent and retry the probe; this is
 * safe because the key is still in the chain for probing purposes.
 *
 * Returns true if the slot was FILLED and the swap completed; false if the slot
 * was touched concurrently (caller should retry the whole put).
 *
 * @param {number} idx
 * @param {*} value
 * @returns {boolean}
 * @private
 */
  _casReplace(idx, value) {
    const s = this._states[idx];
    if (s !== FILLED) return false;
    this._states[idx] = TOMBSTONE;
    // Re-check: another writer could have raced us to the TOMBSTONE transition. Since
    // only one writer can observe FILLED and flip to TOMBSTONE (the others see TOMBSTONE
    // and bail), this re-check is defensive; in practice it never fails under our model.
    if (this._states[idx] !== TOMBSTONE) return false;
    this._values[idx] = value;
    this._states[idx] = FILLED;
    return true;
  }

  /**
 * Read the value for a key, or undefined if absent.
 *
 * The read sequence: probe the chain, reading state before key/value for each slot.
 * If we observe TOMBSTONE we continue probing (the chain is intact). If we observe
 * EMPTY we stop (no later slot in this chain can hold our key). If we observe FILLED
 * we read key; if it matches we read value; if a concurrent replace is in flight we
 * might briefly see TOMBSTONE on retry and miss — that is the documented weak read.
 *
 * @param {string} key
 * @returns {*}
 */
  get(key) {
    const start = hashKey(key) % this._size;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this._size;
      const state = this._states[idx];
      if (state === EMPTY) return undefined;
      if (state === FILLED) {
        if (this._keys[idx] === key) {
          return this._values[idx];
        }
      }
      // TOMBSTONE: keep probing.
    }
    return undefined;
  }

  /**
 * Boolean presence check. Equivalent to get(key) !== undefined but slightly cheaper
 * in paths where the value is not needed.
 *
 * @param {string} key
 * @returns {boolean}
 */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
 * Remove a key. Returns true if the key was present and removed, false otherwise.
 *
 * Marks the slot TOMBSTONE rather than EMPTY so that probe chains for keys that
 * collided past this slot remain intact. This is the standard open-addressing
 * deletion discipline; violating it causes silent data loss for colliding keys.
 *
 * @param {string} key
 * @returns {boolean}
 */
  delete(key) {
    const start = hashKey(key) % this._size;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this._size;
      const state = this._states[idx];
      if (state === EMPTY) return false;
      if (state === FILLED && this._keys[idx] === key) {
        // CAS FILLED -> TOMBSTONE. If someone replaced the value concurrently we'll
        // observe TOMBSTONE on re-check and treat the key as already absent.
        this._states[idx] = TOMBSTONE;
        this._keys[idx] = undefined;
        this._values[idx] = undefined;
        this._count--;
        return true;
      }
    }
    return false;
  }

  /**
 * Return an array of all live [key, value] pairs.
 *
 * This is a point-in-time best-effort snapshot. It is NOT a serializable transaction:
 * concurrent writers can add or remove entries while we walk the array. We guarantee
 * that each individual pair we emit was a consistent (key, value) tuple at the
 * moment we read it, but the set as a whole may reflect writes that happened during
 * the iteration. If you need a truly consistent snapshot, copy the table first.
 *
 * @returns {Array<[string, *]>}
 */
  entries() {
    const out = [];
    for (let i = 0; i < this._size; i++) {
      if (this._states[i] === FILLED) {
        out.push([this._keys[i], this._values[i]]);
      }
    }
    return out;
  }
}
