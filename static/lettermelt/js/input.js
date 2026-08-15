/* Lettermelt — pointer/touch tracing (browser only, iOS Safari first). */
(function (root) {
  'use strict';

  const SNAP_RADIUS = 58;   // svg user units; larger than the drawn disc (r=33)
  const START_RADIUS = 62;

  function attachInput(svg, renderer, hooks) {
    let pointerId = null;
    let trace = [];

    function adjacency() {
      return hooks.getAdjacency();
    }

    function active() {
      return typeof hooks.isActive !== 'function' || hooks.isActive();
    }

    function emit(tip) {
      renderer.setTrace(trace, tip);
      if (hooks.onTraceChange) hooks.onTraceChange(trace.slice());
    }

    function reset() {
      trace = [];
      renderer.clearTrace();
      if (hooks.onTraceChange) hooks.onTraceChange([]);
    }

    function release(ev) {
      if (pointerId !== null) {
        try {
          if (svg.hasPointerCapture && svg.hasPointerCapture(pointerId)) {
            svg.releasePointerCapture(pointerId);
          }
        } catch (_e) { /* ignore */ }
      }
      pointerId = null;
      void ev;
    }

    function onDown(ev) {
      if (!active() || pointerId !== null) return;
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const pt = renderer.toSvgPoint(ev.clientX, ev.clientY);
      const id = renderer.nodeAt(pt, START_RADIUS);
      if (id === null) return;
      pointerId = ev.pointerId;
      try { svg.setPointerCapture(pointerId); } catch (_e) { /* ignore */ }
      ev.preventDefault();
      trace = [id];
      emit(pt);
      if (hooks.onStart) hooks.onStart(id);
    }

    function onMove(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const pt = renderer.toSvgPoint(ev.clientX, ev.clientY);
      const last = trace[trace.length - 1];

      // Backtrack: drifting back onto the previous letter undoes the last step.
      if (trace.length >= 2) {
        const prev = trace[trace.length - 2];
        const prevHit = renderer.nodeAt(pt, SNAP_RADIUS * 0.8, id => id === prev);
        if (prevHit !== null) {
          trace.pop();
          emit(pt);
          return;
        }
      }

      const adj = adjacency();
      const neighbours = adj.get(last);
      if (neighbours) {
        const used = new Set(trace);
        const next = renderer.nodeAt(pt, SNAP_RADIUS, id => neighbours.has(id) && !used.has(id));
        if (next !== null) {
          trace.push(next);
          if (hooks.onLock) hooks.onLock(next);
        }
      }
      emit(pt);
    }

    function onUp(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      ev.preventDefault();
      release(ev);
      const submitted = trace.slice();
      trace = [];
      renderer.clearTrace();
      if (hooks.onSubmit) hooks.onSubmit(submitted);
      if (hooks.onTraceChange) hooks.onTraceChange([]);
    }

    function onCancel(ev) {
      if (pointerId === null || ev.pointerId !== pointerId) return;
      release(ev);
      reset();
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
        release(null);
        reset();
      },
      current: function () {
        return trace.slice();
      }
    };
  }

  root.ZanInput = { attach: attachInput };
})(typeof globalThis !== 'undefined' ? globalThis : this);
