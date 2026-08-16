#!/usr/bin/env node
'use strict';

/*
 * Build script for the Zanagrams-clone word list data assets.
 *
 * Generates:
 *   - static/zanagrams/data/common.js   (window.ZAN_COMMON = [...] lengths 4-7,
 *                                         window.ZAN_COMMON_LONG = [...] lengths 8-11)
 *   - static/zanagrams/data/dict.js     (window.ZAN_DICT_RAW = "word word ...",
 *                                         lengths 4-11, or 4-10 if capped for size)
 *
 * Sources:
 *   - Dictionary (validation list): "an-array-of-english-words" npm package
 *     (the ENABLE word list, public domain / MIT wrapper, ~275k words).
 *     https://github.com/words/an-array-of-english-words  (MIT)
 *   - Frequency ranking (to pick "common" words): "most-common-words-by-language"
 *     npm package, English resource file (MIT), a ranked list of the ~10,000
 *     most frequent English words.
 *     https://github.com/oprogramador/most-common-words-by-language (MIT)
 *
 * Both packages are installed as npm devDependencies with --no-save (not added
 * to package.json). If either package cannot be resolved at build time, this
 * script falls back to an embedded curated word list so the build always
 * succeeds deterministically offline.
 *
 * Usage:
 *   node scripts/build_zanagrams_wordlists.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'static', 'lettermelt', 'data');
const COMMON_OUT = path.join(OUT_DIR, 'common.js');
const DICT_OUT = path.join(OUT_DIR, 'dict.js');

const DICT_MIN_LEN = 4;
const DICT_MAX_LEN = 11;
const DICT_MAX_LEN_CAPPED = 10; // used if the full-length dict file would be too large
const DICT_SIZE_CAP_BYTES = 2.3 * 1024 * 1024; // ~2.3 MB

const COMMON_MIN_LEN = 4;
const COMMON_MAX_LEN = 7;
const COMMON_TARGET_MIN = 1500;
const COMMON_TARGET_MAX = 12000;

const COMMON_LONG_MIN_LEN = 8;
const COMMON_LONG_MAX_LEN = 11;
const COMMON_LONG_TARGET_MIN = 500;
const COMMON_LONG_TARGET_MAX = 4000;
// The frequency-ranked list thins out badly past its top few thousand
// entries at 8-11 letters (place names, brand names, adult/spam terms start
// dominating). Cap how deep we'll walk it for ZAN_COMMON_LONG specifically,
// trading list size (we land well within the 500-2000 target either way)
// for recognizability — see the build report for the tradeoff writeup.
const COMMON_LONG_MAX_FREQ_RANK = 3500;

/*
 * How "is this word common?" is decided.
 *
 * Spell-checker tiers are the wrong instrument for this: they rank "lath" in
 * an early tier and "gator" in a late one, which is the reverse of how often
 * anyone meets those words. Zipf frequency (log10 occurrences per billion
 * words) ranks them correctly, so it is the primary signal — see
 * scripts/dump_word_zipf.py for how the data is produced.
 *
 * The tiers still do one job frequency cannot: they exclude lowercase proper
 * nouns. "york", "german" and "henry" are all frequent, so a threshold alone
 * would make them required words; capping the tier drops them.
 */
const COMMON_MIN_ZIPF = 2.8;   // required words: lath 2.15 out, gator 3.19 in
const BASE_MIN_ZIPF = 3.6;     // the base word is the headline; hold it higher
const COMMON_TIER_MAX = 55;    // above this the graded lists are mostly names

// Easy mode runs the same generator over a smaller, friendlier vocabulary:
// every required word is one a casual player will recognise immediately.
const EASY_MIN_ZIPF = 3.6;
const EASY_BASE_MIN_ZIPF = 4.1;

const LOWER_ALPHA_RE = /^[a-z]+$/;

// ---------------------------------------------------------------------------
// Blocklist: offensive / slur terms filtered out of ZAN_COMMON (and, to be
// safe, out of the dictionary too). Kept short and generic on purpose.
// ---------------------------------------------------------------------------
const BLOCKLIST = new Set([
  'nigger', 'nigga', 'faggot', 'fag', 'dyke', 'chink', 'spic', 'kike',
  'gook', 'wetback', 'tranny', 'retard', 'retards', 'coon', 'coons',
  'cunt', 'whore', 'slut', 'rape', 'raped', 'raping', 'rapist',
  'nazi', 'nazis', 'molest', 'molested', 'molester',
  'negro', 'negros', 'negroes', 'jap', 'japs',
  // Not real English words / scraper artifacts that occasionally surface
  // near the tail of the frequency-ranked list.
  'verzeichnis', 'epinions', 'postposted',
]);

