/* Lettermelt — SVG rendering + animation (browser only).
 *
 * Tiles are built from layered circles rather than SVG filters: a soft
 * gradient "shadow" blob, a radial-gradient candy disc, a gloss highlight and
 * a glow ring that lights up on touch. Nothing here needs a filter region to
 * be recomputed per frame, so the board stays cheap to animate.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STEP = 100;
  const PAD = 52;
  const MELT_MS = 720;
  const SHIMMER_SHARE = 0.22;      // fraction of tiles that breathe

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

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------------------------- gradients ---------------------------- */

  function stop(offset, color, opacity) {
    const s = el('stop', { offset: offset, 'stop-color': color });
    if (opacity != null) s.setAttribute('stop-opacity', String(opacity));
    return s;
  }

  function buildDefs() {
    const defs = el('defs');

    const disc = el('radialGradient', { id: 'lmDisc', cx: '36%', cy: '26%', r: '82%' });
    disc.appendChild(stop('0%', '#7d4448'));
    disc.appendChild(stop('52%', '#4e2436'));
    disc.appendChild(stop('100%', '#2c131e'));

    const hot = el('radialGradient', { id: 'lmDiscHot', cx: '36%', cy: '24%', r: '84%' });
    hot.appendChild(stop('0%', '#ffe9b8'));
    hot.appendChild(stop('42%', '#ffb04d'));
    hot.appendChild(stop('100%', '#ef6a35'));

    const gloss = el('radialGradient', { id: 'lmGloss', cx: '50%', cy: '50%', r: '50%' });
    gloss.appendChild(stop('0%', '#fff6e8', 0.85));
    gloss.appendChild(stop('60%', '#ffd9a8', 0.28));
    gloss.appendChild(stop('100%', '#ffd9a8', 0));

    // Fake soft shadow: a gradient that fades out, so no filter is needed.
    const shadow = el('radialGradient', { id: 'lmShadow', cx: '50%', cy: '50%', r: '50%' });
    shadow.appendChild(stop('0%', '#1a0509', 0.75));
    shadow.appendChild(stop('62%', '#1a0509', 0.42));
    shadow.appendChild(stop('100%', '#1a0509', 0));

    const glow = el('radialGradient', { id: 'lmGlow', cx: '50%', cy: '50%', r: '50%' });
    glow.appendChild(stop('0%', '#ffb04d', 0.75));
    glow.appendChild(stop('45%', '#ff6b5a', 0.4));
    glow.appendChild(stop('100%', '#ff6b5a', 0));

    const tip = el('radialGradient', { id: 'lmTip', cx: '50%', cy: '50%', r: '50%' });
    tip.appendChild(stop('0%', '#fff3d0', 0.95));
    tip.appendChild(stop('40%', '#ffb04d', 0.6));
    tip.appendChild(stop('100%', '#ff6b5a', 0));

    for (const grad of [disc, hot, gloss, shadow, glow, tip]) defs.appendChild(grad);
    return defs;
  }

  function createRenderer(svg) {
    svg.appendChild(buildDefs());

    const gEdges = el('g', { class: 'layer-edges' });
    const gTrace = el('g', { class: 'layer-trace' });
    const gNodes = el('g', { class: 'layer-nodes' });
    const gFx = el('g', { class: 'layer-fx' });

    const traceGlow = el('polyline', { class: 'trace-glow', points: '', fill: 'none' });
    const tracePath = el('polyline', { class: 'trace-line', points: '', fill: 'none' });
    const traceTip = el('circle', { class: 'trace-tip', r: 46, cx: 0, cy: 0, fill: 'url(#lmTip)' });
    gTrace.appendChild(traceGlow);
    gTrace.appendChild(tracePath);
    gTrace.appendChild(traceTip);

    svg.appendChild(gEdges);
    svg.appendChild(gTrace);
    svg.appendChild(gNodes);
    svg.appendChild(gFx);

    const state = {
      puzzle: null,
      nodeEls: new Map(),   // id -> { g, inner, disc, text }
      edgeEls: new Map(),   // key -> { line, glow }
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
      const min = 3.2 * STEP;
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

      const hit = el('circle', { class: 'node-hit', r: 50, cx: 0, cy: 0 });
      const inner = el('g', { class: 'node-inner' });

      const glow = el('circle', { class: 'node-glow', r: 62, cx: 0, cy: 2, fill: 'url(#lmGlow)' });
      const shadow = el('circle', { class: 'node-shadow', r: 46, cx: 0, cy: 10, fill: 'url(#lmShadow)' });
      const disc = el('circle', { class: 'node-disc', r: 40, cx: 0, cy: 0, fill: 'url(#lmDisc)' });
      const gloss = el('ellipse', { class: 'node-gloss', cx: 0, cy: -16, rx: 22, ry: 12, fill: 'url(#lmGloss)' });
      const text = el('text', {
        class: 'node-letter', x: 0, y: 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central'
      });
      text.textContent = cell.letter.toUpperCase();

      inner.appendChild(glow);
      inner.appendChild(shadow);
      inner.appendChild(disc);
      inner.appendChild(gloss);
      inner.appendChild(text);
      g.appendChild(hit);
      g.appendChild(inner);
      gNodes.appendChild(g);

      // A minority of tiles breathe, each on its own offset.
      if (Math.random() < SHIMMER_SHARE) {
        g.classList.add('shimmer');
        gloss.style.animationDelay = (Math.random() * -6.5).toFixed(2) + 's';
      }
      return { g: g, inner: inner, disc: disc, text: text };
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
      for (const [k, pair] of state.edgeEls) {
        if (!wanted.has(k)) {
          pair.line.remove();
          pair.glow.remove();
          state.edgeEls.delete(k);
        }
      }
      for (const [k, pair] of wanted) {
        if (!state.edgeEls.has(k)) {
          const glow = el('line', { class: 'edge-glow' });
          const line = el('line', { class: 'edge fresh' });
          for (const node of [glow, line]) {
            node.dataset.a = String(pair[0]);
            node.dataset.b = String(pair[1]);
          }
          gEdges.appendChild(glow);
          gEdges.appendChild(line);
          state.edgeEls.set(k, { line: line, glow: glow });
          window.setTimeout(() => line.classList.remove('fresh'), 30);
        }
      }
      placeEdges();
    }

    function placeEdges() {
      for (const pair of state.edgeEls.values()) {
        const a = state.pos.get(Number(pair.line.dataset.a));
        const b = state.pos.get(Number(pair.line.dataset.b));
        if (!a || !b) continue;
        for (const node of [pair.line, pair.glow]) {
          node.setAttribute('x1', a.x);
          node.setAttribute('y1', a.y);
          node.setAttribute('x2', b.x);
          node.setAttribute('y2', b.y);
        }
      }
    }

    /* ----------------------------- effects ----------------------------- */

    /** Spawn short-lived particles at a board position. */
    function particles(x, y, opts) {
      if (prefersReducedMotion()) return;
      const count = opts.count;
      for (let i = 0; i < count; i++) {
        const angle = opts.spread * (Math.random() - 0.5) + opts.angle;
        const dist = opts.dist * (0.55 + Math.random() * 0.7);
        const dot = el('circle', {
          class: opts.className,
          cx: x + (Math.random() - 0.5) * 26,
          cy: y + (Math.random() - 0.5) * 14,
          r: opts.radius * (0.6 + Math.random() * 0.8),
          fill: opts.fill
        });
        dot.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
        dot.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
        dot.style.setProperty('--dur', (opts.duration * (0.75 + Math.random() * 0.5)).toFixed(2) + 's');
        dot.style.setProperty('--delay', (Math.random() * opts.stagger).toFixed(2) + 's');
        gFx.appendChild(dot);
        window.setTimeout(() => dot.remove(), (opts.duration + opts.stagger + 0.4) * 1000);
      }
    }

    /** Molten droplets falling off a melting tile. */
    function dripAt(x, y) {
      particles(x, y, {
        className: 'drop',
        count: 4 + Math.floor(Math.random() * 3),   // 4-6
        angle: Math.PI / 2,
        spread: 1.1,
        dist: 120,
        radius: 7,
        fill: '#ffb04d',
        duration: 0.85,
        stagger: 0.22
      });
    }

    /** Ember burst — used when an extra word pays out. */
    function sparkAt(id) {
      const p = state.pos.get(id);
      if (!p) return;
      particles(p.x, p.y, {
        className: 'ember',
        count: 9,
        angle: -Math.PI / 2,
        spread: Math.PI * 1.7,
        dist: 130,
        radius: 6,
        fill: '#ffd166',
        duration: 0.75,
        stagger: 0.14
      });
    }

    /* --------------------------- public API --------------------------- */

    function setPuzzle(puzzle) {
      state.puzzle = puzzle;
      for (const node of state.nodeEls.values()) node.g.remove();
      for (const pair of state.edgeEls.values()) { pair.line.remove(); pair.glow.remove(); }
      while (gFx.firstChild) gFx.removeChild(gFx.firstChild);
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

    /**
     * Melt away the letters and connections the union no longer needs, drip
     * droplets off them, bounce the survivors, then compact the board.
     *
     * opts: { removedIds, removedEdgeKeys, keptIds, onDone }
     */
    function playFound(opts) {
      const removedIds = opts.removedIds || [];
      const goneKeys = new Set(opts.removedEdgeKeys || []);
      const keptIds = opts.keptIds || [];
      const onDone = opts.onDone;

      for (const id of removedIds) {
        const node = state.nodeEls.get(id);
        if (!node) continue;
        node.disc.setAttribute('fill', 'url(#lmDiscHot)');
        node.g.classList.remove('traced');
        node.g.classList.add('melting');
        const p = state.pos.get(id);
        if (p) dripAt(p.x, p.y);
      }

      // Letters other words still need get a happy little bounce.
      for (const id of keptIds) {
        const node = state.nodeEls.get(id);
        if (!node) continue;
        node.g.classList.remove('traced');
        node.g.classList.add('kept');
        window.setTimeout(() => node.g.classList.remove('kept'), 650);
      }

      const removed = new Set(removedIds);
      const melting = [];
      for (const [k, pair] of state.edgeEls) {
        if (goneKeys.has(k) ||
            removed.has(Number(pair.line.dataset.a)) ||
            removed.has(Number(pair.line.dataset.b))) {
          pair.line.classList.add('melting');
          pair.glow.classList.remove('traced');
          melting.push([k, pair]);
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
        for (const [k, pair] of melting) {
          pair.line.remove();
          pair.glow.remove();
          if (state.edgeEls.get(k) === pair) state.edgeEls.delete(k);
        }
        syncNodes();
        animateTo(560, () => {
          syncEdges();
          if (onDone) onDone();
        });
      }, MELT_MS);
    }

    function pulse(ids, className, ms) {
      for (const id of ids) {
        const node = state.nodeEls.get(id);
        if (!node) continue;
        node.g.classList.add(className);
        window.setTimeout(() => node.g.classList.remove(className), ms || 600);
      }
    }

    /** Squash-and-spring the tile that just locked into the trace. */
    function lockPulse(id) {
      const node = state.nodeEls.get(id);
      if (!node) return;
      node.g.classList.remove('lock');
      void node.g.getBoundingClientRect();
      node.g.classList.add('lock');
      window.setTimeout(() => node.g.classList.remove('lock'), 360);
    }

    /** Highlight the current trace and draw the rubber-band to the fingertip. */
    function setTrace(ids, tip) {
      const active = new Set(ids);
      for (const [id, node] of state.nodeEls) {
        node.g.classList.toggle('traced', active.has(id));
        node.disc.setAttribute('fill', active.has(id) ? 'url(#lmDiscHot)' : 'url(#lmDisc)');
      }
      const activeEdges = new Set();
      for (let i = 1; i < ids.length; i++) activeEdges.add(edgeKey(ids[i - 1], ids[i]));
      for (const [k, pair] of state.edgeEls) {
        const on = activeEdges.has(k);
        pair.line.classList.toggle('traced', on);
        pair.glow.classList.toggle('traced', on);
      }
      const pts = [];
      for (const id of ids) {
        const p = state.pos.get(id);
        if (p) pts.push(p.x + ',' + p.y);
      }
      if (tip && ids.length) pts.push(tip.x + ',' + tip.y);
      const joined = pts.join(' ');
      tracePath.setAttribute('points', joined);
      traceGlow.setAttribute('points', joined);
      const visible = pts.length > 1;
      tracePath.classList.toggle('visible', visible);
      traceGlow.classList.toggle('visible', visible);
      if (tip && ids.length) {
        traceTip.setAttribute('cx', tip.x);
        traceTip.setAttribute('cy', tip.y);
      }
      traceTip.classList.toggle('visible', !!(tip && ids.length));
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

    /**
     * Map a client point into svg user units. The board uses
     * preserveAspectRatio="xMidYMid meet", so the viewBox is uniformly scaled
     * and centred inside the element — mapping each axis independently would
     * put the fingertip in the wrong place on any non-matching aspect ratio.
     */
    function viewTransform() {
      const rect = svg.getBoundingClientRect();
      const scale = Math.min(
        rect.width / state.view.w,
        rect.height / state.view.h
      ) || 1;
      return {
        scale: scale,
        offsetX: rect.left + (rect.width - state.view.w * scale) / 2,
        offsetY: rect.top + (rect.height - state.view.h * scale) / 2
      };
    }

    function toSvgPoint(clientX, clientY) {
      const t = viewTransform();
      return {
        x: state.view.x + (clientX - t.offsetX) / t.scale,
        y: state.view.y + (clientY - t.offsetY) / t.scale
      };
    }

    /** Inverse of toSvgPoint — svg user units back to client coordinates. */
    function toClientPoint(x, y) {
      const t = viewTransform();
      return {
        x: t.offsetX + (x - state.view.x) * t.scale,
        y: t.offsetY + (y - state.view.y) * t.scale
      };
    }

    /** Client coordinates of a node's centre (used by input tests). */
    function nodeClientPoint(id) {
      const p = state.pos.get(id);
      return p ? toClientPoint(p.x, p.y) : null;
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
      return 1 / viewTransform().scale;
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
      lockPulse: lockPulse,
      sparkAt: sparkAt,
      toSvgPoint: toSvgPoint,
      toClientPoint: toClientPoint,
      nodeClientPoint: nodeClientPoint,
      nodeAt: nodeAt,
      scaleFactor: scaleFactor,
      prefersReducedMotion: prefersReducedMotion,
      positions: state.pos
    };
  }

  root.ZanRender = { create: createRenderer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
