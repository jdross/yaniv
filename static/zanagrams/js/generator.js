/* Zanagrams — puzzle generator (pure logic, works in browser and Node).
 *
 * A puzzle is a set of required words laid out as one connected cluster of
 * letter cells on a square lattice. Every required word is placed as a
 * self-avoiding path of 8-adjacent cells, so a traceable route is guaranteed
 * by construction. Graph edges are every 8-adjacency between occupied cells,
 * minus one of each pair of visually crossing diagonals.
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
   * Fallback word data (kept tiny; the real lists live in data/*.js)
   * ------------------------------------------------------------------ */
  const FALLBACK_COMMON = [
    'cat', 'dog', 'sun', 'hat', 'run', 'cup', 'pen', 'map', 'bed', 'jar',
    'tree', 'blue', 'fire', 'moon', 'rain', 'star', 'lamp', 'ship', 'gold', 'wind',
    'apple', 'bread', 'chair', 'dance', 'eagle', 'grape', 'house', 'light', 'music', 'ocean',
    'candle', 'forest', 'garden', 'island', 'orange', 'planet', 'silver', 'winter',
    'diamond', 'journey', 'kitchen', 'morning'
  ];

  const FALLBACK_EXTRA = [
    'are', 'ate', 'ear', 'eat', 'era', 'net', 'ten', 'tan', 'ant', 'nap', 'pan', 'tap',
    'pat', 'rat', 'tar', 'art', 'oar', 'ore', 'roe', 'toe', 'ton', 'not', 'one', 'eon',
    'lit', 'til', 'tin', 'nit', 'sin', 'ins', 'sir', 'sit', 'its', 'rise', 'sire', 'tile',
    'lite', 'rite', 'tier', 'tire', 'star', 'rats', 'arts', 'tars', 'note', 'tone', 'nose'
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

  function isDiagonal(ax, ay, bx, by) {
    return ax !== bx && ay !== by;
  }

  function areAdjacent(a, b) {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return (dx <= 1 && dy <= 1) && (dx + dy) > 0;
  }

  /* ------------------------------------------------------------------ *
   * Edge computation (with crossing-diagonal resolution)
   * ------------------------------------------------------------------ */

  /** Build a Map of "x,y" -> cell for the given cell list. */
  function cellMap(cells) {
    const map = new Map();
    for (const cell of cells) map.set(key(cell.x, cell.y), cell);
    return map;
  }

  /** Set of edgeKeys that must survive: the canonical routes of live words. */
  function reservedEdgeSet(words) {
    const reserved = new Set();
    for (const word of words) {
      if (word.found) continue;
      for (let i = 1; i < word.cellIds.length; i++) {
        reserved.add(edgeKey(word.cellIds[i - 1], word.cellIds[i]));
      }
    }
    return reserved;
  }

  /**
   * All 8-adjacency edges between occupied cells, dropping one diagonal from
   * every crossing pair. Reserved edges always win; ties break deterministically.
   */
  function computeEdges(cells, reserved) {
    const map = cellMap(cells);
    const res = reserved || new Set();
    const dropped = new Set();

    // Resolve crossings first.
    for (const cell of cells) {
      const a = cell;                                  // (x, y)
      const b = map.get(key(a.x + 1, a.y));            // (x+1, y)
      const c = map.get(key(a.x, a.y + 1));            // (x, y+1)
      const d = map.get(key(a.x + 1, a.y + 1));        // (x+1, y+1)
      if (!b || !c || !d) continue;
      const diagA = edgeKey(a.id, d.id);
      const diagB = edgeKey(b.id, c.id);
      const aRes = res.has(diagA);
      const bRes = res.has(diagB);
      if (aRes && bRes) continue;                      // must not happen; keep both live words safe
      if (aRes) dropped.add(diagB);
      else if (bRes) dropped.add(diagA);
      else dropped.add(diagB);                         // deterministic tie-break
    }

    const edges = [];
    const seen = new Set();
    for (const cell of cells) {
      for (const off of OFFSETS) {
        const other = map.get(key(cell.x + off[0], cell.y + off[1]));
        if (!other) continue;
        const ek = edgeKey(cell.id, other.id);
        if (seen.has(ek) || dropped.has(ek)) continue;
        seen.add(ek);
        edges.push([cell.id, other.id]);
      }
    }
    return edges;
  }

  /** True if two live-word routes would visually cross as diagonals. */
  function hasReservedCrossing(cells, reserved) {
    const map = cellMap(cells);
    for (const a of cells) {
      const b = map.get(key(a.x + 1, a.y));
      const c = map.get(key(a.x, a.y + 1));
      const d = map.get(key(a.x + 1, a.y + 1));
      if (!b || !c || !d) continue;
      if (reserved.has(edgeKey(a.id, d.id)) && reserved.has(edgeKey(b.id, c.id))) return true;
    }
    return false;
  }

  /** List every crossing diagonal pair present in an edge list (for tests). */
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

  /** Does a traceable route spelling `word` exist in the graph? */
  function findRoute(cells, edges, word) {
    const adj = adjacencyMap(cells, edges);
    const byId = new Map(cells.map(c => [c.id, c]));
    const target = String(word).toLowerCase();
    const used = new Set();
    const path = [];
    let budget = 200000;

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

  /** Is a specific ordered list of cell ids a legal trace? */
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

  function connectedComponents(cells) {
    const map = cellMap(cells);
    const seen = new Set();
    const comps = [];
    for (const cell of cells) {
      if (seen.has(cell.id)) continue;
      const stack = [cell];
      const comp = [];
      seen.add(cell.id);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const off of OFFSETS) {
          const nb = map.get(key(cur.x + off[0], cur.y + off[1]));
          if (nb && !seen.has(nb.id)) {
            seen.add(nb.id);
            stack.push(nb);
          }
        }
      }
      comps.push(comp);
    }
    return comps;
  }

  /* ------------------------------------------------------------------ *
   * Word selection
   * ------------------------------------------------------------------ */
  function pickWords(pool, count, rng, minLen, maxLen) {
    const usable = pool.filter(w => typeof w === 'string' && w.length >= minLen && w.length <= maxLen && /^[a-z]+$/.test(w));
    if (usable.length < count) return null;
    const byLength = new Map();
    for (const w of usable) {
      if (!byLength.has(w.length)) byLength.set(w.length, []);
      byLength.get(w.length).push(w);
    }
    const lengths = shuffled(Array.from(byLength.keys()), rng);
    const chosen = [];
    const seen = new Set();
    // Take at most a couple per length band so puzzles mix short and long words.
    for (const len of lengths) {
      if (chosen.length >= count) break;
      const bucket = byLength.get(len);
      const take = Math.min(2, count - chosen.length);
      for (let i = 0; i < take; i++) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const w = bucket[Math.floor(rng() * bucket.length)];
          if (!seen.has(w)) {
            seen.add(w);
            chosen.push(w);
            break;
          }
        }
      }
    }
    let guard = 0;
    while (chosen.length < count && guard++ < 200) {
      const w = usable[Math.floor(rng() * usable.length)];
      if (!seen.has(w)) {
        seen.add(w);
        chosen.push(w);
      }
    }
    if (chosen.length < count) return null;
    // Long words first: they are the hardest to place.
    chosen.sort((a, b) => b.length - a.length);
    return chosen;
  }

  /* ------------------------------------------------------------------ *
   * Placement
   * ------------------------------------------------------------------ */
  function tryPlaceWord(word, occ, reserved, rng, maxDim, bounds) {
    const n = word.length;
    const path = [];
    const pathKeys = new Map(); // "x,y" -> index in path
    let budget = 6000;

    const box = { minX: bounds.minX, maxX: bounds.maxX, minY: bounds.minY, maxY: bounds.maxY };

    function occupiedCell(x, y) {
      const k = key(x, y);
      if (occ.has(k)) return occ.get(k);
      if (pathKeys.has(k)) return path[pathKeys.get(k)];
      return null;
    }

    function edgeReserved(a, b) {
      if (!a || !b) return false;
      if (a.id != null && b.id != null && reserved.has(edgeKey(a.id, b.id))) return true;
      // consecutive cells of the word currently being laid down
      const ia = pathKeys.has(key(a.x, a.y)) ? pathKeys.get(key(a.x, a.y)) : -1;
      const ib = pathKeys.has(key(b.x, b.y)) ? pathKeys.get(key(b.x, b.y)) : -1;
      return ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1;
    }

    function fits(x, y) {
      const minX = Math.min(box.minX, x);
      const maxX = Math.max(box.maxX, x);
      const minY = Math.min(box.minY, y);
      const maxY = Math.max(box.maxY, y);
      return (maxX - minX + 1) <= maxDim && (maxY - minY + 1) <= maxDim;
    }

    function neighborScore(x, y) {
      let score = 0;
      for (const off of OFFSETS) {
        if (occupiedCell(x + off[0], y + off[1])) score++;
      }
      return score;
    }

    function extend(x, y) {
      if (budget-- <= 0) return false;
      const k = key(x, y);
      if (occ.has(k) || pathKeys.has(k)) return false;
      if (!fits(x, y)) return false;

      const prev = path.length ? path[path.length - 1] : null;
      if (prev && isDiagonal(prev.x, prev.y, x, y)) {
        // Would this diagonal cross a reserved diagonal of another word?
        const c1 = occupiedCell(prev.x, y);
        const c2 = occupiedCell(x, prev.y);
        if (c1 && c2 && edgeReserved(c1, c2)) return false;
      }

      const savedBox = { minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY };
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);

      const cell = { x: x, y: y, letter: word[path.length] };
      pathKeys.set(k, path.length);
      path.push(cell);

      if (path.length === n) return true;

      const candidates = shuffled(OFFSETS, rng)
        .map(off => ({ x: x + off[0], y: y + off[1] }))
        .map(p => ({ p: p, s: neighborScore(p.x, p.y) + rng() * 1.4 }))
        .sort((a, b) => b.s - a.s);

      for (const cand of candidates) {
        if (extend(cand.p.x, cand.p.y)) return true;
      }

      path.pop();
      pathKeys.delete(k);
      box.minX = savedBox.minX;
      box.maxX = savedBox.maxX;
      box.minY = savedBox.minY;
      box.maxY = savedBox.maxY;
      return false;
    }

    // Candidate start cells: free cells hugging the existing cluster.
    let starts;
    if (occ.size === 0) {
      starts = [{ x: 0, y: 0 }];
    } else {
      const set = new Map();
      for (const cell of occ.values()) {
        for (const off of OFFSETS) {
          const nx = cell.x + off[0];
          const ny = cell.y + off[1];
          const k = key(nx, ny);
          if (!occ.has(k) && !set.has(k)) set.set(k, { x: nx, y: ny });
        }
      }
      starts = shuffled(Array.from(set.values()), rng)
        .map(p => ({ p: p, s: neighborScore(p.x, p.y) + rng() * 1.4 }))
        .sort((a, b) => b.s - a.s)
        .map(o => o.p)
        .slice(0, 24);
    }

    for (const start of starts) {
      path.length = 0;
      pathKeys.clear();
      box.minX = bounds.minX;
      box.maxX = bounds.maxX;
      box.minY = bounds.minY;
      box.maxY = bounds.maxY;
      budget = 6000;
      if (extend(start.x, start.y)) {
        return { path: path.slice(), bounds: { minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY } };
      }
    }
    return null;
  }

  function layoutWords(wordList, rng, maxDim) {
    const occ = new Map();
    const reserved = new Set();
    const cells = [];
    const words = [];
    let nextId = 1;
    let bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    let first = true;

    for (const text of wordList) {
      const placed = tryPlaceWord(text, occ, reserved, rng, maxDim, bounds);
      if (!placed) return null;
      const wordIndex = words.length;
      const cellIds = [];
      for (let i = 0; i < placed.path.length; i++) {
        const p = placed.path[i];
        const cell = {
          id: nextId++,
          x: p.x,
          y: p.y,
          letter: p.letter,
          wordIndex: wordIndex,
          letterIndex: i
        };
        cells.push(cell);
        occ.set(key(cell.x, cell.y), cell);
        cellIds.push(cell.id);
      }
      for (let i = 1; i < cellIds.length; i++) reserved.add(edgeKey(cellIds[i - 1], cellIds[i]));
      words.push({ text: text, cellIds: cellIds, found: false });
      if (first) {
        bounds = placed.bounds;
        first = false;
      } else {
        bounds = placed.bounds;
      }
    }

    return { cells: cells, words: words };
  }

  /* ------------------------------------------------------------------ *
   * Public generation
   * ------------------------------------------------------------------ */
  function generatePuzzle(options) {
    const opts = options || {};
    const rng = opts.rng || createRng(Math.floor(Math.random() * 0xffffffff));
    const pool = (opts.words && opts.words.length ? opts.words : null) ||
      (typeof globalThis !== 'undefined' && globalThis.ZAN_COMMON && globalThis.ZAN_COMMON.length
        ? globalThis.ZAN_COMMON
        : FALLBACK_COMMON);
    const minLen = opts.minLen || 3;
    const maxLen = opts.maxLen || 7;
    const wordCount = opts.wordCount || (4 + Math.floor(rng() * 3)); // 4..6
    const maxAttempts = opts.maxAttempts || 60;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const chosen = opts.fixedWords || pickWords(pool, wordCount, rng, minLen, maxLen);
      if (!chosen) return null;
      const total = chosen.reduce((sum, w) => sum + w.length, 0);
      const maxDim = Math.max(5, Math.ceil(Math.sqrt(total)) + 2 + Math.floor(attempt / 8));
      const laid = layoutWords(chosen, rng, maxDim);
      if (!laid) continue;

      const puzzle = normalize(laid.cells, laid.words);
      recenter(puzzle);
      let ok = true;
      for (const word of puzzle.words) {
        if (!isTraceable(puzzle.cells, puzzle.edges, word.text)) { ok = false; break; }
      }
      if (!ok) continue;
      if (connectedComponents(puzzle.cells).length !== 1) continue;
      return puzzle;
    }
    return null;
  }

  function normalize(cells, words) {
    const reserved = reservedEdgeSet(words);
    const edges = computeEdges(cells, reserved);
    return { cells: cells, words: words, edges: edges };
  }

  /** Recompute the edge list from current cell positions + live word routes. */
  function refreshEdges(puzzle) {
    puzzle.edges = computeEdges(puzzle.cells, reservedEdgeSet(puzzle.words));
    return puzzle.edges;
  }

  /* ------------------------------------------------------------------ *
   * Removal + collapse
   * ------------------------------------------------------------------ */
  function centroidOf(cells) {
    let sx = 0;
    let sy = 0;
    for (const c of cells) { sx += c.x; sy += c.y; }
    return { x: sx / cells.length, y: sy / cells.length };
  }

  /**
   * Slide each connected component toward the global centroid one lattice step
   * at a time. Components move rigidly, so every remaining word keeps its route.
   */
  function collapse(puzzle) {
    const reserved = reservedEdgeSet(puzzle.words);
    if (puzzle.cells.length === 0) {
      puzzle.edges = [];
      return puzzle;
    }

    for (let iter = 0; iter < 300; iter++) {
      const comps = connectedComponents(puzzle.cells);
      if (comps.length <= 1) break;
      const target = centroidOf(puzzle.cells);
      // Move the piece furthest from the centre first.
      comps.sort((a, b) => {
        const ca = centroidOf(a);
        const cb = centroidOf(b);
        const da = Math.hypot(ca.x - target.x, ca.y - target.y);
        const db = Math.hypot(cb.x - target.x, cb.y - target.y);
        return db - da;
      });
      let movedAny = false;
      for (const comp of comps) {
        const c = centroidOf(comp);
        const dx = Math.abs(c.x - target.x) < 0.4 ? 0 : (c.x < target.x ? 1 : -1);
        const dy = Math.abs(c.y - target.y) < 0.4 ? 0 : (c.y < target.y ? 1 : -1);
        const tries = [[dx, dy], [dx, 0], [0, dy]];
        for (const [mx, my] of tries) {
          if (mx === 0 && my === 0) continue;
          if (tryShift(puzzle, comp, mx, my, reserved)) { movedAny = true; break; }
        }
      }
      if (!movedAny) break;
    }

    recenter(puzzle);
    puzzle.edges = computeEdges(puzzle.cells, reserved);
    return puzzle;
  }

  function tryShift(puzzle, comp, dx, dy, reserved) {
    const compIds = new Set(comp.map(c => c.id));
    const blocked = new Set();
    for (const cell of puzzle.cells) {
      if (!compIds.has(cell.id)) blocked.add(key(cell.x, cell.y));
    }
    for (const cell of comp) {
      if (blocked.has(key(cell.x + dx, cell.y + dy))) return false;
    }
    // Tentatively apply, then reject if it creates crossing live-word diagonals.
    for (const cell of comp) { cell.x += dx; cell.y += dy; }
    if (hasReservedCrossing(puzzle.cells, reserved)) {
      for (const cell of comp) { cell.x -= dx; cell.y -= dy; }
      return false;
    }
    return true;
  }

  function recenter(puzzle) {
    if (!puzzle.cells.length) return;
    let minX = Infinity;
    let minY = Infinity;
    for (const c of puzzle.cells) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
    }
    for (const c of puzzle.cells) {
      c.x -= minX;
      c.y -= minY;
    }
  }

  /**
   * Mark a required word as found, drop its canonical cells and collapse.
   * Returns { removedIds, moved } for the renderer.
   */
  function removeWord(puzzle, wordIndex) {
    const word = puzzle.words[wordIndex];
    if (!word || word.found) return null;
    word.found = true;
    const removed = new Set(word.cellIds);
    const before = new Map(puzzle.cells.map(c => [c.id, { x: c.x, y: c.y }]));
    puzzle.cells = puzzle.cells.filter(c => !removed.has(c.id));
    collapse(puzzle);
    const moved = [];
    for (const c of puzzle.cells) {
      const prev = before.get(c.id);
      if (prev && (prev.x !== c.x || prev.y !== c.y)) {
        moved.push({ id: c.id, fromX: prev.x, fromY: prev.y, toX: c.x, toY: c.y });
      }
    }
    return { removedIds: Array.from(removed), moved: moved };
  }

  function findWordIndex(puzzle, text) {
    const t = String(text).toLowerCase();
    for (let i = 0; i < puzzle.words.length; i++) {
      if (!puzzle.words[i].found && puzzle.words[i].text === t) return i;
    }
    return -1;
  }

  function clonePuzzle(puzzle) {
    return {
      cells: puzzle.cells.map(c => Object.assign({}, c)),
      words: puzzle.words.map(w => ({ text: w.text, cellIds: w.cellIds.slice(), found: w.found })),
      edges: puzzle.edges.map(e => e.slice())
    };
  }

  return {
    FALLBACK_COMMON: FALLBACK_COMMON,
    FALLBACK_EXTRA: FALLBACK_EXTRA,
    createRng: createRng,
    shuffled: shuffled,
    areAdjacent: areAdjacent,
    edgeKey: edgeKey,
    cellMap: cellMap,
    computeEdges: computeEdges,
    refreshEdges: refreshEdges,
    reservedEdgeSet: reservedEdgeSet,
    findCrossingEdgePairs: findCrossingEdgePairs,
    hasReservedCrossing: hasReservedCrossing,
    adjacencyMap: adjacencyMap,
    findRoute: findRoute,
    isTraceable: isTraceable,
    isValidTrace: isValidTrace,
    traceToWord: traceToWord,
    connectedComponents: connectedComponents,
    pickWords: pickWords,
    generatePuzzle: generatePuzzle,
    collapse: collapse,
    removeWord: removeWord,
    findWordIndex: findWordIndex,
    clonePuzzle: clonePuzzle
  };
});
