// State orchestration and startup.

function onState(s) {
  if (s.error) { window.location.href = '/'; return; }
  if (s.next_room) { window.location.href = `/game/${s.next_room}`; return; }

  // Compare hands using an order-independent fingerprint so server-side sorting
  // (start_turn) doesn't falsely look like a hand change. Only clear the
  // pre-selection when the actual set of cards changes (cards played/drawn).
  const oldHandKey = handKey(state);
  const newHandKey = handKey(s);
  let drawnCard = null;
  if (newHandKey !== null && newHandKey !== prevHandKey) {
    if (oldHandKey !== null && oldHandKey !== newHandKey) {
      const prevIds = new Set((getSelfHand(state) ?? []).map(c => c.id));
      drawnCard     = (getSelfHand(s) ?? []).find(c => !prevIds.has(c.id)) ?? null;
      newCardId     = drawnCard ? drawnCard.id : null;
    } else {
      newCardId = null;
    }
    selectedCards = [];
    prevHandKey   = newHandKey;
  }

  // Draw animation — fires once per unique last_turn when drawn from deck or pile.
  if (s.last_turn && s.status === 'playing') {
    const t = s.last_turn;
    const animKey = [
      t.player,
      (t.discarded || []).map(c => c.id).sort((a, b) => a - b).join(','),
      t.drawn_from,
      t.drawn_card ? t.drawn_card.id : '',
    ].join('|');
    if (animKey !== prevAnimTurnKey) {
      const df = s.last_turn.drawn_from;
      if (df === 'deck' || df === 'pile') {
        const me = getSelfPlayer(s);
        const isMyDraw = !!(me && me.name === s.last_turn.player);
        // Pile draw is always visible; deck draw is only known on your own turn.
        const cardToShow = df === 'pile'
          ? s.last_turn.drawn_card
          : (isMyDraw ? drawnCard : null);
        animateCardDraw(isMyDraw, cardToShow, df === 'pile');
      }
    }
    prevAnimTurnKey = animKey;
  }

  // Yaniv / Assaf announcement animation — guard against first-load replay.
  if (s.last_round) {
    const r = s.last_round;
    const yanivKey = roundResultKey(r);
    if (yanivKey !== prevYanivKey && state !== null) animateYaniv(s.last_round);
    prevYanivKey = yanivKey;
  }

  // Clear draw-source selection whenever it's not our turn.
  if (!s.game?.is_my_turn) selectedDraw = null;

  const roundKey = s.status === 'playing' ? roundResultKey(s.last_round) : null;
  if (roundKey !== activeRoundModalKey) {
    activeRoundModalKey = roundKey;
    dismissedRoundModalKey = null;
  }
  if (!roundKey) {
    hideRoundResultModal();
  } else if (dismissedRoundModalKey !== roundKey) {
    showRoundResultModal(s.last_round, s);
  }

  state          = s;
  actionInFlight = false;
  clearError();

  const isMember = s.members.some(m => m.pid === pid);
  if (!isMember) { showJoin(s); return; }

  if (s.status === 'waiting')        showLobby(s);
  else if (s.status === 'finished')  showGameOver(s);
  else                               showBoard(s);
}

function initGameClient() {
  bindEventHandlers();

  // State is delivered exclusively via SSE. Browser auto-reconnects, and the
  // server sends a fresh snapshot as the first message on every connection.
  const es = new EventSource(`/api/events/${code}/${pid}`);
  es.onmessage = e => { onState(JSON.parse(e.data)); };
  es.onerror   = () => { /* browser reconnects automatically */ };
}

initGameClient();
