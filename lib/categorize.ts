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
  community: "Community",
  sale: "Sale / fundraiser",
  other: "Other",
};

// Order matters: more specific patterns first.
const RULES: Array<[EventType, RegExp]> = [
  // Match before workshop/lecture/etc. so guided-play and beginner sessions
  // still land in the dedicated mahjong category.
  ["mahjong", /\b(mah[- ]?jongg?|mahjong)\b/i],
  ["comedy", /\b(stand-?up|comedian|comedy|improv)\b/i],
  ["live-music", /\b(concert|live music|live band|symphony|orchestra|recital|jazz|rock band|folk music|bluegrass|acoustic|open mic|singer-songwriter|chamber music|chorus|choir|karaoke|dj set|dj night|tribute band|cover band|tribute to|sing[- ]?a[- ]?long|ukulele)\b/i],
  ["theater", /\b(play|theater|theatre|musical|drama|broadway|opera|playwright|monologue)\b/i],
  ["film", /\b(film|movie|screening|cinema|documentary)\b/i],
  ["art-gallery", /\b(exhibit|exhibition|gallery|art show|opening reception|paintings?|sculpture|art walk|mural)\b/i],
  ["museum", /\b(museum|history center|historical society|heritage)\b/i],
  ["festival", /\b(festival|fair|carnival|fest\b)\b/i],
  ["lecture", /\b(lecture|talk|panel|forum|book reading|book signing|author|book club|discussion|symposium)\b/i],
  ["workshop", /\b(workshops?|class(es)?\b|seminar|tutorial|how to|hands-on|cooking class|art class|language lessons?|spanish lessons?|french lessons?)\b/i],
  ["family", /\b(kids|family|children|storytime|story time|toddler|teens?|youth|baby)\b/i],
  ["food-drink", /\b(food|drink|tasting|wine|beer|brewery|brunch|dinner|pancake|coffee|tea\b)\b/i],
  ["fitness", /\b(yoga|fitness|runs?\b|race\b|hikes?\b|walks?\b|workout|pilates|tai chi|meditation|zumba|barre|spin class|cycling)\b/i],
  ["sale", /\b(yard sale|plant sale|bake sale|fundraiser|book sale|tag sale|garage sale|craft fair|holiday market)\b/i],
  ["community", /\b(town hall|volunteer|cleanup|clean-up|meeting\b|forum|civic|pride|memorial day|veterans|town meeting|trivia|bingo|game night|worship|sunday service|sabbath|study group|conversational|conversation club|french club|spanish club)\b/i],
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
  if (/^(community|civic|volunteer|town hall|trivia|bingo|game night)\b/.test(t)) return "community";
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
