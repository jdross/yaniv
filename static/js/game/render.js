// Rendering and markup helpers.
let pileLayoutRafId = null;

function showJoin(s) {
  resetRoundResultState();
  showScreen($joinScreen);
  $joinCode.textContent = s.code;

  $joinPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.is_ai ? '🤖' : '👤'}</span>
       <span class="player-name">${esc(m.name)}</span>
     </div>`
  ).join('');

  const humanCount = s.members.filter(m => !m.is_ai).length;
  if (s.status !== 'waiting') {
    hide($joinForm); hide($joinFullMsg); show($joinStartedMsg);
  } else if (humanCount >= 4) {
    hide($joinForm); show($joinFullMsg); hide($joinStartedMsg);
  } else {
    show($joinForm); hide($joinFullMsg); hide($joinStartedMsg);
  }
}

function showLobby(s) {
  resetRoundResultState();
  showScreen($lobby);
  $lobbyCode.textContent = s.code;
  $shareBtn.textContent  = getShareButtonLabel();

  $lobbyPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.is_ai ? '🤖' : '👤'}</span>
       <span class="player-name">${esc(m.name)}${m.pid === pid ? ' (you)' : ''}</span>
       ${m.pid === pid ? '<button class="btn-leave">Leave</button>' : ''}
     </div>`
  ).join('');

  $lobbyPlayers.querySelectorAll('.btn-leave').forEach(btn => {
    btn.onclick = async () => {
      const res = await post('/api/leave', { pid, code });
      if (!res?.error) window.location.href = '/';
    };
  });

  // Show slamdown option only to the creator when there are no AIs.
  const firstHuman = s.members.find(m => !m.is_ai);
  const hasAi = s.members.some(m => m.is_ai);
  if (firstHuman && firstHuman.pid === pid && !hasAi) {
    if ($slamdownsCheckbox) $slamdownsCheckbox.checked = s.options?.slamdowns_allowed !== false;
    show($lobbyOptions);
  } else {
    hide($lobbyOptions);
  }
}

function showBoard(s) {
  showScreen($board);

  const g  = s.game;
  const me = getSelfPlayer(s);

  // Scores.
  $scoreBar.innerHTML = g.players.map(p =>
    `<div class="score-player ${p.is_current ? 'current' : ''} ${p.is_self ? 'self' : ''}">
       <div class="sp-name">${esc(p.name)}</div>
       <div class="sp-score">${p.score}</div>
       <div class="sp-cards">${p.hand_count} card${p.hand_count !== 1 ? 's' : ''}</div>
     </div>`
  ).join('');

  // Turn log (last 3 plays, animated).
  renderTurnLog(s.last_turn, s.last_round);

  // Turn status — only shown when it's your turn.
  if (g.is_my_turn) {
    $turnStatus.textContent = UI_TEXT.turnPrompt;
    show($turnStatus);
  } else {
    hide($turnStatus);
  }

  // Draw section — always visible; interactive only on your turn.
  show($drawSection);
  $deckSizeLabel.textContent = `${g.deck_size} left`;
  if (g.is_my_turn) {
    if (selectedDraw === null) selectedDraw = 'deck';
    renderDrawOptions(g.draw_options, g.discard_top, true);
  } else {
    renderDrawOptions([], g.discard_top, false);
  }

  // Hand — always sorted client-side; click handlers always attached for pre-selection.
  if (me && me.hand) {
    const hand = sortHand(me.hand);
    $hand.innerHTML = hand.map((c, i) => {
      const classes = ['card', cardColor(c),
        selectedCards.includes(c.id) ? 'selected' : '',
        c.id === newCardId            ? 'card-new'  : '',
      ].filter(Boolean).join(' ');
      return `<div class="${classes}" data-id="${c.id}">
         <span class="card-num">${i+1}</span>
         <span class="card-rank">${esc(c.rank)}</span>
         <span class="card-suit">${c.suit ? suitSymbol(c.suit) : '🃏'}</span>
         <span class="card-rank-bot">${esc(c.rank)}</span>
       </div>`;
    }).join('');

    $handValue.textContent = `(${me.hand.reduce((sum, c) => sum + c.value, 0)} pts)`;

    // Always attach click handlers — cards can be pre-selected while waiting.
    $hand.querySelectorAll('.card').forEach(el => {
      el.onclick = () => toggleCard(parseInt(el.dataset.id, 10));
    });

    (g.is_my_turn && me.can_yaniv) ? show($yanivBtn) : hide($yanivBtn);
    (g.slamdowns_allowed && g.can_slamdown && !g.is_my_turn) ? show($slamdownBtn) : hide($slamdownBtn);
  } else {
    $hand.innerHTML = UI_TEXT.waitingHand;
    $handValue.textContent = '';
    hide($yanivBtn);
    hide($slamdownBtn);
  }

  updatePlayBtn();
}

