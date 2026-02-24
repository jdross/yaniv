// Card/round animations.

// Spawns a card that flies from the source (deck or pile) toward the hand
// (my draw) or score bar (opponent's draw), fading out as it accelerates.
// drawnCard: card object to show face-up, or null for a face-down back.
// fromPile:  true -> source is the discard pile area; false -> deck button.
function animateCardDraw(isMyDraw, drawnCard, fromPile) {
  const srcEl   = fromPile ? $drawOptions : $deckBtn;
  const srcRect = srcEl.getBoundingClientRect();
  if (!srcRect.width) return;

  const W = 60;
  const H = 88;
  const srcCX = srcRect.left + srcRect.width  / 2;
  const srcCY = srcRect.top  + srcRect.height / 2;

  let tgtCX;
  let tgtCY;
  if (isMyDraw) {
    const handRect = $hand.getBoundingClientRect();
    tgtCX = handRect.left + handRect.width  / 2;
    tgtCY = handRect.top  + handRect.height / 2;
  } else {
    const scoreRect = $scoreBar.getBoundingClientRect();
    tgtCX = scoreRect.left + scoreRect.width / 2;
    tgtCY = scoreRect.top;
  }

  const flyEl = document.createElement('div');
  if (drawnCard) {
    flyEl.className = 'flying-card' + (cardColor(drawnCard) ? ' red' : '');
    flyEl.innerHTML =
      `<span class="card-rank">${esc(drawnCard.rank)}</span>` +
      `<span class="card-suit">${drawnCard.suit ? suitSymbol(drawnCard.suit) : '🃏'}</span>` +
      `<span class="card-rank-bot">${esc(drawnCard.rank)}</span>`;
  } else {
    flyEl.className = 'flying-card face-down';
  }

  const endRotate = isMyDraw ? 7 : -7;

  flyEl.style.left = `${srcCX - W / 2}px`;
  flyEl.style.top  = `${srcCY - H / 2}px`;
  flyEl.style.opacity = '1';
  flyEl.style.transform = 'rotate(0deg) scale(1)';
  document.body.appendChild(flyEl);

  // Force a reflow so the start position is painted before transition starts.
  flyEl.getBoundingClientRect();
  flyEl.style.transition = `left ${DRAW_ANIMATION.durationMs}ms ${DRAW_ANIMATION.moveEase}, top ${DRAW_ANIMATION.durationMs}ms ${DRAW_ANIMATION.moveEase}, opacity ${DRAW_ANIMATION.durationMs}ms ${DRAW_ANIMATION.fadeEase}, transform ${DRAW_ANIMATION.durationMs}ms ${DRAW_ANIMATION.moveEase}`;
  flyEl.style.left    = `${tgtCX - W / 2}px`;
  flyEl.style.top     = `${tgtCY - H / 2}px`;
  flyEl.style.opacity = '0';
  flyEl.style.transform = `rotate(${endRotate}deg) scale(0.9)`;

  setTimeout(() => flyEl.remove(), DRAW_ANIMATION.durationMs + 120);
}

// Big text zooms from center and fades.
function animateYaniv(round) {
  const isAssaf = !!round.assaf;
  const el = document.createElement('div');
  el.className = 'yaniv-announce' + (isAssaf ? ' assaf' : '');
  el.textContent = isAssaf ? '😱 Assaf!' : '🎉 Yaniv!';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}
