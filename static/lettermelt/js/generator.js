/* Lettermelt — puzzle generator (pure logic, works in browser and Node).
 *
 * MODEL
 * -----
 * A puzzle is 10-16 hidden words packed into a FIXED 5 x 5 grid (<= 25 letter
 * cells). Every word owns a canonical path: a self-avoiding sequence of
 * 8-adjacent cells, one cell per letter. Cells are shared between words
 * whenever the letters match. Exactly one word is the 8-11 letter "base" word.
 *
 * Construction runs in three phases inside the grid:
 *   0. snake the base word across the 5 x 5,
 *   1. grow with 4-7 letter words that reuse cells and add few new ones,
 *   2. saturate: scan the vocabulary for words routable with ZERO new cells.
 * Restarts keep the best-scoring board (fuller grid, more sharing, more words).
 *
 * The board graph shown to the player is EXACTLY the union of the remaining
 * (unfound) words' canonical paths:
 *   - a node exists iff >= 1 remaining word uses that cell,
 *   - an edge exists iff >= 1 remaining word steps between those two cells.
 * No other adjacency is drawn or traversable. Solving a word recomputes the
 * union, so anything no longer needed disappears.
 *
 * Solvability is guaranteed by construction: canonical paths are untouched
 * until their word is solved, and union-removal never deletes a cell or edge
 * that a remaining word still needs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ZanGenerator = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Tunables
   * ------------------------------------------------------------------ */
  const CONFIG = {
    size: 5,                  // THE grid: every puzzle lives inside 5 x 5
    minWords: 10,             // hard floor for the solvable set
    maxWords: 16,             // cap for the solvable set
    longMin: 8,
    longMax: 11,
    regularMin: 4,
    regularMax: 7,
    growAttempts: 260,        // sampled words during the growth phase
    saturateScan: 4200,       // vocabulary entries scanned during saturation
    routeBudget: 1200,        // DFS steps for the preferred (reuse >= 2) route
    routeBudgetRelaxed: 600,  // DFS steps for the fallback (reuse >= 1) route
    saturateBudget: 260,      // DFS steps for a zero-new-cell route
    longRouteBudget: 12000,
    restarts: 26,
    timeBudgetMs: 150         // total wall-clock budget for polish restarts
  };

  /* ------------------------------------------------------------------ *
   * Fallback word data (the real lists live in data/*.js)
   * ------------------------------------------------------------------ */
  const FALLBACK_COMMON = [
    'able', 'acre', 'atom', 'bake', 'bald', 'band', 'bare', 'barn', 'beam', 'bean',
    'bear', 'beat', 'bell', 'belt', 'bend', 'bird', 'blue', 'boat', 'bone', 'cake',
    'calm', 'cane', 'cart', 'cave', 'coal', 'coat', 'cold', 'cone', 'core', 'corn',
    'dare', 'dark', 'date', 'dawn', 'deal', 'dear', 'debt', 'dent', 'dial', 'dime',
    'earn', 'east', 'lace', 'lake', 'lamb', 'lame', 'land', 'lane', 'late', 'lead',
    'lean', 'mare', 'mast', 'mate', 'meal', 'mean', 'meat', 'mend', 'mole', 'moat',
    'nail', 'name', 'near', 'neat', 'nest', 'note', 'oral', 'oval', 'pale', 'pane',
    'part', 'past', 'pear', 'pest', 'plan', 'pole', 'rail', 'rain', 'rate', 'real',
    'rent', 'road', 'roam', 'robe', 'rode', 'role', 'rope', 'sale', 'salt', 'same',
    'sand', 'sane', 'seal', 'seam', 'seat', 'sent', 'slam', 'slate', 'snare', 'solar',
    'alone', 'blame', 'blast', 'brace', 'brain', 'bread', 'clean', 'clear', 'crane', 'cream',
    'dream', 'earls', 'learn', 'least', 'metal', 'ocean', 'organ', 'paint', 'panel', 'pearl',
    'place', 'plane', 'plant', 'plate', 'price', 'scale', 'score', 'shore', 'slate', 'smart',
    'snail', 'solid', 'stale', 'stand', 'stone', 'store', 'storm', 'table', 'trace', 'train',
    'anchor', 'animal', 'basket', 'candle', 'carbon', 'castle', 'centre', 'cellar', 'clever', 'coast',
    'dealer', 'desert', 'dinner', 'garden', 'inland', 'island', 'lantern', 'leader', 'legend', 'listen',
    'manner', 'marble', 'master', 'mental', 'metals', 'mineral', 'nature', 'normal', 'orange', 'parcel',
    'parent', 'planet', 'plaster', 'reason', 'relate', 'rental', 'sailor', 'salmon', 'sample', 'season',
    'senate', 'silent', 'silver', 'sister', 'stable', 'stream', 'talent', 'tender', 'tunnel', 'winter'
  ];

  const FALLBACK_LONG = [
    'painters', 'creation', 'material', 'mountain', 'notebook', 'sandstone', 'cardinal',
    'planetary', 'centrally', 'landscape', 'strangers', 'celebrate', 'presented',
    'restaurant', 'generation', 'personally', 'reasonable', 'management', 'centimeter'
  ];

  const FALLBACK_EXTRA = [
    'lane', 'lean', 'earn', 'near', 'tale', 'teal', 'late', 'seal', 'sale', 'ales',
    'rate', 'tear', 'tare', 'star', 'rats', 'arts', 'tars', 'note', 'tone', 'nose',
    'ones', 'eons', 'nest', 'nets', 'sent', 'tens', 'rest', 'rise', 'sire', 'tile',
    'lite', 'rite', 'tier', 'tire', 'mane', 'mean', 'name', 'amen', 'came', 'mace',
    'stone', 'notes', 'onset', 'tones', 'stare', 'tears', 'rates', 'aster', 'least',
    'steal', 'stale', 'slate', 'tales', 'learn', 'renal', 'antler', 'rental', 'canoe'
  ];

  /* ------------------------------------------------------------------ *
   * RNG
   * ------------------------------------------------------------------ */
  function createRng(seed) {
    let a = (typeof seed === 'number' ? seed : Date.now()) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    return function rng() {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(list, rng) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Lattice helpers
   * ------------------------------------------------------------------ */
  const OFFSETS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
  ];

  function key(x, y) {
    return x + ',' + y;
  }

  function edgeKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  function isDiagonalStep(ax, ay, bx, by) {
    return ax !== bx && ay !== by;
  }

  function areAdjacent(a, b) {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return dx <= 1 && dy <= 1 && dx + dy > 0;
  }

  function cellMap(cells) {
    const map = new Map();
    for (const cell of cells) map.set(key(cell.x, cell.y), cell);
    return map;
  }

  /* ------------------------------------------------------------------ *
   * Union derivation — the product's core invariant
   * ------------------------------------------------------------------ */

  /** Recompute puzzle.cells / puzzle.edges as the union of remaining words. */
  function computeUnion(puzzle) {
    const liveIds = new Set();
    const edgeIds = new Map();
    for (const word of puzzle.words) {
      if (word.found) continue;
      const ids = word.cellIds;
      for (let i = 0; i < ids.length; i++) {
        liveIds.add(ids[i]);
        if (i > 0) edgeIds.set(edgeKey(ids[i - 1], ids[i]), [ids[i - 1], ids[i]]);
      }
    }
    puzzle.cells = puzzle.allCells.filter(c => liveIds.has(c.id));
    puzzle.edges = Array.from(edgeIds.values());
    return puzzle;
  }

  /**
   * Verify the invariant exactly: shown nodes/edges are precisely the union of
   * the remaining words' canonical paths. Returns a list of problem strings
   * (empty when healthy).
   */
  function checkUnionInvariant(puzzle) {
    const problems = [];
    const wantNodes = new Set();
    const wantEdges = new Set();
    for (const word of puzzle.words) {
      if (word.found) continue;
      const ids = word.cellIds;
      for (let i = 0; i < ids.length; i++) {
        wantNodes.add(ids[i]);
        if (i > 0) wantEdges.add(edgeKey(ids[i - 1], ids[i]));
      }
    }
    const haveNodes = new Set(puzzle.cells.map(c => c.id));
    const haveEdges = new Set(puzzle.edges.map(e => edgeKey(e[0], e[1])));
    if (haveNodes.size !== puzzle.cells.length) problems.push('duplicate node id on board');
    if (haveEdges.size !== puzzle.edges.length) problems.push('duplicate edge on board');
    for (const id of wantNodes) if (!haveNodes.has(id)) problems.push('missing node ' + id);
    for (const id of haveNodes) if (!wantNodes.has(id)) problems.push('orphan node ' + id);
    for (const k of wantEdges) if (!haveEdges.has(k)) problems.push('missing edge ' + k);
    for (const k of haveEdges) if (!wantEdges.has(k)) problems.push('orphan edge ' + k);
    // Shown edges must connect lattice-adjacent cells.
    const byId = new Map(puzzle.cells.map(c => [c.id, c]));
    for (const [a, b] of puzzle.edges) {
      const ca = byId.get(a);
      const cb = byId.get(b);
      if (!ca || !cb) { problems.push('edge to unknown node ' + edgeKey(a, b)); continue; }
      if (!areAdjacent(ca, cb)) problems.push('non-adjacent edge ' + edgeKey(a, b));
    }
    const seen = new Set();
    for (const c of puzzle.cells) {
      const k = key(c.x, c.y);
      if (seen.has(k)) problems.push('two cells at ' + k);
      seen.add(k);
    }
    return problems;
  }

  /* ------------------------------------------------------------------ *
   * Crossing diagonals
   * ------------------------------------------------------------------ */

  /** Every pair of shown diagonals that visually cross (should always be []). */
  function findCrossingEdgePairs(cells, edges) {
    const map = cellMap(cells);
    const present = new Set(edges.map(e => edgeKey(e[0], e[1])));
    const crossings = [];
    for (const a of cells) {
      const b = map.get(key(a.x + 1, a.y));
      const c = map.get(key(a.x, a.y + 1));
      const d = map.get(key(a.x + 1, a.y + 1));
      if (!b || !c || !d) continue;
      if (present.has(edgeKey(a.id, d.id)) && present.has(edgeKey(b.id, c.id))) {
        crossings.push([[a.id, d.id], [b.id, c.id]]);
      }
    }
    return crossings;
  }

  function hasCrossing(cells, edges) {
    return findCrossingEdgePairs(cells, edges).length > 0;
  }

  /* ------------------------------------------------------------------ *
   * Graph queries
   * ------------------------------------------------------------------ */
  function adjacencyMap(cells, edges) {
    const adj = new Map();
    for (const cell of cells) adj.set(cell.id, new Set());
    for (const [a, b] of edges) {
      if (adj.has(a)) adj.get(a).add(b);
      if (adj.has(b)) adj.get(b).add(a);
    }
    return adj;
  }

  /** Connected components of the SHOWN graph (edges only, not adjacency). */
  function edgeComponents(cells, edges) {
    const adj = adjacencyMap(cells, edges);
    const byId = new Map(cells.map(c => [c.id, c]));
    const seen = new Set();
    const comps = [];
    for (const cell of cells) {
      if (seen.has(cell.id)) continue;
      const stack = [cell.id];
      const comp = [];
      seen.add(cell.id);
      while (stack.length) {
        const id = stack.pop();
        comp.push(byId.get(id));
        for (const next of adj.get(id) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
      comps.push(comp);
    }
    return comps;
  }

  /** Does some traceable route spelling `word` exist along shown edges? */
  function findRoute(cells, edges, word) {
    const adj = adjacencyMap(cells, edges);
    const byId = new Map(cells.map(c => [c.id, c]));
    const target = String(word).toLowerCase();
    const used = new Set();
    const path = [];
    let budget = 300000;

    function walk(index, cellId) {
      if (budget-- <= 0) return false;
      path.push(cellId);
      used.add(cellId);
      if (index === target.length - 1) return true;
      for (const next of adj.get(cellId)) {
        if (used.has(next)) continue;
        const cell = byId.get(next);
        if (!cell || cell.letter !== target[index + 1]) continue;
        if (walk(index + 1, next)) return true;
      }
      path.pop();
      used.delete(cellId);
      return false;
    }

    for (const cell of cells) {
      if (cell.letter !== target[0]) continue;
      path.length = 0;
      used.clear();
      if (walk(0, cell.id)) return path.slice();
    }
    return null;
  }

  function isTraceable(cells, edges, word) {
    return findRoute(cells, edges, word) !== null;
  }

  /** Is an ordered list of node ids a legal trace along shown edges? */
  function isValidTrace(cells, edges, cellIds) {
    if (!Array.isArray(cellIds) || cellIds.length < 1) return false;
    const present = new Set(edges.map(e => edgeKey(e[0], e[1])));
    const ids = new Set(cells.map(c => c.id));
    const seen = new Set();
    for (let i = 0; i < cellIds.length; i++) {
      if (!ids.has(cellIds[i])) return false;
      if (seen.has(cellIds[i])) return false;
      seen.add(cellIds[i]);
      if (i > 0 && !present.has(edgeKey(cellIds[i - 1], cellIds[i]))) return false;
    }
    return true;
  }

  function traceToWord(cells, cellIds) {
    const byId = new Map(cells.map(c => [c.id, c]));
    return cellIds.map(id => (byId.get(id) ? byId.get(id).letter : '')).join('');
  }

  /* ------------------------------------------------------------------ *
   * Board under construction
   * ------------------------------------------------------------------ */
  function createBoard(cols, rows) {
    return {
      cols: cols,
      rows: rows,
      occ: new Map(),          // "x,y" -> { x, y, letter }
      edges: new Set(),        // coord edge keys
      letterCounts: new Map(),
      paths: []                // [{ text, path: [{x,y,letter}] }]
    };
  }

  function coordEdgeKey(ax, ay, bx, by) {
    const ka = key(ax, ay);
    const kb = key(bx, by);
    return ka < kb ? ka + '|' + kb : kb + '|' + ka;
  }

  function commitPath(board, text, path) {
    for (const cell of path) {
      const k = key(cell.x, cell.y);
      if (!board.occ.has(k)) {
        board.occ.set(k, { x: cell.x, y: cell.y, letter: cell.letter });
        board.letterCounts.set(cell.letter, (board.letterCounts.get(cell.letter) || 0) + 1);
      }
    }
    for (let i = 1; i < path.length; i++) {
      board.edges.add(coordEdgeKey(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y));
    }
    board.paths.push({ text: text, path: path.map(p => ({ x: p.x, y: p.y, letter: p.letter })) });
  }

  /**
   * Randomized DFS over (cell, letterIndex).
   *
   * From the current cell, the next letter may go to
   *   (a) an EXISTING node holding that letter in an adjacent cell (preferred:
   *       this is what creates sharing), or
   *   (b) an adjacent empty cell (a new node).
   * The path is self-avoiding, stays inside the lattice box, must reuse at
   * least `minReuse` existing nodes, and may never create a diagonal that
   * visually crosses another shown diagonal.
   */
  function routeWord(board, text, rng, minReuse, budgetLimit, maxNew) {
    const n = text.length;
    const path = [];
    const inPath = new Map();      // "x,y" -> letter
    const pathEdges = new Set();
    const newCap = maxNew == null ? Infinity : maxNew;
    let reuse = 0;
    let fresh = 0;
    let budget = budgetLimit;

    function nodeLetterAt(x, y) {
      const k = key(x, y);
      const existing = board.occ.get(k);
      if (existing) return existing.letter;
      if (inPath.has(k)) return inPath.get(k);
      return null;
    }

    function hasEdgeBetween(ax, ay, bx, by) {
      const k = coordEdgeKey(ax, ay, bx, by);
      return board.edges.has(k) || pathEdges.has(k);
    }

    /** Would the step a->b be a diagonal crossing an existing shown diagonal? */
    function crosses(ax, ay, bx, by) {
      if (!isDiagonalStep(ax, ay, bx, by)) return false;
      const c1x = ax, c1y = by;
      const c2x = bx, c2y = ay;
      if (nodeLetterAt(c1x, c1y) === null) return false;
      if (nodeLetterAt(c2x, c2y) === null) return false;
      return hasEdgeBetween(c1x, c1y, c2x, c2y);
    }

    function neighbourCount(x, y) {
      let count = 0;
      for (const off of OFFSETS) {
        if (nodeLetterAt(x + off[0], y + off[1]) !== null) count++;
      }
      return count;
    }

    function candidates(from, letter) {
      const out = [];
      for (const off of OFFSETS) {
        const nx = from.x + off[0];
        const ny = from.y + off[1];
        if (nx < 0 || ny < 0 || nx >= board.cols || ny >= board.rows) continue;
        const k = key(nx, ny);
        if (inPath.has(k)) continue;
        const existing = board.occ.get(k);
        if (existing && existing.letter !== letter) continue;
        if (crosses(from.x, from.y, nx, ny)) continue;
        const isReuse = !!existing;
        const score = (isReuse ? 6 : 0) + neighbourCount(nx, ny) * 0.5 + rng() * 1.6;
        out.push({ x: nx, y: ny, letter: letter, reuse: isReuse, score: score });
      }
      out.sort((a, b) => b.score - a.score);
      return out;
    }

    function push(cell) {
      const prev = path.length ? path[path.length - 1] : null;
      path.push(cell);
      inPath.set(key(cell.x, cell.y), cell.letter);
      if (prev) pathEdges.add(coordEdgeKey(prev.x, prev.y, cell.x, cell.y));
      if (cell.reuse) reuse++; else fresh++;
    }

    function pop() {
      const cell = path.pop();
      inPath.delete(key(cell.x, cell.y));
      const prev = path.length ? path[path.length - 1] : null;
      if (prev) pathEdges.delete(coordEdgeKey(prev.x, prev.y, cell.x, cell.y));
      if (cell.reuse) reuse--; else fresh--;
    }

    function extend(index) {
      if (index === n - 1) return reuse >= minReuse;
      if (budget-- <= 0) return false;
      if (reuse + (n - 1 - index) < minReuse) return false;
      if (fresh > newCap) return false;
      const from = path[index];
      for (const cand of candidates(from, text[index + 1])) {
        push(cand);
        if (extend(index + 1)) return true;
        pop();
      }
      return false;
    }

    // Start cells: prefer existing nodes carrying the first letter.
    const starts = [];
    for (const cell of board.occ.values()) {
      if (cell.letter === text[0]) {
        starts.push({ x: cell.x, y: cell.y, letter: text[0], reuse: true, score: 6 + rng() });
      }
    }
    if (minReuse <= 0 || starts.length < 6) {
      // Empty cells hugging the cluster (or, for the first word, near centre).
      const seen = new Set();
      if (board.occ.size === 0) {
        // The grid is tiny: every cell is a plausible start for the snake.
        for (let x = 0; x < board.cols; x++) {
          for (let y = 0; y < board.rows; y++) {
            starts.push({ x: x, y: y, letter: text[0], reuse: false, score: rng() });
          }
        }
      } else {
        for (const cell of board.occ.values()) {
          for (const off of OFFSETS) {
            const nx = cell.x + off[0];
            const ny = cell.y + off[1];
            if (nx < 0 || ny < 0 || nx >= board.cols || ny >= board.rows) continue;
            const k = key(nx, ny);
            if (board.occ.has(k) || seen.has(k)) continue;
            seen.add(k);
            starts.push({ x: nx, y: ny, letter: text[0], reuse: false, score: rng() * 1.2 });
          }
        }
      }
    }
    starts.sort((a, b) => b.score - a.score);
    const limited = starts.slice(0, 26);

    for (const start of limited) {
      path.length = 0;
      inPath.clear();
      pathEdges.clear();
      reuse = 0;
      push(start);
      if (n === 1 ? reuse >= minReuse : extend(0)) {
        return path.map(p => ({ x: p.x, y: p.y, letter: p.letter }));
      }
      pop();
      if (budget <= 0) break;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Word pools
   * ------------------------------------------------------------------ */
  function usableWords(list, minLen, maxLen) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const w = raw.toLowerCase();
      if (w.length < minLen || w.length > maxLen) continue;
      if (!/^[a-z]+$/.test(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
    }
    return out;
  }

  function resolvePools(opts) {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const rawCommon = (opts.words && opts.words.length) ? opts.words
      : (Array.isArray(g.ZAN_COMMON) && g.ZAN_COMMON.length ? g.ZAN_COMMON : FALLBACK_COMMON);
    let rawLong = (opts.longWords && opts.longWords.length) ? opts.longWords
      : (Array.isArray(g.ZAN_COMMON_LONG) && g.ZAN_COMMON_LONG.length ? g.ZAN_COMMON_LONG : null);

    const regular = usableWords(rawCommon, CONFIG.regularMin, CONFIG.regularMax);
    if (!rawLong) {
      // Old data contract (no ZAN_COMMON_LONG): mine long words from whatever
      // we were given, else fall back to the embedded list.
      const mined = usableWords(rawCommon, CONFIG.longMin, CONFIG.longMax);
      rawLong = mined.length >= 4 ? mined : FALLBACK_LONG;
    }
    const long = usableWords(rawLong, CONFIG.longMin, CONFIG.longMax);
    return {
      regular: regular.length ? regular : usableWords(FALLBACK_COMMON, CONFIG.regularMin, CONFIG.regularMax),
      long: long.length ? long : usableWords(FALLBACK_LONG, CONFIG.longMin, CONFIG.longMax)
    };
  }

  /** Cheap prefilter: does the word share >= 2 letters with what's on board? */
  function sharesEnough(word, letterCounts) {
    let shared = 0;
    const seen = new Set();
    for (const ch of word) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      if (letterCounts.has(ch)) shared++;
      if (shared >= 2) return true;
    }
    return false;
  }

  /**
   * Saturation prefilter: the word's letter multiset must be a SUBSET of the
   * grid's letter multiset. A path is self-avoiding, so each letter instance
   * needs its own cell — a word needing two E's cannot be routed on a grid
   * holding one. Necessary (not sufficient); the tiny DFS decides the rest.
   */
  function multisetFits(word, letterCounts) {
    const need = new Map();
    for (const ch of word) {
      const n = (need.get(ch) || 0) + 1;
      if (n > (letterCounts.get(ch) || 0)) return false;
      need.set(ch, n);
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Generation — a fixed 5 x 5 grid, built in three phases
   * ------------------------------------------------------------------ */

  /** Phase 0: lay the 8-11 letter base word as a self-avoiding snake. */
  function placeBaseWord(board, pools, rng) {
    for (let attempt = 0; attempt < 26; attempt++) {
      const candidate = pools.long[Math.floor(rng() * pools.long.length)];
      const path = routeWord(board, candidate, rng, 0, CONFIG.longRouteBudget, null);
      if (path) {
        commitPath(board, candidate, path);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Phase 1 (grow): add 4-7 letter words, strongly preferring routes that
   * reuse >= 2 existing cells and add few new ones, until the grid is full or
   * the word cap is reached.
   */
  function growWords(board, pools, rng, used, cap) {
    const capacity = board.cols * board.rows;
    let attempts = 0;
    let sinceGrowth = 0;
    while (board.paths.length < cap && attempts < CONFIG.growAttempts) {
      attempts++;
      const candidate = pools.regular[Math.floor(rng() * pools.regular.length)];
      if (used.has(candidate)) continue;
      if (!sharesEnough(candidate, board.letterCounts) && rng() < 0.8) continue;
      const free = capacity - board.occ.size;
      if (free <= 0) break;                       // grid full: phase 2 takes over
      const before = board.occ.size;
      // Prefer adding as few new cells as we can get away with.
      const maxNew = Math.min(candidate.length - 2, free);
      let path = routeWord(board, candidate, rng, 2, CONFIG.routeBudget, maxNew);
      if (!path) path = routeWord(board, candidate, rng, 1, CONFIG.routeBudgetRelaxed, maxNew);
      if (!path) continue;
      commitPath(board, candidate, path);
      used.add(candidate);
      sinceGrowth = board.occ.size > before ? 0 : sinceGrowth + 1;
      if (sinceGrowth > 6 && board.occ.size >= capacity - 1) break;
    }
  }

  /**
   * Phase 2 (saturate): scan the vocabulary for words routable with ZERO new
   * cells — pure reuse of what is already on the grid — until the cap is hit.
   * Each DFS runs over <= 25 cells, so a full vocabulary scan is cheap; it is
   * still time-boxed and offset-randomized so different puzzles saturate
   * differently.
   */
  function saturate(board, pools, rng, used, cap, deadline) {
    const pool = pools.regular;
    const limit = Math.min(pool.length, CONFIG.saturateScan);
    const offset = Math.floor(rng() * pool.length);
    let scanned = 0;
    for (let i = 0; i < limit && board.paths.length < cap; i++) {
      const candidate = pool[(offset + i) % pool.length];
      if (used.has(candidate)) continue;
      if (!multisetFits(candidate, board.letterCounts)) continue;
      const path = routeWord(board, candidate, rng, candidate.length, CONFIG.saturateBudget, 0);
      if (path) {
        commitPath(board, candidate, path);
        used.add(candidate);
      }
      // Only real DFS runs cost anything; check the clock occasionally.
      if ((++scanned & 31) === 0 && deadline && Date.now() > deadline) break;
    }
  }

  function buildBoard(pools, rng, cap, size, deadline) {
    const board = createBoard(size, size);
    const longText = placeBaseWord(board, pools, rng);
    if (!longText) return null;
    const used = new Set([longText]);
    growWords(board, pools, rng, used, cap);
    saturate(board, pools, rng, used, cap, deadline);
    return { board: board, longText: longText };
  }

  /**
   * Score a candidate board. Word count is a hard requirement handled by the
   * caller; among valid boards we prefer fuller grids, more letter sharing
   * (letters placed per cell used) and more words.
   */
  function scoreBoard(board, minWords, maxWords) {
    const cells = board.occ.size;
    const words = board.paths.length;
    const letters = board.paths.reduce((sum, p) => sum + p.path.length, 0);
    const sharePerCell = cells ? letters / cells : 0;
    const base = words >= minWords ? 1000 : words * 8;
    return base + cells * 6 + sharePerCell * 14 + Math.min(words, maxWords) * 3;
  }

  function materialize(board, longText) {
    const idByCoord = new Map();
    const allCells = [];
    let nextId = 1;
    for (const cell of board.occ.values()) {
      const node = { id: nextId++, x: cell.x, y: cell.y, letter: cell.letter };
      idByCoord.set(key(cell.x, cell.y), node.id);
      allCells.push(node);
    }
    const words = board.paths.map(p => ({
      text: p.text,
      cellIds: p.path.map(c => idByCoord.get(key(c.x, c.y))),
      found: false,
      isLong: p.text === longText
    }));
    // The base word leads the list.
    words.sort((a, b) => (b.isLong ? 1 : 0) - (a.isLong ? 1 : 0));
    const puzzle = {
      allCells: allCells,
      cells: [],
      edges: [],
      words: words,
      longWord: longText,
      gridSize: board.cols,
      cellsUsed: allCells.length
    };
    computeUnion(puzzle);
    recenter(puzzle);
    return puzzle;
  }

  function generatePuzzle(options) {
    const opts = options || {};
    const rng = opts.rng || createRng(Math.floor(Math.random() * 0xffffffff));
    const pools = resolvePools(opts);
    const size = opts.size || CONFIG.size;
    const minWords = opts.minWords || CONFIG.minWords;
    // Vary the per-puzzle target so games don't all land on the 16-word cap.
    const maxWords = opts.maxWords ||
      (CONFIG.maxWords - 4 + Math.floor(rng() * 5)); // 12..16
    const restarts = opts.restarts || CONFIG.restarts;
    const capacity = size * size;
    const started = Date.now();
    const deadline = started + (opts.timeBudgetMs || CONFIG.timeBudgetMs);

    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < restarts; attempt++) {
      const built = buildBoard(pools, rng, maxWords, size, deadline);
      if (!built) continue;
      const score = scoreBoard(built.board, minWords, maxWords);
      if (score > bestScore) {
        bestScore = score;
        best = built;
      }
      const words = built.board.paths.length;
      // A full grid with a healthy word set is as good as it gets — stop early.
      if (words >= minWords && built.board.occ.size >= capacity) break;
      // Past the polish budget, the first acceptable board wins. Word count is
      // never relaxed here; only the hunt for a fuller grid is cut short.
      if (words >= minWords && Date.now() > deadline) break;
    }
    if (!best) return null;
    if (best.board.paths.length < minWords && best.board.paths.length < 2) return null;
    return materialize(best.board, best.longText);
  }

  /* ------------------------------------------------------------------ *
   * Removal + compaction
   * ------------------------------------------------------------------ */
  function centroidOf(cells) {
    let sx = 0;
    let sy = 0;
    for (const c of cells) { sx += c.x; sy += c.y; }
    return { x: sx / cells.length, y: sy / cells.length };
  }

  function recenter(puzzle) {
    if (!puzzle.cells.length) return;
    let minX = Infinity;
    let minY = Infinity;
    for (const c of puzzle.cells) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
    }
    if (minX === 0 && minY === 0) return;
    for (const c of puzzle.cells) {
      c.x -= minX;
      c.y -= minY;
    }
  }

  function tryShift(puzzle, comp, dx, dy) {
    const compIds = new Set(comp.map(c => c.id));
    const blocked = new Set();
    for (const cell of puzzle.cells) {
      if (!compIds.has(cell.id)) blocked.add(key(cell.x, cell.y));
    }
    for (const cell of comp) {
      if (blocked.has(key(cell.x + dx, cell.y + dy))) return false;
    }
    for (const cell of comp) { cell.x += dx; cell.y += dy; }
    if (hasCrossing(puzzle.cells, puzzle.edges)) {
      for (const cell of comp) { cell.x -= dx; cell.y -= dy; }
      return false;
    }
    return true;
  }

  /**
   * Slide whole edge-connected components toward the centroid, one lattice
   * step at a time. Components move rigidly, so every remaining word keeps its
   * canonical route. Nodes may end up lattice-adjacent without an edge — that
   * is correct in this model (no line drawn, no traversal allowed).
   */
  function collapse(puzzle) {
    if (!puzzle.cells.length) {
      puzzle.edges = [];
      return puzzle;
    }
    for (let iter = 0; iter < 200; iter++) {
      const comps = edgeComponents(puzzle.cells, puzzle.edges);
      if (comps.length <= 1) break;
      const target = centroidOf(puzzle.cells);
      comps.sort((a, b) => {
        const ca = centroidOf(a);
        const cb = centroidOf(b);
        return Math.hypot(cb.x - target.x, cb.y - target.y) - Math.hypot(ca.x - target.x, ca.y - target.y);
      });
      let movedAny = false;
      for (const comp of comps) {
        const c = centroidOf(comp);
        const dx = Math.abs(c.x - target.x) < 0.45 ? 0 : (c.x < target.x ? 1 : -1);
        const dy = Math.abs(c.y - target.y) < 0.45 ? 0 : (c.y < target.y ? 1 : -1);
        const tries = [[dx, dy], [dx, 0], [0, dy]];
        for (const [mx, my] of tries) {
          if (mx === 0 && my === 0) continue;
          if (tryShift(puzzle, comp, mx, my)) { movedAny = true; break; }
        }
      }
      if (!movedAny) break;
    }
    recenter(puzzle);
    return puzzle;
  }

  /**
   * Mark a word as found, recompute the union, compact the board.
   * Returns { removedIds, removedEdgeKeys, moved } for the renderer.
   */
  function removeWord(puzzle, wordIndex) {
    const word = puzzle.words[wordIndex];
    if (!word || word.found) return null;
    const beforeNodes = new Set(puzzle.cells.map(c => c.id));
    const beforeEdges = new Set(puzzle.edges.map(e => edgeKey(e[0], e[1])));
    const beforePos = new Map(puzzle.cells.map(c => [c.id, { x: c.x, y: c.y }]));

    word.found = true;
    computeUnion(puzzle);

    const stillNodes = new Set(puzzle.cells.map(c => c.id));
    const stillEdges = new Set(puzzle.edges.map(e => edgeKey(e[0], e[1])));
    const removedIds = [];
    for (const id of beforeNodes) if (!stillNodes.has(id)) removedIds.push(id);
    const removedEdgeKeys = [];
    for (const k of beforeEdges) if (!stillEdges.has(k)) removedEdgeKeys.push(k);

    collapse(puzzle);

    const moved = [];
    for (const c of puzzle.cells) {
      const prev = beforePos.get(c.id);
      if (prev && (prev.x !== c.x || prev.y !== c.y)) {
        moved.push({ id: c.id, fromX: prev.x, fromY: prev.y, toX: c.x, toY: c.y });
      }
    }
    return { removedIds: removedIds, removedEdgeKeys: removedEdgeKeys, moved: moved };
  }

  function findWordIndex(puzzle, text) {
    const t = String(text).toLowerCase();
    for (let i = 0; i < puzzle.words.length; i++) {
      if (!puzzle.words[i].found && puzzle.words[i].text === t) return i;
    }
    return -1;
  }

  function longestWord(puzzle) {
    return puzzle.words.find(w => w.isLong) || null;
  }

  function clonePuzzle(puzzle) {
    const allCells = puzzle.allCells.map(c => Object.assign({}, c));
    const clone = {
      allCells: allCells,
      cells: [],
      edges: [],
      longWord: puzzle.longWord,
      words: puzzle.words.map(w => ({
        text: w.text,
        cellIds: w.cellIds.slice(),
        found: w.found,
        isLong: w.isLong
      }))
    };
    computeUnion(clone);
    return clone;
  }

  return {
    CONFIG: CONFIG,
    FALLBACK_COMMON: FALLBACK_COMMON,
    FALLBACK_LONG: FALLBACK_LONG,
    FALLBACK_EXTRA: FALLBACK_EXTRA,
    createRng: createRng,
    shuffled: shuffled,
    areAdjacent: areAdjacent,
    edgeKey: edgeKey,
    cellMap: cellMap,
    computeUnion: computeUnion,
    checkUnionInvariant: checkUnionInvariant,
    findCrossingEdgePairs: findCrossingEdgePairs,
    hasCrossing: hasCrossing,
    adjacencyMap: adjacencyMap,
    edgeComponents: edgeComponents,
    findRoute: findRoute,
    isTraceable: isTraceable,
    isValidTrace: isValidTrace,
    traceToWord: traceToWord,
    multisetFits: multisetFits,
    scoreBoard: scoreBoard,
    generatePuzzle: generatePuzzle,
    collapse: collapse,
    recenter: recenter,
    removeWord: removeWord,
    findWordIndex: findWordIndex,
    longestWord: longestWord,
    clonePuzzle: clonePuzzle
  };
});
