/**
 * The fuzz generator's only source of randomness. xorshift32: 32 bits of
 * state, one multiply-free step, and a period long enough for 200 cases by a
 * wide margin. It is chosen for being reproducible in four lines, not for
 * statistical quality — nothing here is cryptography or Monte Carlo.
 *
 * Every draw in the generator comes through one instance. The platform's
 * built-in random source is banned outright, and `test/fuzz-rng.test.ts`
 * enforces that against this file's raw text — which is why the ban is
 * described here rather than named: the test forbids the name anywhere in the
 * file, comments included. A single unseeded draw would make `cases.json`
 * irreproducible and turn `gate:fuzz`'s byte-identity check into an
 * unexplainable failure.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    // xorshift32 is stuck at zero forever, so a zero seed is not allowed to
    // arrive silently.
    const normalised = seed >>> 0;
    this.#state = normalised === 0 ? 0x9e37_79b9 : normalised;
  }

  /** The next 32-bit unsigned integer. */
  u32(): number {
    let x = this.#state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.#state = x;
    return x;
  }

  /** Uniform in [minInclusive, maxInclusive]. Both ends are reachable. */
  int(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new Error(`empty range [${minInclusive}, ${maxInclusive}]`);
    }
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + (this.u32() % span);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher–Yates on a copy: the caller's array is never reordered. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  chance(probability: number): boolean {
    return this.u32() / 0x1_0000_0000 < probability;
  }
}
