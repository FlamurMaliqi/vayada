export interface AmenityCategory {
  name: string;
  items: string[];
}

export interface ParsedAmenityMatch {
  amenity: string;
  category: string;
  // The raw line from the pasted list this matched against.
  original: string;
  // 'exact'  — case-insensitive match against a canonical amenity name
  // 'alias'  — match against a known OTA-vocabulary alias
  // 'fuzzy'  — best-effort similarity match (auto-selected but flagged for review)
  source: "exact" | "alias" | "fuzzy";
}

export interface ParsedAmenitiesResult {
  matched: ParsedAmenityMatch[];
  unmatched: string[];
}

// Maps Booking.com (and similar OTA) amenity vocabulary to our canonical labels.
// Keys are normalized (lowercase, trimmed) — see normalize().
const ALIASES: Record<string, string> = {
  // Internet & Tech
  desk: "Work desk",
  "work desk": "Work desk",
  "laptop friendly workspace": "Laptop-friendly workspace",
  "streaming service": "Netflix / Streaming",
  "streaming service like netflix": "Netflix / Streaming",
  netflix: "Netflix / Streaming",
  tv: "Flat-screen TV",
  "cable channels": "Flat-screen TV",
  "satellite channels": "Flat-screen TV",
  "pay per view channels": "Flat-screen TV",
  wifi: "Free WiFi",
  "wi fi": "Free WiFi",
  "free wifi": "Free WiFi",
  internet: "Free WiFi",

  // Kitchen
  kitchen: "Kitchenware",
  kitchenette: "Kitchenware",
  "tea coffee maker": "Electric kettle",
  "coffee machine": "Electric kettle",
  kettle: "Electric kettle",
  oven: "Stovetop",
  cooker: "Stovetop",
  fridge: "Refrigerator",
  "mini bar": "Minibar",

  // Bathroom
  "private bathroom": "Private Bathroom",
  hairdryer: "Hairdryer",
  "hair dryer": "Hairdryer",
  "free toiletries": "Free toiletries",
  toiletries: "Free toiletries",
  bathtub: "Bathtub",
  "spa tub": "Hot Tub",
  "hot tub": "Hot Tub",

  // Climate & Comfort
  "air conditioning": "Air conditioning",
  "air conditioner": "Air conditioning",
  ac: "Air conditioning",
  "single room air conditioning for guest accommodation": "Air conditioning",

  // Bedroom
  linen: "Bed linen",
  "bed linens": "Bed linen",
  "bed linen": "Bed linen",
  "blackout curtains": "Blackout curtains",
  "extra pillows": "Extra pillows",
  "wardrobe or closet": "Wardrobe",
  wardrobe: "Wardrobe",
  closet: "Wardrobe",

  // Laundry
  "washing machine": "Washing machine",
  "tumble dryer": "Dryer",
  "clothes dryer": "Dryer",
  iron: "Iron/Ironing board",
  "ironing facilities": "Iron/Ironing board",
  "ironing board": "Iron/Ironing board",
  "drying rack for clothing": "Clothes rack",
  "clothes rack": "Clothes rack",

  // Safety & Access
  safe: "Safe",
  "safety deposit box": "Safe",
  "in room safe": "Safe",
  "24 hour security": "24hr Security",
  "24hr security": "24hr Security",
  security: "24hr Security",
  "smoke alarms": "Smoke detector",
  "smoke detector": "Smoke detector",
  "first aid kit": "First aid kit",
  "fire extinguishers": "Fire extinguisher",
  "fire extinguisher": "Fire extinguisher",

  // Services
  "room service": "Room service",
  "daily housekeeping": "Daily housekeeping",
  "daily maid service": "Daily housekeeping",
  housekeeping: "Daily housekeeping",
  "concierge service": "Concierge",
  concierge: "Concierge",
  "free parking": "Parking",
  "private parking": "Parking",
  parking: "Parking",
  "non smoking rooms": "Non-smoking",
  "non smoking": "Non-smoking",
  "adults only": "Adults-Only",
};