function renderDrawOptions(options, discardTop, isMyTurn) {
  $drawOptions.innerHTML = '';

  // Pile hint — only meaningful on your turn.
  if (!isMyTurn || !discardTop || discardTop.length === 0) {
    $pileHint.textContent = '';
  } else if (options.length === 0) {
    $pileHint.textContent = '';
  } else if (discardTop.length === 1) {
    $pileHint.textContent = '';
  } else if (discardTop.length > options.length) {
    $pileHint.textContent = '(run — pick an end card)';
  } else {
    $pileHint.textContent = '(set — choose 1 card)';
  }

  // Show all discarded cards; only valid picks are clickable (on your turn).
  (discardTop || []).forEach(c => {
    const optionIndex = isMyTurn ? options.findIndex(o => o.id === c.id) : -1;
    const isSelectable = optionIndex !== -1;

    const div = document.createElement('div');
    div.className = 'draw-choice'
      + (isSelectable && selectedDraw === optionIndex ? ' selected' : '')
      + (isSelectable ? '' : ' pile-inactive');
    div.innerHTML = `${cardHtml(c)}<span class="draw-label">${esc(c.rank)}${c.suit ? ' ' + suitSymbol(c.suit) : ''}</span>`;
    if (isSelectable) div.addEventListener('click', () => selectDraw(optionIndex));
    $drawOptions.appendChild(div);
  });

  // Deck — selectable only on your turn.
  $deckBtn.className = 'draw-choice deck-choice'
    + (isMyTurn && selectedDraw === 'deck' ? ' selected' : '')
    + (!isMyTurn ? ' pile-inactive' : '');
  $deckBtn.onclick = isMyTurn ? () => selectDraw('deck') : null;

  schedulePileSqueezeLayout();
}

function schedulePileSqueezeLayout() {
  if (pileLayoutRafId !== null) cancelAnimationFrame(pileLayoutRafId);
  pileLayoutRafId = requestAnimationFrame(() => {
    pileLayoutRafId = null;
    applyPileSqueezeLayout();
  });
}

function applyPileSqueezeLayout() {
  const pileChoices = Array.from($drawOptions.querySelectorAll('.draw-choice'));
  if (!pileChoices.length) {
    $drawOptions.classList.remove('mobile-fan');
    $drawOptions.style.removeProperty('--pile-gap');
    $drawOptions.style.removeProperty('--pile-overlap');
    return;
  }

  const containerWidth = $drawOptions.clientWidth;
  const cardEl = pileChoices[0].querySelector('.card');
  const cardWidth = cardEl ? cardEl.getBoundingClientRect().width : pileChoices[0].getBoundingClientRect().width;
  if (!containerWidth || !cardWidth) return;

  const pileCount = pileChoices.length;
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  const fanMode = isMobile && pileCount >= 4;
  $drawOptions.classList.toggle('mobile-fan', fanMode);

  const baseGapPx = fanMode ? 1 : 6;
  const outlineAllowancePx = 12;
  const availableWidth = Math.max(containerWidth - outlineAllowancePx, 0);

  let gapPx = baseGapPx;
  if (pileCount > 3) {
    const fitGapPx = (availableWidth - (pileCount * cardWidth)) / (pileCount - 1);
    const minGapPx = fanMode ? -Math.round(cardWidth * 0.58) : -Math.round(cardWidth * 0.45);
    if (fanMode) {
      const fanTargetGapPx = pileCount >= 5
        ? -Math.round(cardWidth * 0.34)
        : -Math.round(cardWidth * 0.24);
      gapPx = Math.max(minGapPx, Math.min(fanTargetGapPx, fitGapPx));
    } else {
      gapPx = Math.max(minGapPx, Math.min(baseGapPx, fitGapPx));
    }
  }

  // Flex gap cannot be negative. Use negative margin overlap when needed.
  if (gapPx >= 0) {
    $drawOptions.style.setProperty('--pile-gap', `${gapPx}px`);
    $drawOptions.style.setProperty('--pile-overlap', '0px');
  } else {
    $drawOptions.style.setProperty('--pile-gap', '0px');
    $drawOptions.style.setProperty('--pile-overlap', `${gapPx}px`);
  }

  const fanCenter = (pileCount - 1) / 2;
  pileChoices.forEach((choice, index) => {
    if (fanMode) {
      const spread = index - fanCenter;
      const tiltDeg = spread * 4.3;
      const liftPx = Math.abs(spread) * -2.4;
      choice.style.setProperty('--fan-tilt', `${tiltDeg.toFixed(2)}deg`);
      choice.style.setProperty('--fan-lift', `${liftPx.toFixed(2)}px`);
      choice.style.zIndex = String(100 + index);
    } else {
      choice.style.removeProperty('--fan-tilt');
      choice.style.removeProperty('--fan-lift');
      choice.style.removeProperty('z-index');
    }
  });
}

window.addEventListener('resize', schedulePileSqueezeLayout);

function showGameOver(s) {
  resetRoundResultState();
  showScreen($gameover);
  $winnerText.textContent = `${esc(s.winner)} wins!`;
  if (s.game) {
    $finalScores.innerHTML = s.game.players
      .slice().sort((a, b) => a.score - b.score)
      .map(p => `<div class="final-score-row ${p.name === s.winner ? 'winner' : ''}">
                   <span>${esc(p.name)}</span><span>${p.score} pts</span>
                 </div>`)
      .join('');
  }
}