/*
 * Escape hatch: words forced into the required set regardless of frequency.
 * Frequency handles this correctly on its own now, so the list is empty; add
 * a word here if one ever needs promoting by hand.
 */
const PROMOTED_COMMON = new Set([]);

/*
 * Real words the graded spell-check lists simply do not carry, so the
 * proper-noun filter would drop them. Loanwords are the usual case: "nori"
 * and "noir" are ordinary English but appear in no tier. Kept playable as
 * bonus words (their frequency still decides whether they are required).
 *
 * A blanket rule cannot replace this list: the words missing from the tiers
 * are overwhelmingly proper nouns ("warsaw", "murray") and British spellings
 * ("colour", "realise"), which readmitting wholesale would be worse.
 */
const DICT_ALLOWLIST = new Set([
  'nori', 'noir', 'udon', 'sashimi', 'bento', 'gelato', 'panini', 'churro',
  'lychee', 'dojo',
]);

// Words on the shared profanity list that are perfectly ordinary in a word
// game and worth keeping playable.
const PROFANITY_ALLOWLIST = new Set(['escort', 'snatch', 'suck', 'sucker']);

// Endings appended to a blocked root that should also be blocked, so the list
// does not have to enumerate every form.
const BLOCK_SUFFIXES = ['s', 'es', 'y', 'ies', 'er', 'ers', 'ed', 'ing', 'ish'];

/**
 * Load the shared profanity/obscenity list (LDNOOBW via naughty-words) and
 * reduce it to single lowercase words. Returns an empty array if unavailable,
 * since the embedded lists below still cover the worst of it.
 */
function loadProfanityList() {
  const naughty = tryRequire('naughty-words');
  const list = naughty && Array.isArray(naughty.en) ? naughty.en : [];
  return list
    .map((w) => String(w).toLowerCase())
    .filter((w) => LOWER_ALPHA_RE.test(w) && w.length >= 3 && !PROFANITY_ALLOWLIST.has(w));
}

// Crude / sexual / otherwise mature words. These are blocked everywhere: not
// as required words and not as bonus words either, so tracing one is simply
// not a word.
const COMMON_ONLY_BLOCKLIST = new Set([
  'sex', 'sexy', 'sexual', 'porn', 'porno', 'nude', 'nudes', 'naked',
  'penis', 'vagina', 'nipple', 'nipples', 'breast', 'breasts', 'boob',
  'boobs', 'tit', 'tits', 'ass', 'asses', 'arse', 'anal', 'anus', 'butt',
  'butts', 'dick', 'dicks', 'cock', 'cocks', 'pussy', 'semen', 'sperm',
  'orgasm', 'erotic', 'erotica', 'hooker', 'stripper', 'condom', 'condoms',
  'shit', 'shits', 'piss', 'pissed', 'fuck', 'fucks', 'fucked', 'fucking',
  'bitch', 'bitches', 'bastard', 'damn', 'hell', 'crap', 'horny', 'kinky',
  'fetish', 'incest', 'pedo', 'viagra', 'heroin', 'cocaine', 'meth',
  'suicide', 'murder', 'murders', 'killer', 'killers', 'corpse', 'corpses',
  'hardcore', 'lesbians', 'phentermine', 'personals', 'gangbang', 'blowjobs',
  'gangbangs', 'blowjob',
  // Anatomy, bodily waste and vulgar slang the shared list misses.
  'turd', 'scrotum', 'bugger', 'prick', 'feces', 'faeces', 'urine', 'phallus',
  'jizz', 'schlong', 'pecker', 'wanker', 'tosser', 'arsehole', 'bollock',
  'minge', 'knacker', 'genital', 'genitals', 'genitalia', 'testicle',
  'testicles', 'uterus', 'nipples', 'buttock', 'buttocks', 'rectal',
  'sodomize', 'fondle', 'lewd', 'obscene', 'raunchy', 'skank', 'hussy',
  'harlot', 'floozy', 'strumpet', 'pimp', 'brothel', 'bordello',
]);

