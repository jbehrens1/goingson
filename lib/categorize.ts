export const EVENT_TYPES = [
  "live-music",
  "comedy",
  "theater",
  "film",
  "art-gallery",
  "museum",
  "lecture",
  "workshop",
  "festival",
  "family",
  "food-drink",
  "fitness",
  "mahjong",
  "cards",
  "community",
  "sale",
  "other",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const TYPE_LABELS: Record<EventType, string> = {
  "live-music": "Live music",
  comedy: "Comedy",
  theater: "Theater",
  film: "Film",
  "art-gallery": "Art / gallery",
  museum: "Museum",
  lecture: "Lecture / talk",
  workshop: "Workshop / class",
  festival: "Festival / fair",
  family: "Family / kids",
  "food-drink": "Food & drink",
  fitness: "Fitness / outdoor",
  mahjong: "Mah Jongg",
  cards: "Cards",
  community: "Community",
  sale: "Sale / fundraiser",
  other: "Other",
};

// Order matters: more specific patterns first. The categorizer scans title +
// description, so broad single-word keywords (especially common verbs like
// "play") cause false positives. Prefer multi-word phrases or unambiguous
// nouns. When a keyword is genuinely ambiguous (e.g. "musical" — could be the
// adjective in "musical comedy" or describe a stage musical), place its
// category to win the tie that matters most.
const RULES: Array<[EventType, RegExp]> = [
  // Mahjong first so beginner sessions don't drift into workshop.
  ["mahjong", /\b(mah[- ]?jongg?|mahjong)\b/i],
  // Cards next: other card games — keep separate from mahjong since the user
  // splits them as distinct categories on the events page. Picked before
  // workshop/community/family so library card-night events don't dilute.
  ["cards", /\b(canasta|poker|bridge club|bridge night|gin rummy|cribbage|euchre|pinochle|hearts night|spades night|blackjack|card game|card night|playing cards)\b/i],
  // Comedy is tightened to require a comedy-specific phrase, not bare
  // "comedy" (which collides with "musical comedy", "romantic comedy",
  // "comedy of errors" in theater descriptions).
  ["comedy", /\b(stand-?up|comedian|improv|comedy show|comedy night|comedy club|comedy hour|sketch comedy)\b/i],
  ["live-music", /\b(concert|live music|live band|symphony|orchestra|recital|jazz|rock band|folk music|bluegrass|acoustic|open mic|singer-songwriter|chamber music|chorus|choir|karaoke|dj set|dj night|tribute band|cover band|tribute to|the .+ tribute|sing[- ]?a[- ]?long|ukulele|music & arts)\b/i],
  // Film before theater so "Movie Matinee: <Musical>" lands in film rather
  // than getting pulled into theater by a "Musical" tag in the description.
  ["film", /\b(films?|movies?|screenings?|cinema|documentary|movie matinee|film matinee)\b/i],
  // Theater drops bare "play" (too often a verb — "play games", "play feud").
  // Keeps multi-word play forms + the unambiguous theater nouns.
  ["theater", /\b(stage play|one-act|play by|the play\b|theater|theatre|musicals?|drama|broadway|opera|playwright|monologue)\b/i],
  ["art-gallery", /\b(exhibit|exhibition|gallery|art show|opening reception|paintings?|sculpture|art walk|mural)\b/i],
  ["museum", /\b(museum|history center|historical society|heritage)\b/i],
  ["festival", /\b(festival|fair|carnival|fest\b)\b/i],
  ["lecture", /\b(lectures?|talks?|panels?|forum|book reading|book signing|author|book club|discussions?|symposium|presentations?)\b/i],
  ["workshop", /\b(workshops?|class(es)?\b|seminar|tutorial|how to|hands-on|cooking class|art class|language lessons?|spanish lessons?|french lessons?|mentorship|knitting|crochet|crocheting|quilting|sewing|needlepoint|junk journal|stem-related|stem program|sand art)\b/i],
  ["family", /\b(kids|family|children|storytime|story time|toddler|teens?|youth|baby|family feud)\b/i],
  ["food-drink", /\b(food|drink|tasting|wine|beer|brewery|brunch|dinner|supper|pancake|coffee|tea\b|spaghetti|cookout|barbecue|bbq)\b/i],
  ["fitness", /\b(yoga|fitness|runs?\b|race\b|hikes?\b|walks?\b|workout|pilates|tai chi|meditation|zumba|barre|spin class|cycling|pickleball|tennis tournament|golf tournament|campout|surf fishing|fishing tournament|birding)\b/i],
  ["sale", /\b(yard sale|plant sale|bake sale|fundraiser|book sale|tag sale|garage sale|craft fair|holiday market|donations?|recycling event|rummage sale|raffle|sweepstakes)\b/i],
  ["community", /\b(town hall|volunteer|cleanup|clean-up|meeting\b|forum|civic|pride|memorial day|veterans|town meeting|trivia|bingo|game night|worship|sunday service|sabbath|study group|conversational|conversation club|french club|spanish club|open house|drop[- ]in|social group|senior center|celebrates|celebration|community supper|community|prayer|religious service|mass\b|sermon|rosary|caregiver support)\b/i],
];

export function categorize(title: string, description?: string): EventType {
  const text = `${title} ${description ?? ""}`;
  for (const [type, pattern] of RULES) {
    if (pattern.test(text)) return type;
  }
  return "other";
}

/** Map a single platform-provided category/tag string to one of our EventTypes.
 *  Returns undefined if no confident mapping exists (so the caller can fall
 *  through to title-based categorization).
 *
 *  This is used for tags that platforms attach to events themselves — iCal
 *  CATEGORIES, Tribe term taxonomies, Squarespace tags, Eventbrite categories.
 *  Match is case-insensitive and tolerant of pluralization. */
function platformTagToType(raw: string): EventType | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return undefined;

  // Exact / prefix matches against common platform vocabularies.
  // Order: most specific first. Theater/Comedy/Film should win over the
  // broader "Performances" → live-music for theater plays and comedy shows
  // when both terms appear on the same event (e.g. TCAN tags a play with
  // event-type=Performances AND xdgp_genre=Theater).
  if (/^(stand-?up|comedy|comedian|improv)\b/.test(t)) return "comedy";
  if (/^(theat(er|re)|plays?|musical|drama|opera|broadway)\b/.test(t)) return "theater";
  if (/^(films?|movies?|screenings?|cinema|documentary|animation|sci-?fi|silent film|cult classics?|oscar shorts?|big screen classics?|stage on screen|rock on film)\b/.test(t)) return "film";
  if (/^(concerts?|music|live music|live performances?|performances?|jazz|rock|pop|country|folk|bluegrass|blues|acoustic|singer-?songwriter|chamber music|chorus|choir|recital|band|a cappella|classical|open mic|instrumental|r ?& ?b|rb)\b/.test(t)) return "live-music";
  if (/^(art|gallery|exhibits?|exhibitions?|paintings?|sculpture|art show)\b/.test(t)) return "art-gallery";
  if (/^(museums?|history|historical|heritage)\b/.test(t)) return "museum";
  if (/^(festivals?|fairs?|carnival)\b/.test(t)) return "festival";
  if (/^(lectures?|talks?|panels?|author|book reading|book signing|discussion|symposium)\b/.test(t)) return "lecture";
  if (/^(workshops?|classes|seminars?|tutorial|hands-on|education(al)?)\b/.test(t)) return "workshop";
  if (/^(kids|family|children|youth|teens?|storytime|story time)\b/.test(t)) return "family";
  if (/^(food|drink|wine|beer|brewery|tasting|brunch|dinner|culinary)\b/.test(t)) return "food-drink";
  if (/^(yoga|fitness|outdoors?|hike|hiking|running|race|workout|pilates|zumba|barre|meditation|tai chi)\b/.test(t)) return "fitness";
  if (/^(mahjongg?|mah[- ]?jongg?)\b/.test(t)) return "mahjong";
  if (/^(cards?|card games?|canasta|poker|bridge|cribbage|euchre|pinochle)\b/.test(t)) return "cards";
  if (/^(community|civic|volunteer|town hall|trivia|bingo|game night|religious services?|worship|prayer)\b/.test(t)) return "community";
  if (/^(sales?|fundraisers?|craft fair|holiday market|tag sale|yard sale|bake sale|book sale)\b/.test(t)) return "sale";

  return undefined;
}

/** Aggregate map across a list of platform tags. First confident hit wins.
 *  Returns undefined if no tag maps confidently. */
export function typeFromPlatformCategories(
  categories: readonly string[] | undefined | null,
): EventType | undefined {
  if (!categories?.length) return undefined;
  for (const c of categories) {
    if (typeof c !== "string") continue;
    const t = platformTagToType(c);
    if (t) return t;
  }
  return undefined;
}
