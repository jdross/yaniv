/* Lettermelt — pointer/touch tracing (iOS Safari first).
 *
 * The lock logic lives in a PURE tracer core (no DOM), so it can be regression
 * tested in node. Two rules matter, and both were bugs once:
 *
 *  1. WALK THE SEGMENT. A finger flick delivers very few pointermove events —
 *     two samples can span the whole board. Locking only at the sampled points
 *     silently skips letters, so a traced word arrives at the engine truncated
 *     ("surge" -> "surg") and is rejected as not-a-word. Every move therefore
 *     walks the straight segment from the previous point in small steps and
 *     locks whatever the finger passed over, in order.
 *
 *  2. LOCK TIGHT, NOT NEAR. The snap radius must stay well under half the
 *     distance between two tiles. A generous radius grabs whichever adjacent
 *     tile happens to be nearest an in-between sample, which swaps letters
 *     ("resolve" -> "rsilve"). With dense sub-steps a tight radius is strictly
 *     better: the finger always produces a sample inside the tile it crosses.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ZanInput = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STEP = 100;               // lattice spacing in svg user units
  const LOCK_RADIUS = 0.44 * STEP;   // 44: just outside the drawn disc (r=40)
  const START_RADIUS = 0.62 * STEP;  // first touch is forgiving
  const BACK_RADIUS = 0.40 * STEP;   // drifting back onto the previous tile
  const WALK_STEP = 0.16 * STEP;     // sub-sampling along a pointer segment

  /**
   * Pure trace state machine.
   *
   * deps:
   *   getAdjacency() -> Map(id -> Set(id))   currently traversable edges
   *   nodeAt(point, radius, filter) -> id | null   nearest node within radius
   */
  function createTracer(deps, options) {
    const opts = options || {};
    const lockRadius = opts.lockRadius != null ? opts.lockRadius : LOCK_RADIUS;
    const startRadius = opts.startRadius != null ? opts.startRadius : START_RADIUS;
    const backRadius = opts.backRadius != null ? opts.backRadius : BACK_RADIUS;
    const walkStep = opts.walkStep != null ? opts.walkStep : WALK_STEP;

    let trace = [];
    let last = null;            // last pointer position, in svg units
    const listeners = { lock: null, back: null };

    /** Try to advance/retreat the trace using a single sample point. */
    function sample(point) {
      if (!trace.length) return;

      // Backtrack: drifting back onto the previous tile undoes the last step.
      if (trace.length >= 2) {
        const prev = trace[trace.length - 2];
        if (deps.nodeAt(point, backRadius, id => id === prev) !== null) {
          trace.pop();
          if (listeners.back) listeners.back(prev);
          return;
        }
      }

      const adj = deps.getAdjacency();
      const neighbours = adj && adj.get(trace[trace.length - 1]);
      if (!neighbours || !neighbours.size) return;
      const used = new Set(trace);
      const next = deps.nodeAt(point, lockRadius, id => neighbours.has(id) && !used.has(id));
      if (next !== null) {
        trace.push(next);
        if (listeners.lock) listeners.lock(next);
      }
    }

    /**
     * Walk from the previous pointer position to `point`, sampling along the
     * way. A single flick can therefore still lock every tile it crossed.
     */
    function move(point) {
      if (!trace.length) return trace;
      if (!last) {
        sample(point);
        last = point;
        return trace;
      }
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.min(240, Math.ceil(dist / walkStep)));
      for (let i = 1; i <= steps; i++) {
        sample({ x: last.x + (dx * i) / steps, y: last.y + (dy * i) / steps });
      }
      last = point;
      return trace;
    }

    function down(point) {
      const id = deps.nodeAt(point, startRadius, null);
      if (id === null) return null;
      trace = [id];
      last = point;
      return trace;
    }

    function end() {
      const out = trace.slice();
      trace = [];
      last = null;
      return out;
    }

    return {
      down: down,
      move: move,
      end: end,
      reset: end,
      current: () => trace.slice(),
      onLock: fn => { listeners.lock = fn; },
      onBack: fn => { listeners.back = fn; }
    };
  }

  /* ------------------------------------------------------------------ *
   * DOM binding (browser only)
   * ------------------------------------------------------------------ */
  function attachInput(svg, renderer, hooks) {
    let pointerId = null;

    const tracer = createTracer({
      getAdjacency: () => hooks.getAdjacency(),
      nodeAt: (point, radius, filter) => renderer.nodeAt(point, radius, filter)
    });

    tracer.onLock(id => { if (hooks.onLock) hooks.onLock(id); });

    function active() {
      return typeof hooks.isActive !== 'function' || hooks.isActive();
    }

    function emit(tip) {
      const trace = tracer.current();
      renderer.setTrace(trace, tip);
      if (hooks.onTraceChange) hooks.onTraceChange(trace);
    }

    function release() {
      if (pointerId !== null) {
        try {
          if (svg.hasPointerCapture && svg.hasPointerCapture(pointerId)) {
            svg.releasePointerCapture(pointerId);
          }
        } catch (_e) { /* ignore */ }
      }
      pointerId = null;
    }

    function onDown(ev) {
      if (!active() || pointerId !== null) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const pt = renderer.toSvgPoint(ev.clientX, ev.clientY);
      const started = tracer.down(pt);
      if (!started) return;
      pointerId = ev.pointerId;
      try { svg.setPointerCapture(pointerId); } catch (_e) { /* ignore */ }
      ev.preventDefault();
      emit(pt);
      if (hooks.onStart) hooks.onStart(started[0]);
    }

    function onMove(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      ev.preventDefault();
      // Coalesced events give the true high-frequency path of a fast swipe.
      let samples = null;
      if (typeof ev.getCoalescedEvents === 'function') {
        try { samples = ev.getCoalescedEvents(); } catch (_e) { samples = null; }
      }
      let pt = null;
      if (samples && samples.length) {
        for (const s of samples) {
          pt = renderer.toSvgPoint(s.clientX, s.clientY);
          tracer.move(pt);
        }
      } else {
        pt = renderer.toSvgPoint(ev.clientX, ev.clientY);
        tracer.move(pt);
      }
      emit(pt);
    }

    function onUp(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      ev.preventDefault();
      release();
      const submitted = tracer.end();
      // The fill is deliberately NOT cleared here: the submit handler recolours
      // it to the verdict's tone and drains it from there.
      renderer.setTrace(submitted, null);
      if (hooks.onSubmit) hooks.onSubmit(submitted);
      if (hooks.onTraceChange) hooks.onTraceChange([]);
    }

    function onCancel(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      release();
      tracer.reset();
      renderer.clearTrace();
      if (hooks.onTraceChange) hooks.onTraceChange([]);
      if (hooks.onCancel) hooks.onCancel();
    }

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onCancel);
    svg.addEventListener('lostpointercapture', onCancel);
    svg.addEventListener('contextmenu', ev => ev.preventDefault());

    return {
      cancel: function () {
        release();
        tracer.reset();
        renderer.clearTrace();
      },
      current: () => tracer.current()
    };
  }

  /** Nearest-node lookup over a plain positions map (used by tests). */
  function nearestNode(positions, point, radius, filter) {
    let best = null;
    let bestDist = radius * radius;
    for (const [id, p] of positions) {
      if (filter && !filter(id)) continue;
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

  return {
    STEP: STEP,
    LOCK_RADIUS: LOCK_RADIUS,
    START_RADIUS: START_RADIUS,
    WALK_STEP: WALK_STEP,
    createTracer: createTracer,
    nearestNode: nearestNode,
    attach: attachInput
  };
});