// ---------------------------------------------------------------------------
// Fallback curated common-word list, used only if the frequency package
// cannot be loaded. ~220 seed words across common lengths/topics; the script
// will still intersect this with the dictionary source it does find.
// ---------------------------------------------------------------------------
const FALLBACK_COMMON_WORDS = (
  'the of and to in is on that by this with you it not or be are from at ' +
  'as your all have new more an was we will home can us about if page my ' +
  'has search free but our one other do no information time they site he ' +
  'up may what which their news out use any there see only so his when ' +
  'contact here business who web also now help get view online first am ' +
  'been would how were me services some these click its like service x ' +
  'than find price date back top people had list name just over state ' +
  'year day into email two health world re next used go work last most ' +
  'products music buy data make them should product system post her city ' +
  'add policy number such please available copyright support message ' +
  'after best software then good video well where info rights public ' +
  'books high school through each links she review years order very ' +
  'privacy book items company read group need many user said does set ' +
  'under general research university january mail full map reviews ' +
  'program life know games way days management part could great united ' +
  'hotel real item international center must store travel comments made ' +
  'development report member details line terms before hotels did send ' +
  'right type because local those using results office education national ' +
  'car design take posted internet address community within states area ' +
  'want phone dvd shipping reserved subject between forum family long ' +
  'based code shows every county your st version water april own found ' +
  'game security both pages both card april play own found came still ' +
  'apple happy water animal small large green blue table chair house ' +
  'river ocean mountain forest garden flower plant fruit apple orange ' +
  'grape lemon melon peach mango bread cheese sugar spice salt pepper ' +
  'water juice coffee tea milk bread rice bean corn wheat flour egg meat ' +
  'fish chicken beef pork lamb soup salad candy sweet sour spicy hot cold ' +
  'warm cool wind rain snow sun moon star sky cloud storm thunder light ' +
  'dark bright shine shadow color paint brush paper pencil book story ' +
  'song music dance sing play run jump walk swim climb fly drive ride ' +
  'sleep dream wake laugh smile cry shout whisper speak listen hear see ' +
  'watch look feel touch smell taste think know learn teach study read ' +
  'write draw build make create design plan start stop finish begin end ' +
  'open close push pull carry hold drop throw catch kick punch hug kiss ' +
  'love hate like dislike want need wish hope fear worry trust doubt ' +
  'friend family mother father sister brother baby child kid adult ' +
  'teacher doctor nurse driver farmer artist writer singer dancer actor ' +
  'king queen prince princess knight castle dragon wizard witch ghost ' +
  'monster robot alien planet space rocket star galaxy moon earth ocean ' +
  'beach island mountain valley desert jungle forest cave river lake pond ' +
  'bridge road street path trail park field farm barn fence gate door ' +
  'window wall floor roof stair room kitchen bedroom bathroom garage ' +
  'yard garden pool fire smoke ash coal wood stone rock sand dust dirt ' +
  'mud clay glass metal iron steel gold silver copper brass wire chain ' +
  'rope string thread cloth cotton wool silk leather rubber plastic ' +
  'paper box bag basket bottle jar can cup bowl plate fork spoon knife ' +
  'pot pan oven stove sink fridge lamp clock watch phone camera radio ' +
  'television computer mouse keyboard screen button switch wire battery ' +
  'engine motor wheel tire brake pedal seat belt mirror horn light door ' +
  'ship boat plane train car truck bus bike cart wagon sled sleigh ' +
  'happy sad angry mad glad proud shy brave scared afraid calm nervous ' +
  'excited bored tired sleepy hungry thirsty sick well strong weak fast ' +
  'slow big small tall short wide narrow thick thin heavy light hard ' +
  'soft rough smooth sharp dull clean dirty wet dry full empty new old ' +
  'young ancient modern rich poor cheap costly easy hard simple complex'
).split(/\s+/);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryRequire(pkg) {
  try {
    return require(pkg);
  } catch (err) {
    return null;
  }
}

/**
 * wordlist-english groups words by how widely known they are: tier 10 is
 * everyday vocabulary, and each higher tier adds rarer words. Two properties
 * make it the right spine for this game:
 *
 *  - The low tiers are proper-noun free. "eric", "texas" and "cyprus" are in
 *    the raw ENABLE dictionary as lowercase strings, but they are not English
 *    words, and they never appear here.
 *  - Membership at ANY tier means the lowercase string has a real English
 *    sense. "roger" (to acknowledge), "kelly" (green) and "marc" (grape
 *    pressings) are listed; "eric" and "intel" are not. That is exactly the
 *    line between a proper noun worth keeping as a bonus word and one to drop.
 *
 * Returns { common, all } as Sets, or null when the package is unavailable.
 */
/**
 * Load Zipf frequencies produced by scripts/dump_word_zipf.py. Returns a Map
 * of word -> zipf, or null when the file is missing (the build then falls back
 * to tiers alone, which is worse but still produces playable lists).
 */
