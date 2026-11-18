/**
 * Generates friendly, person-shaped handle suggestions for the register forms.
 *
 * The server accepts handles of 1-32 letters, numbers, "_" or "-". The
 * suggestions here are readable name-style handles in the same shape users
 * already recognise: a first name plus a last name ("SayedRafi",
 * "FariyaLaboni") or a first name plus a short number ("Rafi001").
 */

export const FIRST_NAMES = [
  "Sayed",
  "Fariya",
  "Rafi",
  "Aisha",
  "Karim",
  "Nadia",
  "Tariq",
  "Meera",
  "Hasan",
  "Lina",
  "Omar",
  "Sara",
  "Yusuf",
  "Priya",
  "Zain",
  "Maya",
] as const;

export const LAST_NAMES = [
  "Rafi",
  "Laboni",
  "Ahmed",
  "Karim",
  "Hossain",
  "Islam",
  "Rahman",
  "Khan",
  "Chowdhury",
  "Sultana",
  "Haque",
  "Ali",
  "Das",
  "Mehta",
  "Rai",
  "Nath",
] as const;

const MAX_LENGTH = 32;

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** "004" for 4, "012" for 12 — the trailing-number style of "Rafi001". */
function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** A unique batch of suggested handles, never repeating one in the same batch. */
export function suggestHandles(count = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (candidate: string) => {
    if (out.length >= count) return;
    const handle =
      candidate.length > MAX_LENGTH
        ? candidate.slice(0, MAX_LENGTH)
        : candidate;
    if (seen.has(handle)) return;
    seen.add(handle);
    out.push(handle);
  };

  while (out.length < count) {
    const first = pick(FIRST_NAMES);
    const roll = Math.random();
    if (roll < 0.55) {
      // First + last, like "SayedRafi" — skip a first==last echo ("RafiRafi").
      const others = LAST_NAMES.filter((name) => name !== first);
      const last = others.length > 0 ? pick(others) : pick(LAST_NAMES);
      push(first + last);
    } else if (roll < 0.8) {
      // First + zero-padded number, like "Rafi001".
      push(first + pad3(Math.floor(Math.random() * 1000)));
    } else {
      // First + a short plain number.
      push(first + String(Math.floor(Math.random() * 90) + 10));
    }
  }

  return out;
}
