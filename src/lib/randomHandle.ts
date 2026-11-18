// Friendly random handles shown as input placeholders. They use the same
// name style as the "Suggest" picks — PascalCase first name plus a last
// name or a short number ("SayedRafi", "Rafi001") — from the same lists,
// so a placeholder and a suggestion always look alike.
// Output always satisfies the handle rules the server enforces on register:
// 1 to 32 letters, numbers, `_` or `-`.
import { FIRST_NAMES, LAST_NAMES } from "./share/handleSuggest";

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)];

/** Returns a handle like `SayedRafi` or `Rafi001`. `random` is injectable for tests. */
export function randomHandle(random: () => number = Math.random): string {
  const first = pick(FIRST_NAMES, random);
  if (random() < 0.5) {
    // First + last, like "SayedRafi" — skip a first==last echo ("RafiRafi").
    const others = LAST_NAMES.filter((name) => name !== first);
    return (
      first +
      (others.length > 0 ? pick(others, random) : pick(LAST_NAMES, random))
    );
  }
  // First + a short number, like "Rafi001".
  const number = Math.floor(random() * 90) + 10; // two digits, 10 to 99
  return `${first}${number}`;
}
