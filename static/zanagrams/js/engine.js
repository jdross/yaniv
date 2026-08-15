/* Zanagrams — game engine (pure logic, works in browser and Node).
 *
 * Owns the countdown clock, the found/bonus word bookkeeping and win/lose
 * state. It delegates all board mutation to ZanGenerator.
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

  const DEFAULTS = {
    timePerWordMs: 30000,
    baseTimeMs: 15000,
    maxTimeMs: 600000,
    requiredBonusMs: 4000,
    minWordLength: 3
  };

  /** Seconds granted for a bonus word of the given length. */
  function bonusSeconds(length) {
    if (length <= 3) return 3;
    if (length === 4) return 5;
    if (length === 5) return 8;
    if (length === 6) return 12;
    return 16;
  }

  /** Build the lookup Set used for bonus-word validation. */
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
    const budget = Math.min(
      opts.maxTimeMs,
      opts.baseTimeMs + puzzle.words.length * opts.timePerWordMs
    );
    return {
      puzzle: puzzle,
      dict: opts.dict || new Set(),
      config: opts,
      totalMs: budget,
      timeLeftMs: budget,
      status: 'playing',            // 'playing' | 'won' | 'lost'
      foundWords: [],               // required words, in the order found
      bonusWords: [],               // { word, seconds }
      bonusSeconds: 0,
      startedAt: null,
      finishedAt: null
    };
  }

  function remainingWords(state) {
    return state.puzzle.words.filter(w => !w.found);
  }

  function addTime(state, ms) {
    state.timeLeftMs = Math.min(state.config.maxTimeMs, state.timeLeftMs + ms);
  }

  /** Advance the clock by dtMs. Returns true when the game just ended. */
  function tick(state, dtMs) {
    if (state.status !== 'playing') return false;
    state.timeLeftMs -= dtMs;
    if (state.timeLeftMs <= 0) {
      state.timeLeftMs = 0;
      state.status = 'lost';
      state.finishedAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Judge a traced string.
   * Returns { type, word, ... } where type is one of:
   *   'required' | 'bonus' | 'short' | 'repeat-required' | 'repeat-bonus' | 'unknown' | 'inactive'
   */
  function submitWord(state, rawWord) {
    const word = String(rawWord || '').toLowerCase();
    if (state.status !== 'playing') return { type: 'inactive', word: word };
    if (word.length < state.config.minWordLength) return { type: 'short', word: word };

    const index = Generator.findWordIndex(state.puzzle, word);
    if (index >= 0) {
      const result = Generator.removeWord(state.puzzle, index);
      state.foundWords.push(word);
      addTime(state, state.config.requiredBonusMs);
      const done = remainingWords(state).length === 0;
      if (done) {
        state.status = 'won';
        state.finishedAt = Date.now();
      }
      return {
        type: 'required',
        word: word,
        wordIndex: index,
        removedIds: result ? result.removedIds : [],
        moved: result ? result.moved : [],
        timeAdded: state.config.requiredBonusMs,
        solved: done
      };
    }

    if (state.puzzle.words.some(w => w.found && w.text === word)) {
      return { type: 'repeat-required', word: word };
    }
    if (state.bonusWords.some(b => b.word === word)) {
      return { type: 'repeat-bonus', word: word };
    }
    if (state.dict.has(word)) {
      const secs = bonusSeconds(word.length);
      state.bonusWords.push({ word: word, seconds: secs });
      state.bonusSeconds += secs;
      addTime(state, secs * 1000);
      return { type: 'bonus', word: word, timeAdded: secs * 1000, seconds: secs };
    }
    return { type: 'unknown', word: word };
  }

  /** Format ms as M:SS for the HUD. */
  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /** Blank placeholder shown for an unfound required word. */
  function blanksFor(word) {
    return word.split('').map(() => '_').join(' ');
  }

  return {
    DEFAULTS: DEFAULTS,
    bonusSeconds: bonusSeconds,
    buildDict: buildDict,
    createGame: createGame,
    remainingWords: remainingWords,
    submitWord: submitWord,
    tick: tick,
    addTime: addTime,
    formatTime: formatTime,
    blanksFor: blanksFor
  };
});