// Strips checkmarks, bullets, leading punctuation, and parenthetical asides;
// lowercases; collapses whitespace; removes non-word chars except spaces.
function normalize(raw: string): string {
  return raw
    .replace(/[✓✔✅•●◦\-\*•·]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Classic Levenshtein edit distance (iterative, single-row DP).
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1, // deletion
        prev[j - 1] + 1, // insertion
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}

// 0..1 similarity blending edit-distance, token-set overlap (Jaccard), and a
// "all tokens of the shorter string appear in the longer" containment boost.
// Catches typos, spacing differences, and minor word-order variation.
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const levSim = 1 - levenshtein(a, b) / Math.max(a.length, b.length);

  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  let inter = 0;
  ta.forEach((t) => {
    if (tb.has(t)) inter++;
  });
  const union = ta.size + tb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;

  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let allContained = short.size > 0;
  short.forEach((t) => {
    if (!long.has(t)) allContained = false;
  });
  const containment = allContained ? 0.85 : 0;

  return Math.max(levSim, jaccard, containment);
}

// Inputs shorter than this skip fuzzy matching — too few characters to judge
// similarity without noisy false positives (exact/alias still apply).
const MIN_FUZZY_LEN = 4;
// Minimum blended similarity to accept a fuzzy match.
const FUZZY_THRESHOLD = 0.74;

export function parseBookingAmenities(
  input: string,
  categories: AmenityCategory[],
): ParsedAmenitiesResult {
  // Build a normalized → canonical lookup from the canonical list itself,
  // so exact (case-insensitive) matches always win.
  const canonicalByNorm = new Map<string, { amenity: string; category: string }>();
  for (const cat of categories) {
    for (const item of cat.items) {
      canonicalByNorm.set(normalize(item), { amenity: item, category: cat.name });
    }
  }

  // Reverse lookup canonical → category, used for alias and fuzzy hits.
  const categoryFor = new Map<string, string>();
  for (const cat of categories) {
    for (const item of cat.items) categoryFor.set(item, cat.name);
  }

  // Fuzzy candidate index: every canonical name and every alias key, each
  // mapped back to its canonical amenity + category.
  const fuzzyCandidates: { norm: string; amenity: string; category: string }[] = [];
  for (const cat of categories) {
    for (const item of cat.items) {
      fuzzyCandidates.push({ norm: normalize(item), amenity: item, category: cat.name });
    }
  }
  for (const [aliasKey, canonical] of Object.entries(ALIASES)) {
    const category = categoryFor.get(canonical);
    if (category) fuzzyCandidates.push({ norm: aliasKey, amenity: canonical, category });
  }

  const matched: ParsedAmenityMatch[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  const lines = input
    .split(/\r?\n|;|,(?=\s*[A-Z])/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const norm = normalize(line);
    if (!norm) continue;

    const cleaned = line.replace(/^[✓✔✅•●◦\-\*•·\s]+/, "").trim();

    let canonical: string | undefined;
    let category: string | undefined;
    let source: ParsedAmenityMatch["source"] | undefined;

    const direct = canonicalByNorm.get(norm);
    if (direct) {
      canonical = direct.amenity;
      category = direct.category;
      source = "exact";
    } else if (ALIASES[norm]) {
      canonical = ALIASES[norm];
      category = categoryFor.get(canonical);
      source = "alias";
    } else if (norm.length >= MIN_FUZZY_LEN) {
      let best: { amenity: string; category: string; score: number } | null = null;
      for (const cand of fuzzyCandidates) {
        const score = similarity(norm, cand.norm);
        if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
          best = { amenity: cand.amenity, category: cand.category, score };
        }
      }
      if (best) {
        canonical = best.amenity;
        category = best.category;
        source = "fuzzy";
      }
    }

    if (canonical && category && source) {
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      matched.push({ amenity: canonical, category, original: cleaned || line, source });
    } else if (cleaned) {
      // Preserve the original line (cleaned of leading checkmarks) as the unmatched label.
      unmatched.push(cleaned);
    }
  }

  return { matched, unmatched };
}