function loadWordFrequencies() {
  const file = path.join(ROOT, 'scripts', 'data', 'word-zipf.txt');
  if (!fs.existsSync(file)) return null;
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const space = line.indexOf(' ');
    if (space < 1) continue;
    const word = line.slice(0, space);
    const zipf = Number(line.slice(space + 1));
    if (LOWER_ALPHA_RE.test(word) && !Number.isNaN(zipf)) map.set(word, zipf);
  }
  return map.size > 1000 ? map : null;
}

function loadGradedWordTiers() {
  const graded = tryRequire('wordlist-english');
  if (!graded || typeof graded !== 'object') return null;

  const common = new Set();
  const all = new Set();
  let sawCommonTier = false;

  for (const key of Object.keys(graded)) {
    // The package also ships british/canadian/australian variants; mixing them
    // in would offer "marvellous" alongside "marvelous". Stick to one spelling.
    if (!/^english(\/american)?\/\d+$/.test(key)) continue;
    const list = graded[key];
    if (!Array.isArray(list)) continue;
    const tier = Number((key.match(/(\d+)$/) || [])[1]);
    for (const raw of list) {
      const word = String(raw).toLowerCase();
      all.add(word);
      if (tier <= COMMON_TIER_MAX) {
        common.add(word);
        sawCommonTier = true;
      }
    }
  }
  if (!sawCommonTier || all.size < 5000) return null;
  return { common, all, source: 'wordlist-english (SCOWL tiers <= ' + COMMON_TIER_MAX + ', MIT)' };
}

function loadDictionarySource() {
  // Preferred: an-array-of-english-words (ENABLE list, ~275k words, MIT).
  const enable = tryRequire('an-array-of-english-words');
  if (Array.isArray(enable) && enable.length > 1000) {
    return { words: enable, source: 'an-array-of-english-words (ENABLE word list, MIT)' };
  }

  // Secondary: word-list-json (sindresorhus/word-list, MIT).
  const wlj = tryRequire('word-list-json');
  if (Array.isArray(wlj) && wlj.length > 1000) {
    return { words: wlj, source: 'word-list-json (sindresorhus/word-list, MIT)' };
  }

  // Fallback: just the curated common word seed list doubles as a tiny
  // dictionary so the build still succeeds offline.
  return { words: FALLBACK_COMMON_WORDS.slice(), source: 'embedded fallback list' };
}

function loadFrequencyRankedWords() {
  // most-common-words-by-language ships a plain resources/english.txt file,
  // one lowercase word per line, ordered by descending frequency. We read the
  // file directly (rather than through the package's index, which pulls in a
  // lodash dependency that may not be present) to keep this build resilient.
  const candidatePaths = [
    path.join(ROOT, 'node_modules', 'most-common-words-by-language', 'build', 'resources', 'english.txt'),
    path.join(ROOT, 'node_modules', 'most-common-words-by-language', 'src', 'resources', 'english.txt'),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const words = fs.readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      if (words.length > 500) {
        return { words, source: 'most-common-words-by-language (english.txt frequency list, MIT)' };
      }
    }
  }

  return null;
}

/**
 * Every dictionary word at ANY length, used only for stem lookups. The shipped
 * dictionary starts at 4 letters, but detecting "dogs" as a plural needs the
 * 3-letter stem "dog", so inflection tests run against this wider set.
 */
function buildStemSet(rawWords) {
  const set = new Set();
  for (const w of rawWords) {
    const word = String(w).toLowerCase();
    if (LOWER_ALPHA_RE.test(word)) set.add(word);
  }
  return set;
}

/**
 * Is `word` merely a plural or past-tense form of another word?
 *
 * These are excluded from the puzzle's required-word lists: a board offering
 * both "metal" and "metals" (or "deal" and "dealed"-style pairs) inflates the
 * word count without adding anything to solve. They stay in the validation
 * dictionary, so tracing one is still recognised as a bonus word rather than
 * rejected.
 */
