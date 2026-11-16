// Friendly random handles shown as input placeholders, e.g. "swift_otter42".
// Output always satisfies the handle rules the server enforces on register:
// 1 to 32 letters, numbers, `_` or `-`.

const ADJECTIVES = [
  "swift",
  "quiet",
  "brave",
  "clever",
  "bright",
  "lucky",
  "nimble",
  "steady",
  "sunny",
  "crisp",
];

const NOUNS = [
  "ninja",
  "otter",
  "falcon",
  "panda",
  "tiger",
  "heron",
  "maple",
  "comet",
  "badger",
  "sparrow",
];

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];

/** Returns a handle like `swift_otter42`. `random` is injectable for tests. */
export function randomHandle(random: () => number = Math.random): string {
  const number = Math.floor(random() * 90) + 10; // two digits, 10 to 99
  return `${pick(ADJECTIVES, random)}_${pick(NOUNS, random)}${number}`;
}
