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
  ["live-music", /\b(concert|live music|live band|symphony|orchestra|recital|jazz|rock band|folk music|bluegrass|acoustic|open mic|singer-songwriter|chamber music|chorus|choir)\b/i],
  ["theater", /\b(play|theater|theatre|musical|drama|broadway|opera|playwright|monologue)\b/i],
  ["film", /\b(film|movie|screening|cinema|documentary)\b/i],
  ["art-gallery", /\b(exhibit|exhibition|gallery|art show|opening reception|paintings?|sculpture|art walk|mural)\b/i],
  ["museum", /\b(museum|history center|historical society|heritage)\b/i],
  ["festival", /\b(festival|fair|carnival|fest\b)\b/i],
  ["lecture", /\b(lecture|talk|panel|forum|book reading|author|book club|discussion|symposium)\b/i],
  ["workshop", /\b(workshop|class\b|seminar|tutorial|how to|hands-on|cooking class|art class)\b/i],
  ["family", /\b(kids|family|children|storytime|story time|toddler|teens?|youth|baby)\b/i],
  ["food-drink", /\b(food|drink|tasting|wine|beer|brewery|brunch|dinner|pancake|coffee|tea\b)\b/i],
  ["fitness", /\b(yoga|fitness|run\b|race\b|hike|walk\b|workout|pilates|tai chi|meditation)\b/i],
  ["sale", /\b(yard sale|plant sale|bake sale|fundraiser|book sale|tag sale|garage sale|craft fair|holiday market)\b/i],
  ["community", /\b(town hall|volunteer|cleanup|clean-up|meeting\b|forum|civic|pride|memorial day|veterans|town meeting)\b/i],
];

export function categorize(title: string, description?: string): EventType {
  const text = `${title} ${description ?? ""}`;
  for (const [type, pattern] of RULES) {
    if (pattern.test(text)) return type;
  }
  return "other";
}