// -ing words that are ordinary nouns in their own right, not just a verb
// wearing a participle ending. These stay eligible as required words.
const STANDALONE_ING = new Set([
  'morning', 'evening', 'ceiling', 'feeling', 'meeting', 'building', 'painting',
  'drawing', 'clothing', 'pudding', 'wedding', 'blessing', 'greeting', 'offering',
  'opening', 'warning', 'meaning', 'setting', 'housing', 'nothing', 'something',
  'everything', 'anything', 'during', 'spring', 'string', 'herring', 'sterling',
  'viking', 'lightning', 'engineering', 'shilling', 'earring', 'sibling',
  'stocking', 'pudding', 'bearing', 'crossing', 'dressing', 'ending', 'evening',
  'filing', 'finding', 'footing', 'gathering', 'hearing', 'holding', 'landing',
  'listing', 'living', 'lodging', 'making', 'morning', 'outing', 'padding',
  'parking', 'saving', 'sibling', 'sitting', 'sting', 'swing', 'thing', 'timing',
  'wing', 'king', 'ring', 'sing', 'bring', 'cling', 'fling', 'wring', 'ginseng'
]);

// Words ending -ier/-iest that are nouns, not comparatives of a "-y" word.
const NOT_COMPARATIVE = new Set([
  'carrier', 'terrier', 'priest', 'barrier', 'soldier', 'cashier', 'courier',
  'frontier', 'premier', 'glacier', 'brier', 'friar', 'pliers', 'skier'
]);

/*
 * Nouns whose normal form happens to end in -s. These are not "the singular
 * plus an s" the way "reels" is: nobody reaches for a "scissor" or a
 * "binocular", so blocking them would lose ordinary vocabulary.
 */
const PLURAL_ONLY_NOUNS = new Set([
  'scissors', 'trousers', 'pliers', 'tweezers', 'binoculars', 'pajamas',
  'jeans', 'goggles', 'shears', 'suds', 'dregs', 'alms', 'series', 'species',
  'news', 'shorts', 'tongs', 'bellows', 'premises', 'measles', 'mumps',
]);

function isInflectedForm(word, stemSet) {
  if (PLURAL_ONLY_NOUNS.has(word)) return false;
  const has = (s) => s.length >= 2 && stemSet.has(s);

  // Comparative / superlative of a "-y" adjective: tiny -> tinier -> tiniest.
  // Only the -i- spellings are tested; a bare -er/-est rule would also strike
  // corner, center, quarter, brother, forest and digest.
  if (!NOT_COMPARATIVE.has(word)) {
    if (word.endsWith('ier') && has(word.slice(0, -3) + 'y')) return true;
    if (word.endsWith('iest') && has(word.slice(0, -4) + 'y')) return true;
  }

  // Present participle / gerund: asking -> ask, baking -> bake, running -> run.
  if (word.endsWith('ing') && word.length >= 5 && !STANDALONE_ING.has(word)) {
    const trunk = word.slice(0, -3);
    const n = trunk.length;
    if (has(trunk)) return true;                                   // ask + ing
    if (has(trunk + 'e')) return true;                             // bake + ing
    if (n >= 3 && trunk[n - 1] === trunk[n - 2] && has(trunk.slice(0, -1))) {
      return true;                                                 // run + n + ing
    }
  }

  // Plurals / third-person singular. "ss" endings (glass, less) are not plurals.
  if (word.endsWith('s') && !word.endsWith('ss')) {
    if (has(word.slice(0, -1))) return true;                            // dogs, metals, painters
    if (word.endsWith('es') && has(word.slice(0, -2))) return true;     // boxes, wishes
    if (word.endsWith('ies') && has(word.slice(0, -3) + 'y')) return true; // cities
  }

  // Past tense / past participle. Words ending "eed" (seed, need, feed, breed)
  // are base words that only look like -ed forms, so they are left alone.
  if (word.endsWith('ed') && !word.endsWith('eed')) {
    if (has(word.slice(0, -1))) return true;                            // used, liked
    if (has(word.slice(0, -2))) return true;                            // asked, wanted
    if (word.endsWith('ied') && has(word.slice(0, -3) + 'y')) return true; // tried
    const n = word.length;
    // Doubled final consonant: stopped -> stop, planned -> plan.
    if (n >= 5 && word[n - 3] === word[n - 4] && has(word.slice(0, -3))) return true;
  }

  return false;
}

/**
 * One blocked-word test used everywhere. Covers the embedded lists, the shared
 * profanity list, and simple derivations of any blocked root ("shitty",
 * "wanker") so the lists don't have to spell out every form.
 */
function makeBlockTest(extraRoots) {
  const roots = new Set([...BLOCKLIST, ...COMMON_ONLY_BLOCKLIST, ...(extraRoots || [])]);
  return function isBlocked(word) {
    if (PROFANITY_ALLOWLIST.has(word)) return false;
    if (roots.has(word)) return true;
    for (const suffix of BLOCK_SUFFIXES) {
      if (!word.endsWith(suffix)) continue;
      const stem = word.slice(0, -suffix.length);
      if (stem.length >= 3 && roots.has(stem)) return true;
      // doubled consonant before the ending: "shitting" -> "shit"
      if (stem.length >= 4 && stem[stem.length - 1] === stem[stem.length - 2] &&
          roots.has(stem.slice(0, -1))) {
        return true;
      }
    }
    return false;
  };
}

