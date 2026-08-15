/* Zanagrams — SVG rendering + animation (browser only). */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STEP = 100;
  const PAD = 78;

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (const k in attrs) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  function edgeKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function createRenderer(svg) {
    const gEdges = el('g', { class: 'layer-edges' });
    const gTrace = el('g', { class: 'layer-trace' });
    const gNodes = el('g', { class: 'layer-nodes' });
    const tracePath = el('polyline', { class: 'trace-line', points: '', fill: 'none' });
    gTrace.appendChild(tracePath);
    svg.appendChild(gEdges);
    svg.appendChild(gTrace);
    svg.appendChild(gNodes);

    const state = {
      puzzle: null,
      nodeEls: new Map(),   // id -> { g, disc, text }
      edgeEls: new Map(),   // key -> line
      pos: new Map(),       // id -> { x, y } in svg units
      view: { x: 0, y: 0, w: 600, h: 600 },
      anim: null
    };

    /* --------------------------- geometry --------------------------- */

    function targetPos(cell) {
      return { x: cell.x * STEP, y: cell.y * STEP };
    }

    function targetView(cells) {
      if (!cells.length) return state.view;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const c of cells) {
        const p = targetPos(c);
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      let w = (maxX - minX) + PAD * 2;
      let h = (maxY - minY) + PAD * 2;
      // Keep the board from ballooning when only a couple of letters remain.
      const min = 3.4 * STEP;
      if (w < min) { minX -= (min - w) / 2; w = min; }
      if (h < min) { minY -= (min - h) / 2; h = min; }
      return { x: minX - PAD, y: minY - PAD, w: w, h: h };
    }

    function applyView(v) {
      state.view = v;
      svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
    }

    /* --------------------------- elements --------------------------- */

    function makeNode(cell) {
      const g = el('g', { class: 'node' });
      g.dataset.id = String(cell.id);
      const hit = el('circle', { class: 'node-hit', r: 46, cx: 0, cy: 0 });
      const disc = el('circle', { class: 'node-disc', r: 33, cx: 0, cy: 0 });
      const text = el('text', { class: 'node-letter', x: 0, y: 1, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      text.textContent = cell.letter.toUpperCase();
      g.appendChild(hit);
      g.appendChild(disc);
      g.appendChild(text);
      gNodes.appendChild(g);
      return { g: g, disc: disc, text: text };
    }

    function syncNodes() {
      const live = new Set();
      for (const cell of state.puzzle.cells) {
        live.add(cell.id);
        if (!state.nodeEls.has(cell.id)) {
          state.nodeEls.set(cell.id, makeNode(cell));
          state.pos.set(cell.id, targetPos(cell));
          state.nodeEls.get(cell.id).g.classList.add('spawn');
        }
      }
      for (const [id, node] of state.nodeEls) {
        if (!live.has(id)) {
          node.g.remove();
          state.nodeEls.delete(id);
          state.pos.delete(id);
        }
      }
      placeNodes();
    }

    function placeNodes() {
      for (const [id, node] of state.nodeEls) {
        const p = state.pos.get(id);
        if (p) node.g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
      }
    }

    function syncEdges() {
      const wanted = new Map();
      for (const [a, b] of state.puzzle.edges) wanted.set(edgeKey(a, b), [a, b]);
      for (const [k, line] of state.edgeEls) {
        if (!wanted.has(k)) {
          line.remove();
          state.edgeEls.delete(k);
        }
      }
      for (const [k, pair] of wanted) {
        if (!state.edgeEls.has(k)) {
          const line = el('line', { class: 'edge fresh' });
          line.dataset.a = String(pair[0]);
          line.dataset.b = String(pair[1]);
          gEdges.appendChild(line);
          state.edgeEls.set(k, line);
          window.setTimeout(() => line.classList.remove('fresh'), 30);
        }
      }
      placeEdges();
    }

    function placeEdges() {
      for (const line of state.edgeEls.values()) {
        const a = state.pos.get(Number(line.dataset.a));
        const b = state.pos.get(Number(line.dataset.b));
        if (!a || !b) continue;
        line.setAttribute('x1', a.x);
        line.setAttribute('y1', a.y);
        line.setAttribute('x2', b.x);
        line.setAttribute('y2', b.y);
      }
    }

    /* --------------------------- public API --------------------------- */

    function setPuzzle(puzzle) {
      state.puzzle = puzzle;
      for (const node of state.nodeEls.values()) node.g.remove();
      for (const line of state.edgeEls.values()) line.remove();
      state.nodeEls.clear();
      state.edgeEls.clear();
      state.pos.clear();
      for (const cell of puzzle.cells) state.pos.set(cell.id, targetPos(cell));
      applyView(targetView(puzzle.cells));
      syncNodes();
      syncEdges();
      clearTrace();
    }

    function refresh() {
      syncNodes();
      syncEdges();
    }

    /** Tween node positions + viewBox to the puzzle's current layout. */
    function animateTo(duration, done) {
      if (state.anim) cancelAnimationFrame(state.anim);
      const from = new Map();
      const to = new Map();
      for (const cell of state.puzzle.cells) {
        const cur = state.pos.get(cell.id) || targetPos(cell);
        from.set(cell.id, { x: cur.x, y: cur.y });
        to.set(cell.id, targetPos(cell));
      }
      const viewFrom = Object.assign({}, state.view);
      const viewTo = targetView(state.puzzle.cells);
      const start = performance.now();

      function frame(now) {
        const raw = Math.min(1, (now - start) / duration);
        const t = easeOutCubic(raw);
        for (const [id, f] of from) {
          const tp = to.get(id);
          state.pos.set(id, { x: f.x + (tp.x - f.x) * t, y: f.y + (tp.y - f.y) * t });
        }
        applyView({
          x: viewFrom.x + (viewTo.x - viewFrom.x) * t,
          y: viewFrom.y + (viewTo.y - viewFrom.y) * t,
          w: viewFrom.w + (viewTo.w - viewFrom.w) * t,
          h: viewFrom.h + (viewTo.h - viewFrom.h) * t
        });
        placeNodes();
        placeEdges();
        if (raw < 1) {
          state.anim = requestAnimationFrame(frame);
        } else {
          state.anim = null;
          if (done) done();
        }
      }
      state.anim = requestAnimationFrame(frame);
    }

    /** Burst the found word's letters, then collapse the rest into place. */
    function playFound(removedIds, onDone) {
      for (const id of removedIds) {
        const node = state.nodeEls.get(id);
        if (node) node.g.classList.add('popping');
      }
      const edgesToFade = [];
      const removed = new Set(removedIds);
      for (const line of state.edgeEls.values()) {
        if (removed.has(Number(line.dataset.a)) || removed.has(Number(line.dataset.b))) {
          line.classList.add('fading');
          edgesToFade.push(line);
        }
      }
      window.setTimeout(() => {
        for (const id of removedIds) {
          const node = state.nodeEls.get(id);
          if (node) {
            node.g.remove();
            state.nodeEls.delete(id);
            state.pos.delete(id);
          }
        }
        for (const line of edgesToFade) {
          for (const [k, l] of state.edgeEls) if (l === line) state.edgeEls.delete(k);
          line.remove();
        }
        syncNodes();
        animateTo(520, () => {
          syncEdges();
          if (onDone) onDone();
        });
      }, 360);
    }

    function pulse(ids, className, ms) {
      for (const id of ids) {
        const node = state.nodeEls.get(id);
        if (!node) continue;
        node.g.classList.add(className);
        window.setTimeout(() => node.g.classList.remove(className), ms || 600);
      }
    }

    /** Highlight the current trace and draw the rubber-band to the fingertip. */
    function setTrace(ids, tip) {
      const active = new Set(ids);
      for (const [id, node] of state.nodeEls) {
        node.g.classList.toggle('traced', active.has(id));
      }
      const activeEdges = new Set();
      for (let i = 1; i < ids.length; i++) activeEdges.add(edgeKey(ids[i - 1], ids[i]));
      for (const [k, line] of state.edgeEls) {
        line.classList.toggle('traced', activeEdges.has(k));
      }
      const pts = [];
      for (const id of ids) {
        const p = state.pos.get(id);
        if (p) pts.push(p.x + ',' + p.y);
      }
      if (tip && ids.length) pts.push(tip.x + ',' + tip.y);
      tracePath.setAttribute('points', pts.join(' '));
      tracePath.classList.toggle('visible', pts.length > 1);
    }

    function clearTrace() {
      setTrace([], null);
    }

    function flashTrace(ids, className) {
      const nodes = ids.map(id => state.nodeEls.get(id)).filter(Boolean);
      for (const n of nodes) n.g.classList.add(className);
      window.setTimeout(() => {
        for (const n of nodes) n.g.classList.remove(className);
      }, 500);
    }

    /** Map a client point into svg user units. */
    function toSvgPoint(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const scaleX = state.view.w / rect.width;
      const scaleY = state.view.h / rect.height;
      return {
        x: state.view.x + (clientX - rect.left) * scaleX,
        y: state.view.y + (clientY - rect.top) * scaleY
      };
    }

    /** Nearest node to an svg point, within `radius` user units. */
    function nodeAt(point, radius, allowed) {
      let best = null;
      let bestDist = radius * radius;
      for (const [id, node] of state.nodeEls) {
        if (allowed && !allowed(id)) continue;
        const p = state.pos.get(id);
        if (!p) continue;
        const dx = p.x - point.x;
        const dy = p.y - point.y;
        const d = dx * dx + dy * dy;
        if (d <= bestDist) {
          bestDist = d;
          best = id;
        }
        void node;
      }
      return best;
    }

    function scaleFactor() {
      const rect = svg.getBoundingClientRect();
      return rect.width ? state.view.w / rect.width : 1;
    }

    return {
      STEP: STEP,
      setPuzzle: setPuzzle,
      refresh: refresh,
      playFound: playFound,
      animateTo: animateTo,
      setTrace: setTrace,
      clearTrace: clearTrace,
      flashTrace: flashTrace,
      pulse: pulse,
      toSvgPoint: toSvgPoint,
      nodeAt: nodeAt,
      scaleFactor: scaleFactor,
      positions: state.pos
    };
  }

  root.ZanRender = { create: createRenderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
