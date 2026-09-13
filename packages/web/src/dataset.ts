/**
 * Load the extracted dataset the engine needs.
 *
 * The generated JSON is gitignored on purpose -- it comes from the player's own
 * `master.mdb` and is theirs, not the repo's. So this resolves it at runtime
 * rather than importing a fixed filename, and says plainly when it is missing
 * instead of failing with a module error.
 *
 * `grand-concert.latest.json` is a pointer file carrying the hashed name of the
 * real dataset, which is how the extractor versions its output.
 */
import type { GrandConcertDataset } from "../../data/src/types";

const generated = import.meta.glob("../../data/generated/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

function pick(prefix: string): unknown | null {
  const latest = generated[`../../data/generated/${prefix}.latest.json`] as
    | { ref?: string } | undefined;
  if (latest?.ref) {
    const hit = generated[`../../data/generated/${latest.ref}`];
    if (hit) return hit;
  }
  // Fall back to any hashed file, so a half-finished extract still renders.
  const any = Object.entries(generated).find(
    ([k]) => k.includes(`/${prefix}.`) && !k.includes("latest"),
  );
  return any ? any[1] : null;
}

/** One support card as the extractor emits it: effects tabled by card level. */
export interface SupportCardRecord {
  id: number;
  name: string;
  charaName?: string;
  rarity: string;
  kind: "stat" | "friend" | "group";
  stat: string | null;
  effects: Record<string, Record<string, number>>;
}

export interface Loaded {
  scenario: GrandConcertDataset;
  /**
   * Every support card in the player's own extract.
   *
   * The deck has been hardcoded to `examples/real-run.json` since the web app
   * existed, which means every recommendation has been computed against one
   * particular old career's deck. Which facilities can rainbow is a property of
   * the deck and is the largest single lever on what gets recommended, so that
   * was not a small approximation -- it was a wrong premise under a correct
   * calculation.
   */
  supportCards: SupportCardRecord[];
  sha: string;
}

export function loadDataset(): Loaded | { error: string } {
  const scenario = pick("grand-concert") as GrandConcertDataset | null;
  if (!scenario) {
    return {
      error:
        "No extracted dataset found in packages/data/generated. Run `npm run extract` " +
        "against your own master.mdb first — the dataset is your game data and is " +
        "deliberately not committed to this repo.",
    };
  }
  const cardFile = pick("support-cards") as { supportCards?: SupportCardRecord[] } | null;
  const supportCards = cardFile?.supportCards ?? [];

  const sha =
    (scenario as unknown as { source?: { sha256?: string } }).source?.sha256 ?? "unknown";
  return { scenario, supportCards, sha: sha.slice(0, 12) };
}
