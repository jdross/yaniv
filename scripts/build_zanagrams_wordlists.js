#!/usr/bin/env node
'use strict';

/*
 * Build script for the Zanagrams-clone word list data assets.
 *
 * Generates:
 *   - static/zanagrams/data/common.js   (window.ZAN_COMMON = [...])
 *   - static/zanagrams/data/dict.js     (window.ZAN_DICT_RAW = "word word ...")
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
const OUT_DIR = path.join(ROOT, 'static', 'zanagrams', 'data');
const COMMON_OUT = path.join(OUT_DIR, 'common.js');
const DICT_OUT = path.join(OUT_DIR, 'dict.js');

const DICT_MIN_LEN = 3;
const DICT_MAX_LEN = 8;
const COMMON_MIN_LEN = 3;
const COMMON_MAX_LEN = 7;
const COMMON_TARGET_MIN = 1500;
const COMMON_TARGET_MAX = 4000;

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

function buildDictSet(rawWords) {
  const set = new Set();
  for (const w of rawWords) {
    const word = String(w).toLowerCase();
    if (!LOWER_ALPHA_RE.test(word)) continue;
    if (word.length < DICT_MIN_LEN || word.length > DICT_MAX_LEN) continue;
    if (BLOCKLIST.has(word)) continue;
    set.add(word);
  }
  return set;
}

function pickCommonWords(dictSet) {
  const freq = loadFrequencyRankedWords();
  const picked = [];
  const seen = new Set();

  function tryAdd(word) {
    const w = String(word).toLowerCase();
    if (seen.has(w)) return;
    if (!LOWER_ALPHA_RE.test(w)) return;
    if (w.length < COMMON_MIN_LEN || w.length > COMMON_MAX_LEN) return;
    if (BLOCKLIST.has(w)) return;
    if (!dictSet.has(w)) return; // must be a real dictionary word (also enforces ZAN_COMMON subset dict)
    seen.add(w);
    picked.push(w);
  }

  let freqSourceLabel = 'embedded fallback list only';

  if (freq) {
    freqSourceLabel = freq.source;
    for (const w of freq.words) {
      tryAdd(w);
      if (picked.length >= COMMON_TARGET_MAX) break;
    }
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

  picked.sort();
  return { words: picked, freqSourceLabel };
}

function toJsFileCommon(words) {
  const json = JSON.stringify(words);
  return (
    '// Auto-generated by scripts/build_zanagrams_wordlists.js — do not edit by hand.\n' +
    '// Common, everyday English words (lengths 3-7) used as required puzzle words.\n' +
    '// Source: frequency-ranked common-words list intersected with a public-domain\n' +
    "// English dictionary. See the build script's header comment for full sourcing.\n" +
    'window.ZAN_COMMON = ' + json + ';\n'
  );
}

function toJsFileDict(words) {
  const raw = words.join(' ');
  return (
    '// Auto-generated by scripts/build_zanagrams_wordlists.js — do not edit by hand.\n' +
    '// Full validation dictionary (lengths 3-8), space-separated for compactness.\n' +
    "// Source: public-domain English word list. See the build script's header\n" +
    '// comment for full sourcing.\n' +
    'window.ZAN_DICT_RAW = ' + JSON.stringify(raw) + ';\n'
  );
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dictSrc = loadDictionarySource();
  const dictSet = buildDictSet(dictSrc.words);

  const { words: commonWords, freqSourceLabel } = pickCommonWords(dictSet);

  // Guarantee subset invariant: every common word must be in the dict set.
  for (const w of commonWords) {
    dictSet.add(w);
  }

  const dictWords = Array.from(dictSet).sort();

  fs.writeFileSync(COMMON_OUT, toJsFileCommon(commonWords));
  fs.writeFileSync(DICT_OUT, toJsFileDict(dictWords));

  const commonSize = fs.statSync(COMMON_OUT).size;
  const dictSize = fs.statSync(DICT_OUT).size;

  console.log('Zanagrams word list build complete.');
  console.log('  Dictionary source : %s (%d raw words)', dictSrc.source, dictSrc.words.length);
  console.log('  Frequency source  : %s', freqSourceLabel);
  console.log('  common.js : %d words, %d bytes -> %s', commonWords.length, commonSize, COMMON_OUT);
  console.log('  dict.js   : %d words, %d bytes -> %s', dictWords.length, dictSize, DICT_OUT);
}

main();
