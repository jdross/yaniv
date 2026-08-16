/* Lettermelt — game engine (pure logic, works in browser and Node).
 *
 * The game is a race against an INCREMENTING STOPWATCH. There is no time-out
 * and no lose state: play always ends by solving every hidden word, and the
 * score is the final elapsed time (lower is better). Extra words (valid
 * dictionary words that are not puzzle words) SUBTRACT time from the
 * stopwatch, clamped at zero.
 *
 * All board mutation is delegated to ZanGenerator.
 */
(function (root, factory) {
  const gen = (typeof module !== 'undefined' && module.exports)
    ? require('./generator.js')
    : root.ZanGenerator;
  const api = factory(gen);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ZanEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Generator) {
  'use strict';

  /* ---- tunables (single block, on purpose) ---- */
  const DEFAULTS = {
    minWordLength: 4,        // 3-letter traces are never valid
    solvedCreditMs: 0,       // time credited for solving a required word
    extraSeconds: {          // seconds shaved off the stopwatch per extra word
      4: 5,
      5: 8,
      6: 10,
      7: 12,
      long: 15               // 8+ letters
    }
  };

  /*
   * Stars. The clock still counts up, but it now spends a rating rather than
   * just recording a time: you start on five stars and drop one each time the
   * elapsed time crosses a threshold. Extra words push the clock back, so
   * finding them can win a star back.
   */
  const STAR_THRESHOLDS = [
    { stars: 5, withinMs: 5 * 60 * 1000 },
    { stars: 4, withinMs: 6 * 60 * 1000 },
    { stars: 3, withinMs: 7.5 * 60 * 1000 },
    { stars: 2, withinMs: 10 * 60 * 1000 }
  ];
  const MIN_STARS = 1;
  const MAX_STARS = STAR_THRESHOLDS[0].stars;

  /** Stars a run finishing at `elapsedMs` would earn. */
  function starsFor(elapsedMs) {
    for (const tier of STAR_THRESHOLDS) {
      if (elapsedMs < tier.withinMs) return tier.stars;
    }
    return MIN_STARS;
  }

  /**
   * Milliseconds until the next star is lost, or null on the last star.
   * Drives the countdown beside the star row.
   */
  function msToNextStarLoss(elapsedMs) {
    for (const tier of STAR_THRESHOLDS) {
      if (elapsedMs < tier.withinMs) return tier.withinMs - elapsedMs;
    }
    return null;
  }

  /** Seconds an extra word of the given length shaves off the clock. */
  function extraSeconds(length, table) {
    const t = table || DEFAULTS.extraSeconds;
    if (length >= 8) return t.long;
    return t[length] || 0;
  }

  /** Build the lookup Set used for extra-word validation. */
  function buildDict(raw, extraWords) {
    const set = new Set();
    if (typeof raw === 'string' && raw.length) {
      for (const w of raw.split(/\s+/)) {
        if (w) set.add(w.toLowerCase());
      }
    } else if (Array.isArray(raw)) {
      for (const w of raw) if (w) set.add(String(w).toLowerCase());
    }
    if (Array.isArray(extraWords)) {
      for (const w of extraWords) if (w) set.add(String(w).toLowerCase());
    }
    return set;
  }

  function createGame(options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const puzzle = opts.puzzle;
    if (!puzzle) throw new Error('createGame requires a puzzle');
    return {
      puzzle: puzzle,
      dict: opts.dict || new Set(),
      config: opts,
      elapsedMs: 0,
      status: 'playing',            // 'playing' | 'won'
      foundWords: [],               // puzzle words, in the order found
      extraWords: [],               // { word, seconds }
      savedMs: 0,                   // total time shaved off by extras
      finishedAt: null
    };
  }

  function remainingWords(state) {
    return state.puzzle.words.filter(w => !w.found);
  }

  function totalWords(state) {
    return state.puzzle.words.length;
  }

  function solvedCount(state) {
    return state.puzzle.words.filter(w => w.found).length;
  }

  /** Shave ms off the stopwatch, never below zero. Returns ms actually saved. */
  function creditTime(state, ms) {
    const before = state.elapsedMs;
    state.elapsedMs = Math.max(0, state.elapsedMs - ms);
    return before - state.elapsedMs;
  }

  /** Advance the stopwatch by dtMs. */
  function tick(state, dtMs) {
    if (state.status !== 'playing') return false;
    if (!(dtMs > 0)) return false;
    state.elapsedMs += dtMs;
    return false;
  }

  /**
   * Judge a traced string.
   * Returns { type, word, ... } where type is one of:
   *   'required' | 'extra' | 'short' | 'repeat-required' | 'repeat-extra' |
   *   'plural' | 'unknown' | 'inactive'
   */
  function submitWord(state, rawWord) {
    const word = String(rawWord || '').toLowerCase();
    if (state.status !== 'playing') return { type: 'inactive', word: word };
    if (word.length < state.config.minWordLength) return { type: 'short', word: word };

    const index = Generator.findWordIndex(state.puzzle, word);
    if (index >= 0) {
      const isLong = !!state.puzzle.words[index].isLong;
      const result = Generator.removeWord(state.puzzle, index);
      state.foundWords.push(word);
      const credited = state.config.solvedCreditMs
        ? creditTime(state, state.config.solvedCreditMs)
        : 0;
      state.savedMs += credited;
      const done = remainingWords(state).length === 0;
      if (done) {
        state.status = 'won';
        state.finishedAt = Date.now();
      }
      return {
        type: 'required',
        word: word,
        wordIndex: index,
        isLong: isLong,
        removedIds: result ? result.removedIds : [],
        removedEdgeKeys: result ? result.removedEdgeKeys : [],
        moved: result ? result.moved : [],
        timeSaved: credited,
        solved: done
      };
    }

    if (state.puzzle.words.some(w => w.found && w.text === word)) {
      return { type: 'repeat-required', word: word };
    }
    if (state.extraWords.some(b => b.word === word)) {
      return { type: 'repeat-extra', word: word };
    }
    if (state.dict.has(word)) {
      const secs = extraSeconds(word.length, state.config.extraSeconds);
      const credited = creditTime(state, secs * 1000);
      state.extraWords.push({ word: word, seconds: secs });
      state.savedMs += credited;
      return { type: 'extra', word: word, seconds: secs, timeSaved: credited };
    }
    if (looksLikePlural(word, state.dict)) return { type: 'plural', word: word };
    return { type: 'unknown', word: word };
  }

  /**
   * Is this rejected trace just a plural of a real word?
   *
   * Plurals are deliberately absent from the dictionary — "reels" is not a
   * separate find from "reel" — so they land as 'unknown' alongside genuine
   * non-words. Telling the two apart lets the board say "no plurals" instead
   * of implying the letters spell nothing.
   */
  function looksLikePlural(word, dict) {
    if (!dict || word.length < 5 || !word.endsWith('s') || word.endsWith('ss')) return false;
    if (dict.has(word.slice(0, -1))) return true;                       // reels -> reel
    if (word.endsWith('es') && dict.has(word.slice(0, -2))) return true; // boxes -> box
    if (word.endsWith('ies') && dict.has(word.slice(0, -3) + 'y')) return true; // cities -> city
    return false;
  }

  /** Format ms as M:SS for the HUD. */
  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  return {
    DEFAULTS: DEFAULTS,
    STAR_THRESHOLDS: STAR_THRESHOLDS,
    MAX_STARS: MAX_STARS,
    MIN_STARS: MIN_STARS,
    starsFor: starsFor,
    looksLikePlural: looksLikePlural,
    msToNextStarLoss: msToNextStarLoss,
    extraSeconds: extraSeconds,
    buildDict: buildDict,
    createGame: createGame,
    remainingWords: remainingWords,
    totalWords: totalWords,
    solvedCount: solvedCount,
    submitWord: submitWord,
    tick: tick,
    creditTime: creditTime,
    formatTime: formatTime
  };
});
