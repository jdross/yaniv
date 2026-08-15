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
    // The solvable set is DERIVED by enumeration, not by construction: we lay
    // down just enough words to shape the graph, then promote every common
    // word the finished board can spell. A denser construction spells far more
    // common words than the target allows (12 laid words -> ~27 traceable
    // commons), so construction stays deliberately sparse.
    constructMin: 5,
    constructMax: 7,
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
    restarts: 40,
    timeBudgetMs: 200,        // total wall-clock budget for polish restarts
    // Boards may leave gaps in the 5 x 5 — a hole-punched silhouette reads far
    // better than a solid block. minCells stops them from getting so sparse
    // that the puzzle turns into a thin thread.
    minCells: 14,
    fillWeight: 2,
    // Occupancy budget drawn per attempt. Keeping the ceiling below the 25-cell
    // capacity is what forces words to share letters instead of sprawling.
    budgetMin: 14,
    budgetMax: 20,
    // Boards below this quality score are re-rolled while the time budget
    // lasts; the best one found is used if none clears the bar.
    minFunScore: 78
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
  function createBoard(cols, rows, cellBudget) {
    return {
      cols: cols,
      rows: rows,
      // How many of the cols*rows cells this board is allowed to occupy.
      // Budgets below capacity are what give boards their gaps.
      cellBudget: Math.min(cellBudget || cols * rows, cols * rows),
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
   * Lexicon — dictionary + prefix index, built ONCE and reused
   * ------------------------------------------------------------------ */

  /**
   * A lexicon answers three questions in O(1):
   *   has(word)      is this a real word?
   *   isCommon(word) is it a word every player knows? (normal, never an extra)
   *   isPrefix(str)  could any real word start with this? (enumeration pruning)
   *
   * The prefix index is capped at PREFIX_DEPTH characters: the full prefix set
   * of a 220k-word list costs tens of megabytes, while the first few letters
   * do virtually all of the pruning work. Past that depth the DFS is already
   * confined to a handful of self-avoiding paths on <= 25 nodes.
   */
  const PREFIX_DEPTH = 5;

  function buildLexicon(dictRaw, commonList, longList) {
    const words = new Set();
    const prefixes = new Set();
    const common = new Set();

    function addWord(w) {
      if (!w) return;
      words.add(w);
      const n = Math.min(PREFIX_DEPTH, w.length);
      for (let i = 1; i <= n; i++) prefixes.add(w.slice(0, i));
    }

    if (typeof dictRaw === 'string' && dictRaw.length) {
      for (const w of dictRaw.split(/\s+/)) if (w) addWord(w.toLowerCase());
    } else if (Array.isArray(dictRaw)) {
      for (const w of dictRaw) if (w) addWord(String(w).toLowerCase());
    }
    for (const list of [commonList, longList]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        if (!raw) continue;
        const w = String(raw).toLowerCase();
        addWord(w);
        common.add(w);
      }
    }
    // Base-word screening. Every contiguous slice of the base word's path is
    // traceable, so a compound like "background" hands the board back/ground/
    // round for free — filler words that pad the count without being finds.
    // Prefer base words that embed few common words.
    const commonByLen = Array.from(common).filter(w => w.length >= 4);
    const baseWords = [];
    const baseRoomy = [];
    if (Array.isArray(longList)) {
      for (const raw of longList) {
        const w = String(raw).toLowerCase();
        let embedded = 0;
        for (const c of commonByLen) {
          if (c.length < w.length && w.indexOf(c) !== -1 && ++embedded > 1) break;
        }
        if (embedded === 0) baseWords.push(w);
        if (embedded <= 1) baseRoomy.push(w);
      }
    }
    // Fall back through progressively looser pools so a small vocabulary
    // (tests, offline fallback data) still has base words to choose from.
    const basePool = baseWords.length >= 40 ? baseWords
      : (baseRoomy.length >= 20 ? baseRoomy : null);

    return {
      size: words.size,
      commonSize: common.size,
      has: w => words.has(w),
      isCommon: w => common.has(w),
      isPrefix: p => (p.length > PREFIX_DEPTH ? true : prefixes.has(p)),
      words: words,
      common: common,
      baseWords: basePool
    };
  }

  /* ------------------------------------------------------------------ *
   * Puzzle quality ("is this board fun?")
   * ------------------------------------------------------------------ */

  /** Map a raw value onto 0..1 across [lo, hi]. */
  function ramp(value, lo, hi) {
    if (hi === lo) return 0;
    return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  }

  /* Endings that build a new word out of an existing one. Finding "print" and
   * then "printer" is not a second discovery — it's the same word again. Note
   * this is deliberately about SHARED ROOTS, not shared letters: race/trace,
   * live/olive and cell/cellar are different words that happen to overlap, and
   * those are fun to spot. */
  const DERIVED_SUFFIXES = [
    's', 'es', 'ed', 'd', 'ing', 'er', 'r', 'est', 'st',
    'ly', 'y', 'ness', 'ment', 'ful', 'less', 'able', 'ible',
    'ist', 'ize', 'ise', 'ion', 'tion', 'al'
  ];

  /* Pairs that look like stem + suffix but are unrelated words. The stem must
   * itself be 4+ letters to ever reach this check, which already rules out
   * most of them (letter/let, summer/sum, manner/man). */
  const NOT_DERIVED = new Set([
    'corn|corner', 'flow|flower', 'mast|master', 'moth|mother', 'numb|number',
    'cove|cover', 'part|party', 'count|county', 'brow|brown', 'butt|butter',
    'fast|faster', 'tow|tower', 'lift|lifter', 'hang|hanger', 'poem|poems',
    'stat|state', 'plan|plane', 'plan|planet', 'come|comet', 'cast|caste',
    'char|charm', 'form|former', 'mine|miner', 'pain|paint', 'rest|rester',
    'wine|winter', 'sting|stinger', 'cent|center', 'cove|covert', 'ward|warden'
  ]);

  /**
   * Is `long` just `short` wearing a suffix? Handles the usual spelling
   * adjustments: silent-e drop (bake -> baking), consonant doubling
   * (stop -> stopper) and y -> i (happy -> happier).
   */
  function isDerivedFrom(short, long) {
    if (long.length <= short.length) return false;
    if (NOT_DERIVED.has(short + '|' + long)) return false;
    const stems = [short];
    if (short.endsWith('e')) stems.push(short.slice(0, -1));
    if (short.endsWith('y')) stems.push(short.slice(0, -1) + 'i');
    const last = short[short.length - 1];
    if (last === short[short.length - 2]) stems.push(short.slice(0, -1));
    else stems.push(short + last);
    for (const stem of stems) {
      if (!long.startsWith(stem)) continue;
      const tail = long.slice(stem.length);
      if (tail && DERIVED_SUFFIXES.indexOf(tail) !== -1) return true;
    }
    return false;
  }

  /**
   * Play the board out in a couple of random orders and watch how it melts.
   * A solve that removes nothing is "inert": the counter ticks but the board
   * doesn't move. A handful is fine (letters are shared, that's the game); a
   * long run of them means the puzzle sits still while you work.
   */
  function meltFlow(puzzle) {
    const ORDERS = 2;
    let inert = 0;
    let solves = 0;
    let longestRun = 0;
    for (let pass = 0; pass < ORDERS; pass++) {
      const copy = clonePuzzleForSim(puzzle);
      const order = copy.words.map(w => w.text);
      // Deterministic shuffle per pass so scoring is stable for a given board.
      for (let i = order.length - 1; i > 0; i--) {
        const j = (i * 7 + pass * 13 + order.length) % (i + 1);
        const tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
      }
      let run = 0;
      for (const text of order) {
        const index = findWordIndex(copy, text);
        if (index < 0) continue;
        const result = removeWord(copy, index);
        solves++;
        if (!result || !result.removedIds.length) {
          inert++;
          run++;
          if (run > longestRun) longestRun = run;
        } else {
          run = 0;
        }
      }
    }
    return {
      inertShare: solves ? inert / solves : 0,
      longestInertRun: longestRun
    };
  }

  /** Structural clone deep enough for meltFlow to mutate freely. */
  function clonePuzzleForSim(puzzle) {
    return {
      cells: puzzle.cells.map(c => ({ id: c.id, x: c.x, y: c.y, letter: c.letter })),
      allCells: puzzle.allCells.map(c => ({ id: c.id, x: c.x, y: c.y, letter: c.letter })),
      edges: puzzle.edges.map(e => [e[0], e[1]]),
      words: puzzle.words.map(w => ({
        text: w.text,
        cellIds: w.cellIds.slice(),
        found: false,
        isLong: w.isLong
      })),
      gridSize: puzzle.gridSize,
      cellsUsed: puzzle.cellsUsed
    };
  }

  /**
   * Score a finished puzzle on the things that actually make it fun to play.
   * Returns { score (0-100), parts } so the generator can hold out for a good
   * board and so tests/tools can see WHY a board scored the way it did.
   *
   *  density    letters spelled per cell. A dense graph means every orb is
   *             pulling weight in several words — the whole point of the game.
   *  freshness  penalty for words contained in other words (print/printer):
   *             they inflate the count without being separate discoveries.
   *  melt       share of words that own at least one cell outright. A word
   *             that owns nothing removes nothing when solved, so the board
   *             sits still and the solve feels inert.
   *  variety    spread of word lengths, so a board isn't all four-letter words.
   *  extras     rare words available to stumble on for time back.
   */
  function scorePuzzle(puzzle, lexicon, extraCount) {
    const texts = puzzle.words.map(w => w.text);
    const letters = texts.reduce((sum, t) => sum + t.length, 0);
    const cells = puzzle.cells.length || 1;

    let subwordPairs = 0;
    for (let i = 0; i < texts.length; i++) {
      for (let j = 0; j < texts.length; j++) {
        if (i !== j && isDerivedFrom(texts[i], texts[j])) subwordPairs++;
      }
    }

    const flow = meltFlow(puzzle);
    const lengths = new Set(texts.map(t => t.length));

    const parts = {
      density: ramp(letters / cells, 2.6, 4.6),
      freshness: 1 - ramp(subwordPairs, 0, 4),
      // Two ways melting goes wrong: too many solves that change nothing, and
      // long stretches where the board sits still.
      melt: (ramp(1 - flow.inertShare, 0.3, 0.7) + (1 - ramp(flow.longestInertRun, 2, 6))) / 2,
      variety: ramp(lengths.size, 2, 5),
      extras: ramp(extraCount || 0, 6, 40)
    };
    const score = Math.round(
      parts.density * 32 +
      parts.freshness * 24 +
      parts.melt * 24 +
      parts.variety * 10 +
      parts.extras * 10
    );
    parts.subwordPairs = subwordPairs;
    parts.lettersPerCell = letters / cells;
    parts.inertShare = flow.inertShare;
    parts.longestInertRun = flow.longestInertRun;
    return { score: score, parts: parts };
  }

  /* ------------------------------------------------------------------ *
   * Enumeration — every word the board can actually spell
   * ------------------------------------------------------------------ */

  /**
   * Walk every self-avoiding path along the SHOWN edges and collect the ones
   * that spell a real word. This is the ground truth of "words that exist in
   * the puzzle": if the player can trace it, it is in here.
   *
   * Enumeration is monotone over a game: solving a word only removes nodes and
   * edges, so no new word can ever become traceable later.
   *
   * Returns Map(word -> route as an array of cell ids).
   */
  function enumerateWords(cells, edges, lexicon, options) {
    const opts = options || {};
    const minLen = opts.minLength || 4;
    const maxLen = opts.maxLength || 11;
    const adj = adjacencyMap(cells, edges);
    const byId = new Map(cells.map(c => [c.id, c]));
    const found = new Map();
    const path = [];
    const used = new Set();

    function walk(id, str) {
      path.push(id);
      used.add(id);
      if (str.length >= minLen && !found.has(str) && lexicon.has(str)) {
        found.set(str, path.slice());
      }
      if (str.length < maxLen) {
        for (const next of adj.get(id) || []) {
          if (used.has(next)) continue;
          const cell = byId.get(next);
          if (!cell) continue;
          const nextStr = str + cell.letter;
          if (!lexicon.isPrefix(nextStr)) continue;
          walk(next, nextStr);
        }
      }
      path.pop();
      used.delete(id);
    }

    for (const cell of cells) {
      if (!lexicon.isPrefix(cell.letter)) continue;
      walk(cell.id, cell.letter);
    }
    return found;
  }

  /** Just the common (normal-set-worthy) words the board can spell. */
  function enumerateCommon(cells, edges, lexicon, options) {
    const all = enumerateWords(cells, edges, lexicon, options);
    const out = new Map();
    for (const [word, route] of all) {
      if (lexicon.isCommon(word)) out.set(word, route);
    }
    return out;
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
    const capacity = board.cellBudget || board.cols * board.rows;
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

  function buildBoard(pools, rng, cap, size, deadline, cellBudget) {
    const board = createBoard(size, size, cellBudget);
    const longText = placeBaseWord(board, pools, rng);
    if (!longText) return null;
    const used = new Set([longText]);
    growWords(board, pools, rng, used, cap);
    saturate(board, pools, rng, used, cap, deadline);
    return { board: board, longText: longText };
  }

  /**
   * Score a finished candidate. Word count and the single-base-word rule are
   * hard requirements handled by the caller; among valid boards we prefer
   * fuller grids, more letter sharing, a word count sitting comfortably inside
   * the target band, and a richer supply of rare words to find as extras.
   */
  function scoreBoard(board, minWords, maxWords, stats) {
    const cells = board.occ.size;
    const letters = board.paths.reduce((sum, p) => sum + p.path.length, 0);
    const sharePerCell = cells ? letters / cells : 0;
    if (!stats) {
      // Legacy shape: score the construction alone.
      const words = board.paths.length;
      const base = words >= minWords ? 1000 : words * 8;
      return base + cells * 6 + sharePerCell * 14 + Math.min(words, maxWords) * 3;
    }
    const words = stats.normalCount;
    // Aim at this puzzle's own target rather than the middle of the band, so
    // word counts vary across games instead of clustering on the mean.
    const target = stats.targetWords != null ? stats.targetWords : (minWords + maxWords) / 2;
    const centred = Math.max(0, 8 - Math.abs(words - target));   // 0..8
    // The board does NOT have to fill the 5 x 5: holes give each puzzle its own
    // silhouette. Fill still carries a little weight so boards don't collapse
    // to the sparse minimum, but word count and letter sharing dominate.
    return 1000
      + cells * CONFIG.fillWeight
      + sharePerCell * 12
      + centred * 9
      + Math.min(stats.extraCount, 90) * 0.4;
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

  /**
   * Turn a constructed board into a finished puzzle.
   *
   * The normal (solvable) set is defined by COMMONNESS, not by construction
   * history: every common word the board can spell becomes a normal word, so a
   * player who traces "find" or "change" solves a word instead of being handed
   * a bonus. Extras are exclusively the rare dictionary words.
   *
   * Words that were laid down keep their constructed path; promoted words take
   * a route found by the enumerator. Both live inside the constructed graph, so
   * the union of the normal set is exactly that graph — which is what makes
   * enumeration valid for the whole game.
   *
   * Returns null when the board breaks a hard rule (word count outside the
   * band, or a second 8+ letter common word that would rival the base word).
   */
  function finishPuzzle(board, longText, lexicon, minWords, maxWords, minCells) {
    const puzzle = materialize(board, longText);
    const traceable = enumerateWords(puzzle.cells, puzzle.edges, lexicon);
    const commons = new Map();
    let extraCount = 0;
    for (const [word, route] of traceable) {
      if (lexicon.isCommon(word)) commons.set(word, route);
      else extraCount++;
    }

    // The base word must be the one and only long word in the solvable set.
    for (const word of commons.keys()) {
      if (word.length >= CONFIG.longMin && word !== longText) return null;
    }
    if (!commons.has(longText)) return null;
    if (commons.size < minWords || commons.size > maxWords) {
      return { rejected: true, normalCount: commons.size, puzzle: null };
    }
    // Gaps in the 5 x 5 are welcome, but a board this sparse stops reading as
    // a grid at all.
    if (puzzle.cells.length < (minCells || CONFIG.minCells)) {
      return { rejected: true, normalCount: commons.size, puzzle: null };
    }

    const placed = new Map(puzzle.words.map(w => [w.text, w]));
    const words = [];
    for (const [text, route] of commons) {
      const existing = placed.get(text);
      words.push(existing || {
        text: text,
        cellIds: route.slice(),
        found: false,
        isLong: text === longText,
        promoted: true
      });
    }
    // Any laid-down word must also be common, so it must have been enumerated;
    // if the vocabulary ever drifts, keep it rather than orphan its cells.
    for (const word of puzzle.words) {
      if (!commons.has(word.text)) words.push(word);
    }
    words.sort((a, b) => (b.isLong ? 1 : 0) - (a.isLong ? 1 : 0));
    puzzle.words = words;
    computeUnion(puzzle);
    recenter(puzzle);
    puzzle.cellsUsed = puzzle.cells.length;
    return {
      rejected: false,
      normalCount: words.length,
      extraCount: extraCount,
      puzzle: puzzle
    };
  }

  /* Lexicon cache: the prefix index costs ~120ms to build over the shipped
   * dictionary, so it is built once per word-list identity and reused. */
  let lexiconCache = null;
  function resolveLexicon(opts, pools) {
    if (opts.lexicon) return opts.lexicon;
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const dictRaw = opts.dictRaw != null ? opts.dictRaw : (g.ZAN_DICT_RAW || '');
    if (lexiconCache && lexiconCache.dictRaw === dictRaw &&
        lexiconCache.regular === pools.regular && lexiconCache.long === pools.long) {
      return lexiconCache.lexicon;
    }
    const lexicon = buildLexicon(dictRaw, pools.regular, pools.long);
    lexiconCache = { dictRaw: dictRaw, regular: pools.regular, long: pools.long, lexicon: lexicon };
    return lexicon;
  }

  function generatePuzzle(options) {
    const opts = options || {};
    const rng = opts.rng || createRng(Math.floor(Math.random() * 0xffffffff));
    let pools = resolvePools(opts);
    const lexicon = resolveLexicon(opts, pools);
    // Prefer base words that don't embed other common words (see buildLexicon).
    if (lexicon.baseWords && lexicon.baseWords.length) {
      const allowed = new Set(pools.long);
      const screened = lexicon.baseWords.filter(w => allowed.has(w));
      if (screened.length >= 20) pools = Object.assign({}, pools, { long: screened });
    }
    const size = opts.size || CONFIG.size;
    const minWords = opts.minWords || CONFIG.minWords;
    const minCells = opts.minCells || CONFIG.minCells;
    const maxWords = opts.maxWords || CONFIG.maxWords;
    // One target word count per puzzle, so games differ in size instead of all
    // landing on the middle of the band.
    const targetWords = opts.targetWords ||
      (minWords + Math.floor(rng() * (maxWords - minWords + 1)));
    const minFunScore = opts.minFunScore != null ? opts.minFunScore : CONFIG.minFunScore;
    const restarts = opts.restarts || CONFIG.restarts;
    const capacity = size * size;
    const deadline = Date.now() + (opts.timeBudgetMs || CONFIG.timeBudgetMs);

    // How many words to lay down before enumeration takes over. Nudged between
    // attempts: too many laid words spells too many commons, too few spells too
    // few, so the search walks itself into the band.
    let construct = CONFIG.constructMin +
      Math.floor(rng() * (CONFIG.constructMax - CONFIG.constructMin + 1));

    let best = null;
    let bestScore = -Infinity;
    let attempts = 0;
    let rejects = 0;
    for (let attempt = 0; attempt < restarts; attempt++) {
      attempts++;
      // Each attempt gets its own occupancy budget, so boards vary in
      // silhouette; the ceiling stays under capacity to force letter sharing.
      const budgetMin = Math.max(1, opts.budgetMin || CONFIG.budgetMin);
      const budgetMax = Math.min(capacity, opts.budgetMax || CONFIG.budgetMax);
      const cellBudget = budgetMin + Math.floor(rng() * Math.max(1, budgetMax - budgetMin + 1));
      const built = buildBoard(pools, rng, construct, size, deadline, cellBudget);
      if (!built) continue;
      const result = finishPuzzle(built.board, built.longText, lexicon, minWords, maxWords, minCells);
      if (!result) { rejects++; continue; }          // rival long word
      if (result.rejected) {
        rejects++;
        if (result.normalCount > maxWords && construct > 3) construct--;
        else if (result.normalCount < minWords && construct < CONFIG.constructMax + 2) construct++;
        continue;
      }
      // Quality gate: keep pulling new boards until one is actually fun to
      // play (dense, few subwords, words that melt something), rather than
      // settling for the first structurally valid grid.
      const quality = scorePuzzle(result.puzzle, lexicon, result.extraCount);
      const onTarget = Math.max(0, 6 - Math.abs(result.normalCount - targetWords));
      const score = quality.score + onTarget;
      if (score > bestScore) {
        bestScore = score;
        best = result.puzzle;
        best.quality = quality;
      }
      if (quality.score >= minFunScore && result.normalCount === targetWords) break;
      // No early exit on a full grid: filling all 25 cells is no longer the
      // goal, so every restart in the budget gets a fair shot at scoring.
      if (Date.now() > deadline) break;
    }
    if (best) {
      best.attempts = attempts;
      best.rejects = rejects;
      return best;
    }
    return null;
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
    PREFIX_DEPTH: PREFIX_DEPTH,
    buildLexicon: buildLexicon,
    enumerateWords: enumerateWords,
    enumerateCommon: enumerateCommon,
    multisetFits: multisetFits,
    scoreBoard: scoreBoard,
    scorePuzzle: scorePuzzle,
    finishPuzzle: finishPuzzle,
    generatePuzzle: generatePuzzle,
    collapse: collapse,
    recenter: recenter,
    removeWord: removeWord,
    findWordIndex: findWordIndex,
    longestWord: longestWord,
    clonePuzzle: clonePuzzle
  };
});
