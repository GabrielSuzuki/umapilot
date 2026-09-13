/**
 * Which turn of the career is this?
 *
 * The reader cannot read the calendar -- that needs letter templates and the
 * corpus only labels numbers -- so the career turn has to come from somewhere
 * else. It does: the concerts sit at fixed turns, and the screen prints how
 * many turns until the next one.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS. `turnsLeft` on the screen counts down
 * to the next GOAL, not to the end of the career, and the two look alike. Using
 * it as the career turn would be a plausible wrong answer; refusing to set the
 * turn at all, which is what the scan did first, is a quiet wrong answer -- the
 * planner then believes it is on turn 1 with 71 turns in hand, every target
 * reads "on track", and P(goal) comes back 100%. Measured on a real frame: the
 * player was on turn 34 with 38 turns left and was being advised as though he
 * had 71.
 */

/** Turns on which a Grand Concert happens. Five, fixed, twelve apart. */
export const CONCERT_TURNS = [24, 36, 48, 60, 72] as const;

export const CAREER_TURNS = 72;

/**
 * Every turn consistent with "the next concert is N turns away".
 *
 * Ambiguous by construction: the concerts are evenly spaced, so a countdown of
 * 2 means turn 22, 34, 46, 58 or 70 and nothing on the screen separates them.
 * That ambiguity is real and is returned rather than guessed at -- the caller
 * resolves it from what it already knows, or asks.
 */
export function turnCandidates(concertIn: number): number[] {
  return CONCERT_TURNS
    .map((c) => c - concertIn)
    .filter((t) => t >= 1 && t <= CAREER_TURNS);
}

/**
 * Resolve the ambiguity against a turn already known.
 *
 * The candidates are twelve apart, so anything within six turns of the last
 * known position picks out exactly one. A capture that has been running since
 * the previous sync is always well inside that, which is why one answer at the
 * start is enough for a whole career.
 *
 * Returns null when there is no prior and the choice is genuinely open.
 */
export function resolveTurn(concertIn: number, known: number | null): number | null {
  const candidates = turnCandidates(concertIn);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  if (known === null) return null;
  // THE EARLIEST CANDIDATE THAT IS NOT BEHIND US, not the nearest one.
  //
  // Nearest is the obvious rule and it rewinds the career. From turn 50 with a
  // countdown of 2 the candidates are 46 and 58; 46 is closer and is in the
  // past, so a career that had simply run on for a while would be dragged
  // backwards by twelve turns. A career only moves forward, so the question is
  // not "which is closest" but "which is the next one that could still be now".
  //
  // The one-turn slack absorbs a stale known value without opening the door to
  // a genuine rewind.
  const forward = candidates.filter((c) => c >= known - 1).sort((a, b) => a - b);
  return forward[0] ?? null;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
const YEARS = ["Junior", "Classic", "Senior"] as const;

/**
 * The calendar label the game would print for a turn.
 *
 * Used to let a player disambiguate by recognising their own screen rather than
 * by doing arithmetic: "turn 34" means nothing to them, "Classic Late May" is
 * written at the top of the game.
 */
export function calendarFor(turn: number): string {
  const i = turn - 1;
  const year = YEARS[Math.floor(i / 24)] ?? "Senior";
  const month = MONTHS[Math.floor((i % 24) / 2)] ?? "Dec";
  return `${year} ${i % 2 === 0 ? "Early" : "Late"} ${month}`;
}

/**
 * A calendar label back to a turn number -- the inverse of `calendarFor`.
 *
 * IT EXISTS BECAUSE A MISSING NUMBER COST A WRONG CLAIM. The stat-cap finding
 * was written up as "both steps land on the first turn of a new year" on the
 * strength of the label reading "Early Apr", in a codebase whose whole business
 * is turning what the screen says into numbers. Classic Early Apr is turn 31;
 * the first turn of Classic Year is turn 25; frames at turns 25 through 30 said
 * so plainly and were never asked. Three copies of this function already existed
 * in gitignored diagnostics, so the arithmetic was available and just not to
 * hand.
 *
 * Returns null for a label with no date in it, of which the corpus has one that
 * matters: "Junior Year Pre-Debut". Callers anchor those separately -- and a
 * caller that quietly treats null as "no calendar field" is the bug that made a
 * diagnostic measure 45 turns while reporting 55.
 */
export function calendarTurn(label: string): number | null {
  const m = /(Junior|Classic|Senior)\s+(?:Year\s+)?(Early|Late)\s+([A-Za-z]{3})/.exec(label);
  if (!m) return null;
  const year = YEARS.indexOf(m[1] as (typeof YEARS)[number]);
  const month = MONTHS.indexOf(m[3] as (typeof MONTHS)[number]);
  if (year < 0 || month < 0) return null;
  return year * 24 + month * 2 + (m[2] === "Early" ? 1 : 2);
}