function cardHtml(c) {
  return `<div class="card ${cardColor(c)}">
    <span class="card-rank">${esc(c.rank)}</span>
    <span class="card-suit">${c.suit ? suitSymbol(c.suit) : '🃏'}</span>
    <span class="card-rank-bot">${esc(c.rank)}</span>
  </div>`;
}

function cardShort(c) {
  return c ? `${esc(c.rank)}${c.suit ? suitSymbol(c.suit) : ''}` : '?';
}

// Coloured version for the turn log: red suits in red, black suits unstyled.
function cardShortHtml(c) {
  if (!c) return '?';
  const text = cardShort(c);
  return (c.suit === 'Hearts' || c.suit === 'Diamonds')
    ? `<span class="log-red">${text}</span>`
    : text;
}

function renderTurnLog(lastTurn, lastRound) {
  // When a brand-new round starts, wipe the log so old turns don't linger.
  // Use a canonical key (not JSON.stringify) so JSONB key reordering from
  // Postgres doesn't cause a false mismatch between SSE and poll responses.
  const roundKey = roundResultKey(lastRound);
  if (roundKey !== prevRoundKey) {
    if (roundKey && !prevRoundKey) {
      $turnLog.innerHTML = '';
    }
    prevRoundKey = roundKey;
  }

  if (!lastTurn) return;

  const key = [
    lastTurn.player,
    (lastTurn.discarded || []).map(c => c.id).sort((a, b) => a - b).join(','),
    lastTurn.drawn_from,
    lastTurn.drawn_card ? lastTurn.drawn_card.id : '',
    roundKey,
  ].join('|');
  if (key === prevTurnKey) return;
  prevTurnKey = key;

  const me = getSelfPlayer();
  const el = document.createElement('div');
  el.className = 'turn-log-item new';
  el.innerHTML = formatLastTurn(lastTurn, me);
  $turnLog.insertBefore(el, $turnLog.firstChild);

  while ($turnLog.children.length > 3) $turnLog.removeChild($turnLog.lastChild);
}

function formatRoundResultModal(round, currentState) {
  const myName = getSelfPlayer(currentState)?.name;
  const handPts = round.declarer_hand_value != null ? ` (${round.declarer_hand_value} pts)` : '';

  let headline;
  if (round.assaf) {
    const assafedStr = myName === round.assaf.assafed ? 'You' : `<strong>${esc(round.assaf.assafed)}</strong>`;
    const byStr      = myName === round.assaf.by      ? 'you'  : `<strong>${esc(round.assaf.by)}</strong>`;
    headline = `😱 ${assafedStr} called Yaniv${handPts} but got Assaf'd by ${byStr}!`;
  } else {
    const who = myName === round.declarer ? 'You' : `<strong>${esc(round.declarer)}</strong>`;
    headline = `🎉 ${who} called Yaniv${handPts}!`;
  }

  let rowsHtml = '';
  if (round.score_changes?.length) {
    rowsHtml = round.score_changes.map(sc => {
      const isMe       = myName === sc.name;
      const name       = isMe ? 'You' : esc(sc.name);
      const isAssafed  = round.assaf?.assafed === sc.name;
      const finalHand  = Array.isArray(sc.final_hand) ? sc.final_hand : [];

      let delta;
      if (sc.added === 0)  delta = `→ ${sc.new_score}`;
      else if (sc.reset)   delta = `+${sc.added} → reset to ${sc.new_score}`;
      else                 delta = `+${sc.added} → ${sc.new_score}`;
      if (sc.eliminated)   delta += ' ❌ eliminated';

      const handHtml = finalHand.length
        ? `<span class="round-hand-cards">${finalHand.map(card => `<span class="round-hand-card">${cardShortHtml(card)}</span>`).join('')}</span>`
        : '<span class="round-hand-empty">no cards</span>';

      const cls = ['round-player-row',
        isAssafed   ? 'assafed' : '',
        sc.reset    ? 'reset'   : '',
        sc.eliminated ? 'elim'  : '',
      ].filter(Boolean).join(' ');

      return `<div class="${cls}">
        <div class="round-player-name"><strong>${name}</strong></div>
        <div class="round-player-hand"><span class="round-label">Final hand</span>${handHtml}</div>
        <div class="round-player-score"><span class="round-label">Score</span><span>${delta}</span></div>
      </div>`;
    }).join('');
  }

  return `<div class="round-headline">${headline}</div><div class="round-score-changes">${rowsHtml}</div>`;
}

function formatLastTurn(t, me) {
  const isYou = me && me.name === t.player;
  const who   = isYou ? 'You' : esc(t.player);
  if (t.is_slamdown) {
    const card = t.discarded[0];
    return `💥 ${who} slammed down <strong>${cardShortHtml(card)}</strong>`;
  }
  const cards = t.discarded.map(cardShortHtml).join(' ');
  const drew =
    t.drawn_from === 'pile'
      ? t.drawn_card
        ? `<strong>${cardShortHtml(t.drawn_card)}</strong> from pile`
        : 'from pile'
      : 'from deck';
  return `${who} discarded <strong>${cards}</strong> · drew ${drew}`;
}
