/* Lettermelt — SVG rendering + animation (browser only).
 *
 * The board is drawn as glass-and-liquid apparatus: letter orbs are layered
 * radial gradients (contact shadow, glass body, liquid fill, sheen, specular,
 * rim light — no strokes, no filters on static layers), and connections are
 * capsule "lanes" trimmed to each orb's rim so nothing overlaps a letter.
 * Each lane carries a hidden liquid channel (pathLength=1 + dashoffset) that
 * fills directionally as the player traces and drains downhill when a word
 * melts. Everything animates via transform/opacity/dashoffset only.
 */
(function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const STEP = 100;
  const PAD = 54;
  const MELT_MS = 760;
  const ORB_R = 40;          // drawn orb radius
  const LANE_GAP = 7;        // clearance between orb rim and lane end
  const LANE_TRIM = ORB_R + LANE_GAP;
  const SHIMMER_SHARE = 0.2;

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

  function gradient(kind, id, attrs, stops) {
    const g = el(kind, Object.assign({ id: id }, attrs));
    for (const s of stops) g.appendChild(stop(s[0], s[1], s[2]));
    return g;
  }

  function buildDefs() {
    const defs = el('defs');
    const grads = [
      // Deep glass marble body. The last stops settle close to the board's
      // ground so the orb has no hard silhouette — the contact shadow and
      // aura do the separating.
      gradient('radialGradient', 'lmOrb', { cx: '35%', cy: '27%', r: '85%' }, [
        ['0%', '#9a5a49'], ['30%', '#713a41'], ['58%', '#4b2136'],
        ['82%', '#301526'], ['100%', '#22101d']
      ]),
      // Liquid caramel — used for the orb fill and droplets.
      gradient('radialGradient', 'lmLiquid', { cx: '38%', cy: '22%', r: '90%' }, [
        ['0%', '#ffedbe'], ['32%', '#ffc45e'], ['62%', '#ff8f42'],
        ['88%', '#f26136'], ['100%', '#d84c2c']
      ]),
      // Broad top sheen.
      gradient('radialGradient', 'lmSheen', { cx: '50%', cy: '38%', r: '62%' }, [
        ['0%', '#fff7ea', 0.5], ['55%', '#ffdcae', 0.14], ['100%', '#ffdcae', 0]
      ]),
      // Crisp little specular.
      gradient('radialGradient', 'lmSpec', { cx: '50%', cy: '50%', r: '50%' }, [
        ['0%', '#ffffff', 0.95], ['55%', '#fff3dd', 0.35], ['100%', '#fff3dd', 0]
      ]),
      // Warm rim light along the lower edge.
      gradient('radialGradient', 'lmRim', { cx: '50%', cy: '30%', r: '72%' }, [
        ['0%', '#ff9a4d', 0], ['74%', '#ff9a4d', 0], ['90%', '#ffb877', 0.34],
        ['100%', '#ffcf96', 0.05]
      ]),
      // Soft contact shadow (gradient fade — no filter).
      gradient('radialGradient', 'lmContact', { cx: '50%', cy: '50%', r: '50%' }, [
        ['0%', '#0d0309', 0.62], ['58%', '#0d0309', 0.34], ['100%', '#0d0309', 0]
      ]),
      // Touch aura around a traced orb.
      gradient('radialGradient', 'lmAura', { cx: '50%', cy: '50%', r: '50%' }, [
        ['0%', '#ffb04d', 0.5], ['45%', '#ff7847', 0.28], ['100%', '#ff7847', 0]
      ]),
      // Fingertip glow.
      gradient('radialGradient', 'lmTip', { cx: '50%', cy: '50%', r: '50%' }, [
        ['0%', '#fff3d0', 0.9], ['42%', '#ffb04d', 0.5], ['100%', '#ff6b5a', 0]
      ]),
      // Outcome tones. The liquid recolours the moment a trace is judged, so
      // the answer is legible from the board itself before any text is read.
      gradient('radialGradient', 'lmLiquidGood', { cx: '38%', cy: '22%', r: '90%' }, [
        ['0%', '#e8ffd8'], ['32%', '#96e86b'], ['62%', '#4cc862'],
        ['88%', '#2f9d4e'], ['100%', '#218040']
      ]),
      gradient('radialGradient', 'lmLiquidExtra', { cx: '38%', cy: '22%', r: '90%' }, [
        ['0%', '#dff2ff'], ['32%', '#7cc9ff'], ['62%', '#3e9df5'],
        ['88%', '#2274d6'], ['100%', '#1a5fb8']
      ]),
      gradient('radialGradient', 'lmLiquidDim', { cx: '38%', cy: '22%', r: '90%' }, [
        ['0%', '#e6e2e6'], ['32%', '#b3aab3'], ['62%', '#8b8189'],
        ['88%', '#6a6169'], ['100%', '#57505a']
      ]),
      gradient('radialGradient', 'lmLiquidBad', { cx: '38%', cy: '22%', r: '90%' }, [
        ['0%', '#ffe0e0'], ['32%', '#ff9a95'], ['62%', '#f4635f'],
        ['88%', '#d8433f'], ['100%', '#b83430']
      ])
    ];
    for (const g of grads) defs.appendChild(g);
    return defs;
  }

  function createRenderer(svg) {
    svg.appendChild(buildDefs());

    const gEdges = el('g', { class: 'layer-edges' });
    const gTrace = el('g', { class: 'layer-trace' });
    const gNodes = el('g', { class: 'layer-nodes' });
    const gFx = el('g', { class: 'layer-fx' });

    // Rubber band: a single molten segment from the last locked orb to the
    // fingertip (the traced lanes themselves carry the rest of the liquid).
    const bandGlow = el('line', { class: 'band-glow' });
    const band = el('line', { class: 'band' });
    const traceTip = el('circle', { class: 'trace-tip', r: 42, cx: 0, cy: 0, fill: 'url(#lmTip)' });
    gTrace.appendChild(bandGlow);
    gTrace.appendChild(band);
    gTrace.appendChild(traceTip);

    svg.appendChild(gEdges);
    svg.appendChild(gTrace);
    svg.appendChild(gNodes);
    svg.appendChild(gFx);

    const state = {
      puzzle: null,
      nodeEls: new Map(),   // id -> { g, inner, body, liquid, text }
      edgeEls: new Map(),   // key -> { g, glass, bore, liquid, a, b, dir }
      pos: new Map(),       // id -> { x, y } in svg units
      view: { x: 0, y: 0, w: 600, h: 600 },
      anim: null,
      tracedPairs: new Map(), // edgeKey -> [from, to] for filled lanes
      // Bumped by setPuzzle. Node ids restart at 1 for every puzzle, so any
      // deferred callback from a previous board (melt timeouts, tween frames)
      // would happily delete or move the NEW board's tiles. Every deferred
      // step captures this token and no-ops once it is stale.
      gen: 0
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

      const clipId = 'lmClip-g' + state.gen + '-' + cell.id;
      const clip = el('clipPath', { id: clipId });
      clip.appendChild(el('circle', { r: ORB_R - 0.5, cx: 0, cy: 0 }));

      const contact = el('ellipse', {
        class: 'node-contact', cx: 0, cy: ORB_R + 7, rx: 30, ry: 10,
        fill: 'url(#lmContact)'
      });
      const aura = el('circle', { class: 'node-aura', r: 58, cx: 0, cy: 0, fill: 'url(#lmAura)' });
      const body = el('circle', { class: 'node-body', r: ORB_R, cx: 0, cy: 0, fill: 'url(#lmOrb)' });
      const liquidWrap = el('g', { 'clip-path': 'url(#' + clipId + ')' });
      const liquid = el('circle', {
        class: 'node-liquid', r: ORB_R, cx: 0, cy: 0, fill: 'url(#lmLiquid)'
      });
      liquidWrap.appendChild(liquid);
      const rim = el('circle', { class: 'node-rim', r: ORB_R, cx: 0, cy: 0, fill: 'url(#lmRim)' });
      const sheen = el('ellipse', {
        class: 'node-sheen', cx: -2, cy: -15, rx: 26, ry: 15, fill: 'url(#lmSheen)'
      });
      const spec = el('ellipse', {
        class: 'node-spec', cx: -13, cy: -19, rx: 7.5, ry: 5.5, fill: 'url(#lmSpec)',
        transform: 'rotate(-24)'
      });
      const shade = el('text', {
        class: 'node-letter-shade', x: 0, y: 4.5,
        'text-anchor': 'middle', 'dominant-baseline': 'central'
      });
      shade.textContent = cell.letter.toUpperCase();
      const text = el('text', {
        class: 'node-letter', x: 0, y: 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central'
      });
      text.textContent = cell.letter.toUpperCase();

      inner.appendChild(clip);
      inner.appendChild(contact);
      inner.appendChild(aura);
      inner.appendChild(body);
      inner.appendChild(liquidWrap);
      inner.appendChild(rim);
      inner.appendChild(sheen);
      inner.appendChild(spec);
      inner.appendChild(shade);
      inner.appendChild(text);
      g.appendChild(hit);
      g.appendChild(inner);
      gNodes.appendChild(g);

      // A minority of orbs breathe, each on its own offset.
      if (Math.random() < SHIMMER_SHARE) {
        g.classList.add('shimmer');
        sheen.style.animationDelay = (Math.random() * -7).toFixed(2) + 's';
      }
      return { g: g, inner: inner, body: body, liquid: liquid, text: text };
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

    function makeLane(a, b) {
      const g = el('g', { class: 'lane' });
      const glass = el('path', { class: 'lane-glass', fill: 'none' });
      const bore = el('path', { class: 'lane-bore', fill: 'none' });
      const liquid = el('path', {
        class: 'lane-liquid', fill: 'none', pathLength: '1'
      });
      g.appendChild(glass);
      g.appendChild(bore);
      g.appendChild(liquid);
      gEdges.appendChild(g);
      return { g: g, glass: glass, bore: bore, liquid: liquid, a: a, b: b, dir: null };
    }

    function syncEdges() {
      const wanted = new Map();
      for (const [a, b] of state.puzzle.edges) wanted.set(edgeKey(a, b), [a, b]);
      for (const [k, lane] of state.edgeEls) {
        if (!wanted.has(k)) {
          lane.g.remove();
          state.edgeEls.delete(k);
        }
      }
      for (const [k, pair] of wanted) {
        if (!state.edgeEls.has(k)) {
          const lane = makeLane(pair[0], pair[1]);
          lane.g.classList.add('fresh');
          state.edgeEls.set(k, lane);
          window.setTimeout(() => lane.g.classList.remove('fresh'), 30);
        }
      }
      placeEdges();
    }

    /** Lane endpoints, trimmed back to each orb's rim. */
    function laneEnds(lane) {
      const a = state.pos.get(lane.a);
      const b = state.pos.get(lane.b);
      if (!a || !b) return null;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // If two orbs get squeezed close, shrink the trim so the lane never
      // inverts.
      const trim = Math.min(LANE_TRIM, len * 0.42);
      const ux = dx / len;
      const uy = dy / len;
      return {
        ax: a.x + ux * trim, ay: a.y + uy * trim,
        bx: b.x - ux * trim, by: b.y - uy * trim
      };
    }

    function laneD(lane, fromA) {
      const e = laneEnds(lane);
      if (!e) return '';
      return fromA
        ? 'M' + e.ax + ' ' + e.ay + ' L' + e.bx + ' ' + e.by
        : 'M' + e.bx + ' ' + e.by + ' L' + e.ax + ' ' + e.ay;
    }

    function placeEdges() {
      for (const lane of state.edgeEls.values()) {
        const shell = laneD(lane, true);
        if (!shell) continue;
        lane.glass.setAttribute('d', shell);
        lane.bore.setAttribute('d', shell);
        // The liquid keeps whatever direction its current fill used.
        const fromA = lane.dir === null ? true : lane.dir;
        lane.liquid.setAttribute('d', laneD(lane, fromA));
      }
    }

    /* ----------------------- liquid choreography ----------------------- */

    /** Point the lane's liquid path so it flows from `fromId` to the other end. */
    function orientLane(lane, fromId) {
      const fromA = fromId === lane.a;
      if (lane.dir === fromA) return;
      lane.dir = fromA;
      lane.liquid.setAttribute('d', laneD(lane, fromA));
    }

    function fillLane(lane, fromId) {
      orientLane(lane, fromId);
      lane.g.classList.add('filled');
    }

    function drainLane(lane) {
      lane.g.classList.remove('filled');
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

    /** Molten droplets falling off a melting orb or lane end. */
    function dripAt(x, y, count) {
      particles(x, y, {
        className: 'drop',
        count: count || 4 + Math.floor(Math.random() * 3),
        angle: Math.PI / 2,
        spread: 1.1,
        dist: 120,
        radius: 7,
        fill: 'url(#lmLiquid)',
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
      state.gen++;
      if (state.anim) {
        cancelAnimationFrame(state.anim);
        state.anim = null;
      }
      state.puzzle = puzzle;
      for (const node of state.nodeEls.values()) node.g.remove();
      for (const lane of state.edgeEls.values()) lane.g.remove();
      while (gFx.firstChild) gFx.removeChild(gFx.firstChild);
      state.nodeEls.clear();
      state.edgeEls.clear();
      state.pos.clear();
      state.tracedPairs.clear();
      for (const cell of puzzle.cells) state.pos.set(cell.id, targetPos(cell));
      applyView(targetView(puzzle.cells));
      syncNodes();
      syncEdges();
      clearTrace();
      setTone(null);
    }

    function refresh() {
      syncNodes();
      syncEdges();
    }

    /** Tween node positions + viewBox to the puzzle's current layout. */
    function animateTo(duration, done) {
      if (state.anim) cancelAnimationFrame(state.anim);
      const token = state.gen;
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
        if (token !== state.gen) { state.anim = null; return; }
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
     * Melt away the letters and connections the union no longer needs: liquid
     * drains downhill out of the word's lanes and orbs, droplets fall from
     * the low points, survivors bounce, then the board compacts.
     *
     * opts: { removedIds, removedEdgeKeys, keptIds, onDone }
     */
    function playFound(opts) {
      const token = state.gen;
      const removedIds = opts.removedIds || [];
      const goneKeys = new Set(opts.removedEdgeKeys || []);
      const keptIds = opts.keptIds || [];
      const onDone = opts.onDone;

      for (const id of removedIds) {
        const node = state.nodeEls.get(id);
        if (!node) continue;
        node.g.classList.remove('traced');
        node.g.classList.add('melting');
        const p = state.pos.get(id);
        if (p) dripAt(p.x, p.y + ORB_R * 0.5);
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
      for (const [k, lane] of state.edgeEls) {
        if (goneKeys.has(k) || removed.has(lane.a) || removed.has(lane.b)) {
          melting.push([k, lane]);
        }
      }

      // Filled lanes drain downhill; empty ones sag out quietly.
      for (const [, lane] of melting) {
        const wasFilled = lane.g.classList.contains('filled');
        if (wasFilled && !prefersReducedMotion()) {
          const a = state.pos.get(lane.a);
          const b = state.pos.get(lane.b);
          if (a && b) {
            const topFirst = a.y === b.y ? (a.x < b.x) : (a.y < b.y);
            orientLane(lane, topFirst ? lane.a : lane.b);
            const low = topFirst ? b : a;
            window.setTimeout(() => {
              if (token === state.gen) dripAt(low.x, low.y, 2);
            }, 300);
          }
          lane.g.classList.add('draining');
          lane.g.classList.remove('filled');
        } else {
          lane.g.classList.remove('filled');
        }
        lane.g.classList.add('melting');
      }

      window.setTimeout(() => {
        if (token !== state.gen) return;   // a new puzzle was loaded mid-melt
        for (const id of removedIds) {
          const node = state.nodeEls.get(id);
          if (node) {
            node.g.remove();
            state.nodeEls.delete(id);
            state.pos.delete(id);
          }
        }
        for (const [k, lane] of melting) {
          lane.g.remove();
          if (state.edgeEls.get(k) === lane) state.edgeEls.delete(k);
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

    /** Squash-and-spring the orb that just locked into the trace. */
    function lockPulse(id) {
      const node = state.nodeEls.get(id);
      if (!node) return;
      node.g.classList.remove('lock');
      void node.g.getBoundingClientRect();
      node.g.classList.add('lock');
      window.setTimeout(() => node.g.classList.remove('lock'), 360);
    }

    /**
     * Highlight the current trace: liquid pours into each newly locked lane
     * (and drains back out on backtrack), orbs fill bottom-up, and a molten
     * band runs from the last orb to the fingertip.
     */
    function setTrace(ids, tip) {
      const active = new Set(ids);
      for (const [id, node] of state.nodeEls) {
        node.g.classList.toggle('traced', active.has(id));
      }

      const pairs = new Map();
      for (let i = 1; i < ids.length; i++) {
        pairs.set(edgeKey(ids[i - 1], ids[i]), ids[i - 1]);
      }
      // Drain lanes that fell out of the trace.
      for (const k of state.tracedPairs.keys()) {
        if (!pairs.has(k)) {
          const lane = state.edgeEls.get(k);
          if (lane) drainLane(lane);
        }
      }
      // Fill lanes that just joined, flowing away from the earlier letter.
      for (const [k, fromId] of pairs) {
        if (!state.tracedPairs.has(k)) {
          const lane = state.edgeEls.get(k);
          if (lane) fillLane(lane, fromId);
        }
      }
      state.tracedPairs = pairs;

      const hasTip = !!(tip && ids.length);
      if (hasTip) {
        const last = state.pos.get(ids[ids.length - 1]);
        if (last) {
          for (const seg of [band, bandGlow]) {
            seg.setAttribute('x1', last.x);
            seg.setAttribute('y1', last.y);
            seg.setAttribute('x2', tip.x);
            seg.setAttribute('y2', tip.y);
          }
        }
        traceTip.setAttribute('cx', tip.x);
        traceTip.setAttribute('cy', tip.y);
      }
      band.classList.toggle('visible', hasTip);
      bandGlow.classList.toggle('visible', hasTip);
      traceTip.classList.toggle('visible', hasTip);
    }

    function clearTrace() {
      setTrace([], null);
    }

    const TONES = ['tone-good', 'tone-extra', 'tone-dim', 'tone-bad'];

    /** Recolour the liquid to signal an outcome ('good'|'extra'|'dim'|'bad'). */
    function setTone(tone) {
      for (const name of TONES) svg.classList.remove(name);
      if (tone) svg.classList.add('tone-' + tone);
    }

    /**
     * Hold the traced fill for a beat in the colour of its verdict, then let
     * it drain away. Solving a word is green, an extra is blue, and anything
     * already found (or too short to count) drains grey.
     */
    function drainTrace(tone, holdMs) {
      const token = state.gen;
      setTone(tone || null);
      window.setTimeout(() => {
        if (token !== state.gen) return;
        clearTrace();
        window.setTimeout(() => {
          if (token === state.gen) setTone(null);
        }, 320);
      }, holdMs == null ? 280 : holdMs);
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
      for (const [id] of state.nodeEls) {
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
      setTone: setTone,
      drainTrace: drainTrace,
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