function buildDictSet(rawWords, stemSet, isBlocked) {
  const set = new Set();
  for (const w of rawWords) {
    const word = String(w).toLowerCase();
    // Inflected forms are not playable at all, not even as bonus words:
    // "reels" is not a separate find from "reel".
    if (stemSet && isInflectedForm(word, stemSet)) continue;
    if (!LOWER_ALPHA_RE.test(word)) continue;
    if (word.length < DICT_MIN_LEN || word.length > DICT_MAX_LEN) continue;
    if (isBlocked ? isBlocked(word) : BLOCKLIST.has(word)) continue;
    set.add(word);
  }
  return set;
}

function pickCommonWords(dictSet, stemSet, tiers, isBlocked, zipf) {
  const freq = loadFrequencyRankedWords();
  const picked = [];
  const pickedLong = [];
  const pickedBase = [];
  const pickedEasy = [];
  const pickedEasyLong = [];
  const pickedEasyBase = [];
  const seen = new Set();
  const seenLong = new Set();

  function tryAdd(word) {
    if (picked.length >= COMMON_TARGET_MAX) return false;
    const w = String(word).toLowerCase();
    if (seen.has(w)) return false;
    if (!LOWER_ALPHA_RE.test(w)) return false;
    if (w.length < COMMON_MIN_LEN || w.length > COMMON_MAX_LEN) return false;
    if (isBlocked(w)) return false;
    if (!dictSet.has(w)) return false; // must be a real dictionary word (also enforces ZAN_COMMON subset dict)
    if (isInflectedForm(w, stemSet)) return false; // no plurals / -ed forms as required words
    seen.add(w);
    picked.push(w);
    return true;
  }

  function tryAddLong(word) {
    if (pickedLong.length >= COMMON_LONG_TARGET_MAX) return false;
    const w = String(word).toLowerCase();
    if (seenLong.has(w)) return false;
    if (!LOWER_ALPHA_RE.test(w)) return false;
    if (w.length < COMMON_LONG_MIN_LEN || w.length > COMMON_LONG_MAX_LEN) return false;
    if (isBlocked(w)) return false;
    if (!dictSet.has(w)) return false; // must be a real dictionary word (also enforces subset-of-dict)
    if (isInflectedForm(w, stemSet)) return false; // no plurals / -ed forms as required words
    seenLong.add(w);
    pickedLong.push(w);
    return true;
  }

  let freqSourceLabel = 'embedded fallback list only';

  // Preferred spine: the graded tiers. Frequency ordering (below) then acts
  // only as a top-up, because a web-scraped frequency list drags in names and
  // brand tokens that the tiers correctly leave out.
  if (zipf && tiers) {
    freqSourceLabel = 'wordfreq Zipf >= ' + COMMON_MIN_ZIPF +
      ' (base >= ' + BASE_MIN_ZIPF + '), names filtered by ' + tiers.source;
    // Frequency decides; the tier set decides only whether a word is a word
    // rather than a lowercase proper noun.
    const candidates = Array.from(zipf.keys()).filter(
      (w) => zipf.get(w) >= COMMON_MIN_ZIPF && tiers.common.has(w)
    );
    candidates.sort();
    for (const word of candidates) {
      const score = zipf.get(word);
      if (word.length <= COMMON_MAX_LEN) {
        if (tryAdd(word) && score >= EASY_MIN_ZIPF) pickedEasy.push(word);
      } else if (tryAddLong(word)) {
        // Long words are required whenever they are common enough, but only
        // the well-known ones are fit to headline a puzzle as the base word.
        if (score >= BASE_MIN_ZIPF) pickedBase.push(word);
        if (score >= EASY_MIN_ZIPF) pickedEasyLong.push(word);
        if (score >= EASY_BASE_MIN_ZIPF) pickedEasyBase.push(word);
      }
    }
  } else if (tiers) {
    // No frequency data: fall back to the graded tiers on their own.
    freqSourceLabel = tiers.source + ' (no frequency data — run scripts/dump_word_zipf.py)';
    for (const word of Array.from(tiers.common).sort()) {
      if (word.length <= COMMON_MAX_LEN) tryAdd(word);
      else tryAddLong(word);
    }
  }

  // Hand-promoted gaps, at whichever length fits.
  for (const word of Array.from(PROMOTED_COMMON).sort()) {
    if (word.length <= COMMON_MAX_LEN) tryAdd(word);
    else tryAddLong(word);
  }

  if (freq && !tiers) {
    freqSourceLabel = freq.source;
    // Single pass down the frequency-ranked list: short/mid-length words feed
    // ZAN_COMMON, longer-but-still-frequent words feed ZAN_COMMON_LONG. This
    // keeps ZAN_COMMON_LONG sourced from the same "words an average player
    // knows" frequency ordering, just continuing further down the list.
    freq.words.forEach((w, rank) => {
      const word = String(w).toLowerCase();
      if (word.length >= COMMON_MIN_LEN && word.length <= COMMON_MAX_LEN) {
        tryAdd(word);
      } else if (
        rank < COMMON_LONG_MAX_FREQ_RANK &&
        word.length >= COMMON_LONG_MIN_LEN && word.length <= COMMON_LONG_MAX_LEN
      ) {
        tryAddLong(word);
      }
    });
  }

  // If the frequency source didn't yield enough in-range/in-dictionary words
  // (e.g. it's dominated by 1-2 letter function words, or unavailable),
  // top up with the curated fallback list, then—if still short—top up
  // further by walking the dictionary itself in its given order.
  if (picked.length < COMMON_TARGET_MIN) {
    for (const w of FALLBACK_COMMON_WORDS) {
      tryAdd(w);
      if (picked.length >= COMMON_TARGET_MIN) break;
    }
  }

  if (picked.length < COMMON_TARGET_MIN) {
    for (const w of dictSet) {
      tryAdd(w);
      if (picked.length >= COMMON_TARGET_MIN) break;
    }
  }

  // ZAN_COMMON_LONG has no fallback word list to top up from (the curated
  // fallback words are all short), so if the frequency source ran out before
  // reaching the target minimum, top up from the dictionary directly. This
  // is a quality tradeoff versus frequency-ranked words: dictionary order is
  // alphabetical, not popularity-ranked, so words picked this way may be
  // less universally recognizable. Only used if genuinely short.
  let longToppedUpFromDict = 0;
  if (pickedLong.length < COMMON_LONG_TARGET_MIN) {
    for (const w of dictSet) {
      if (tryAddLong(w)) longToppedUpFromDict++;
      if (pickedLong.length >= COMMON_LONG_TARGET_MIN) break;
    }
  }

  for (const list of [picked, pickedLong, pickedBase, pickedEasy, pickedEasyLong, pickedEasyBase]) {
    list.sort();
  }
  return {
    words: picked, wordsLong: pickedLong, wordsBase: pickedBase,
    easy: pickedEasy, easyLong: pickedEasyLong, easyBase: pickedEasyBase,
    freqSourceLabel, longToppedUpFromDict
  };
}

