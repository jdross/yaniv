// State orchestration and startup.

function onState(s) {
  if (s.error) {
    window.location.href = '/';
    return;
  }
  if (s.nextRoom) {
    window.location.href = `/game/${s.nextRoom}`;
    return;
  }

  // Compare hands using an order-independent fingerprint so server-side sorting
  // (startTurn) doesn't falsely look like a hand change. Only clear the
  // pre-selection when the actual set of cards changes (cards played/drawn).
  const oldHandKey = handKey(state);
  const newHandKey = handKey(s);
  let drawnCard = null;
  if (newHandKey !== null && newHandKey !== prevHandKey) {
    if (oldHandKey !== null && oldHandKey !== newHandKey) {
      const prevIds = new Set((getSelfHand(state) ?? []).map(c => c.id));
      drawnCard = (getSelfHand(s) ?? []).find(c => !prevIds.has(c.id)) ?? null;
      newCardId = drawnCard ? drawnCard.id : null;
    } else {
      newCardId = null;
    }
    selectedCards = [];
    prevHandKey = newHandKey;
  }

  // Draw animation — fires once per unique lastTurn when drawn from deck or pile.
  if (s.lastTurn && s.status === 'playing') {
    const t = s.lastTurn;
    const animKey = [
      t.player,
      (t.discarded || []).map(c => c.id).sort((a, b) => a - b).join(','),
      t.drawnFrom,
      t.drawnCard ? t.drawnCard.id : '',
    ].join('|');
    if (animKey !== prevAnimTurnKey) {
      const df = s.lastTurn.drawnFrom;
      if (df === 'deck' || df === 'pile') {
        const me = getSelfPlayer(s);
        const isMyDraw = !!(me && me.name === s.lastTurn.player);
        // Pile draw is always visible; deck draw is only known on your own turn.
        const cardToShow = df === 'pile'
          ? s.lastTurn.drawnCard
          : (isMyDraw ? drawnCard : null);
        animateCardDraw(isMyDraw, cardToShow, df === 'pile');
      }
    }
    prevAnimTurnKey = animKey;
  }

  // Yaniv / Assaf announcement animation — guard against first-load replay.
  if (s.lastRound) {
    const r = s.lastRound;
    const yanivKey = roundResultKey(r);
    if (yanivKey !== prevYanivKey && state !== null) animateYaniv(s.lastRound);
    prevYanivKey = yanivKey;
  }

  // Clear draw-source selection whenever it's not our turn.
  if (!s.game?.isMyTurn) selectedDraw = null;

  const roundKey = s.status === 'playing' ? roundResultKey(s.lastRound) : null;
  if (roundKey !== activeRoundModalKey) {
    activeRoundModalKey = roundKey;
    dismissedRoundModalKey = null;
  }
  if (!roundKey) {
    hideRoundResultModal();
  } else if (dismissedRoundModalKey !== roundKey) {
    showRoundResultModal(s.lastRound, s);
  }

  state = s;
  actionInFlight = false;
  clearError();

  const isMember = s.members.some(m => m.pid === pid);
  if (!isMember) {
    showJoin(s);
    return;
  }

  if (s.status === 'waiting') showLobby(s);
  else if (s.status === 'finished') showGameOver(s);
  else showBoard(s);
}

function initGameClient() {
  bindEventHandlers();

  // State is delivered exclusively via SSE. Browser auto-reconnects, and the
  // server sends a fresh snapshot as the first message on every connection.
  const es = new EventSource(`/api/events/${code}/${pid}`);
  es.onmessage = (e) => {
    onState(JSON.parse(e.data));
  };
  es.onerror = () => { /* browser reconnects automatically */ };
}

initGameClient();