function toJsFileCommon(words, wordsLong, wordsBase, easy) {
  const json = JSON.stringify(words);
  const jsonLong = JSON.stringify(wordsLong);
  const jsonBase = JSON.stringify(wordsBase && wordsBase.length ? wordsBase : wordsLong);
  const e = easy || {};
  return (
    '// Auto-generated by scripts/build_zanagrams_wordlists.js — do not edit by hand.\n' +
    '// Common, everyday English words (lengths 4-7) used as required puzzle words.\n' +
    '// Source: frequency-ranked common-words list intersected with a public-domain\n' +
    "// English dictionary. See the build script's header comment for full sourcing.\n" +
    'window.ZAN_COMMON = ' + json + ';\n\n' +
    '// Common, recognizable English words (lengths 8-11) used as the puzzle\'s\n' +
    '// single "longest word". Sourced further down the same frequency ranking\n' +
    "// used for ZAN_COMMON, so they should still be words an average player\n" +
    '// knows (e.g. birthday, elephant, chocolate, dangerous, basketball).\n' +
    'window.ZAN_COMMON_LONG = ' + jsonLong + ';\n\n' +
    '// The subset of the above fit to headline a puzzle as its base word: the\n' +
    '// long words a player should recognise on sight. Every base word is a\n' +
    '// common word, but not every common long word makes a good headline.\n' +
    'window.ZAN_BASE = ' + jsonBase + ';\n\n' +
    '// Easy mode: the same three lists over a friendlier vocabulary, so every\n' +
    '// required word is one a casual player recognises at once. Bonus words are\n' +
    '// unchanged — the dictionary is shared by both difficulties.\n' +
    'window.ZAN_COMMON_EASY = ' + JSON.stringify(e.words || []) + ';\n' +
    'window.ZAN_LONG_EASY = ' + JSON.stringify(e.wordsLong || []) + ';\n' +
    'window.ZAN_BASE_EASY = ' + JSON.stringify(e.wordsBase || []) + ';\n'
  );
}

function toJsFileDict(words, maxLen) {
  const raw = words.join(' ');
  return (
    '// Auto-generated by scripts/build_zanagrams_wordlists.js — do not edit by hand.\n' +
    '// Full validation dictionary (lengths ' + DICT_MIN_LEN + '-' + maxLen + '), space-separated for compactness.\n' +
    "// Source: public-domain English word list. See the build script's header\n" +
    '// comment for full sourcing.\n' +
    'window.ZAN_DICT_RAW = ' + JSON.stringify(raw) + ';\n'
  );
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dictSrc = loadDictionarySource();
  const tiers = loadGradedWordTiers();
  const zipf = loadWordFrequencies();

  // Bonus words are drawn from the dictionary, so strip entries that are only
  // in it as lowercase proper nouns ("eric", "texas") while keeping obscure
  // words that have a genuine sense ("murky", and "roger" as an acknowledgement).
  const dictWordsRaw = tiers
    ? dictSrc.words.filter((w) => {
      const word = String(w).toLowerCase();
      return tiers.all.has(word) || DICT_ALLOWLIST.has(word);
    })
    : dictSrc.words;
  const stemSet = buildStemSet(dictWordsRaw);
  const profanity = loadProfanityList();
  const isBlocked = makeBlockTest(profanity);
  const dictSet = buildDictSet(dictWordsRaw, stemSet, isBlocked);

  const { words: commonWords, wordsLong: commonLongWords, wordsBase: baseWords,
    easy: easyWords, easyLong: easyLongWords, easyBase: easyBaseWords,
    freqSourceLabel, longToppedUpFromDict } =
    pickCommonWords(dictSet, stemSet, tiers, isBlocked, zipf);

  // Guarantee subset invariants: every common/common-long word must be in the
  // dict set (ZAN_COMMON and ZAN_COMMON_LONG are disjoint by length range).
  for (const w of commonWords) dictSet.add(w);
  for (const w of commonLongWords) dictSet.add(w);

  let dictWords = Array.from(dictSet).sort();
  let dictMaxLen = DICT_MAX_LEN;

  // If the full-length (up to 11) dictionary would exceed the size budget,
  // cap it at length 10 instead, but always keep the ZAN_COMMON_LONG words
  // (which may include length-11 words) present so the subset invariant
  // still holds even though the general dictionary is capped shorter.
  const uncappedRaw = dictWords.join(' ');
  if (Buffer.byteLength(uncappedRaw, 'utf8') > DICT_SIZE_CAP_BYTES) {
    dictMaxLen = DICT_MAX_LEN_CAPPED;
    const cappedSet = new Set();
    for (const w of dictWords) {
      if (w.length <= DICT_MAX_LEN_CAPPED) cappedSet.add(w);
    }
    for (const w of commonLongWords) cappedSet.add(w); // preserve subset invariant
    dictWords = Array.from(cappedSet).sort();
  }

  fs.writeFileSync(COMMON_OUT, toJsFileCommon(commonWords, commonLongWords, baseWords, {
    words: easyWords, wordsLong: easyLongWords, wordsBase: easyBaseWords
  }));
  fs.writeFileSync(DICT_OUT, toJsFileDict(dictWords, dictMaxLen));

  const commonSize = fs.statSync(COMMON_OUT).size;
  const dictSize = fs.statSync(DICT_OUT).size;

  console.log('Zanagrams word list build complete.');
  console.log('  Dictionary source : %s (%d raw words)', dictSrc.source, dictSrc.words.length);
  console.log('  Frequency source  : %s', freqSourceLabel);
  console.log('  common.js : ZAN_COMMON=%d words, ZAN_COMMON_LONG=%d words, %d bytes -> %s',
    commonWords.length, commonLongWords.length, commonSize, COMMON_OUT);
  console.log('  dict.js   : %d words (maxLen=%d), %d bytes -> %s', dictWords.length, dictMaxLen, dictSize, DICT_OUT);
  if (longToppedUpFromDict > 0) {
    console.log('  NOTE: %d ZAN_COMMON_LONG words topped up from raw dictionary (not frequency-ranked) because the frequency source ran short at lengths 8-11.', longToppedUpFromDict);
  }
}

main();
