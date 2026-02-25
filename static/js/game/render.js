// Rendering and markup helpers.
let pileLayoutRafId = null;

function showJoin(s) {
  resetRoundResultState();
  showScreen($joinScreen);
  $joinCode.textContent = s.code;
  $joinError.textContent = '';

  $joinPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.isAi ? '🤖' : '👤'}</span>
       <span class="player-name">${esc(m.name)}</span>
     </div>`
  ).join('');

  const humanCount = s.members.filter(m => !m.isAi).length;
  if (s.status === 'playing') {
    hide($joinForm);
    hide($joinFullMsg);
    show($joinStartedMsg);
    $joinStartedMsg.textContent = 'Game in progress. Select a player to continue.';

    const humanPlayers = s.members.filter(m => !m.isAi);
    const prevSelectedPid = $joinPlayerSelect.value;
    $joinPlayerSelect.innerHTML = humanPlayers.map((member) => {
      const turnSuffix = s.game?.currentPlayerName === member.name ? ' (current turn)' : '';
      return `<option value="${esc(member.pid)}">${esc(member.name)}${turnSuffix}</option>`;
    }).join('');

    if (humanPlayers.length > 0) {
      $joinPlayerSelect.value = humanPlayers.some((member) => member.pid === prevSelectedPid)
        ? prevSelectedPid
        : humanPlayers[0].pid;
      show($joinClaimForm);
    } else {
      hide($joinClaimForm);
      $joinStartedMsg.textContent = 'Game in progress. No human seats are available.';
    }
    return;
  }

  hide($joinClaimForm);
  if (s.status !== 'waiting') {
    hide($joinForm);
    hide($joinFullMsg);
    show($joinStartedMsg);
    $joinStartedMsg.textContent = 'This game has finished. You can watch results but not join.';
  } else if (humanCount >= 4) {
    hide($joinForm);
    show($joinFullMsg);
    hide($joinStartedMsg);
  } else {
    show($joinForm);
    hide($joinFullMsg);
    hide($joinStartedMsg);
  }
}

function showLobby(s) {
  resetRoundResultState();
  showScreen($lobby);
  $lobbyCode.textContent = s.code;
  $shareBtn.textContent = getShareButtonLabel();

  $lobbyPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.isAi ? '🤖' : '👤'}</span>
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
  const firstHuman = s.members.find(m => !m.isAi);
  const hasAi = s.members.some(m => m.isAi);
  if (firstHuman && firstHuman.pid === pid && !hasAi) {
    if ($slamdownsCheckbox) $slamdownsCheckbox.checked = s.options?.slamdownsAllowed !== false;
    show($lobbyOptions);
  } else {
    hide($lobbyOptions);
  }
}

function showBoard(s) {
  showScreen($board);

  const g = s.game;
  const me = getSelfPlayer(s);

  // Scores.
  $scoreBar.innerHTML = g.players.map(p =>
    `<div class="score-player ${p.isCurrent ? 'current' : ''} ${p.isSelf ? 'self' : ''}">
       <div class="sp-name">${esc(p.name)}</div>
       <div class="sp-score">${p.score}</div>
       <div class="sp-cards">${p.handCount} card${p.handCount !== 1 ? 's' : ''}</div>
     </div>`
  ).join('');

  // Turn log (last 3 plays, animated).
  renderTurnLog(s.lastTurn, s.lastRound);

  // Turn status — only shown when it's your turn.
  if (g.isMyTurn) {
    $turnStatus.textContent = UI_TEXT.turnPrompt;
    show($turnStatus);
  } else {
    hide($turnStatus);
  }

  // Draw section — always visible; interactive only on your turn.
  show($drawSection);
  $deckSizeLabel.textContent = `${g.deckSize} left`;
  if (g.isMyTurn) {
    if (selectedDraw === null) selectedDraw = 'deck';
    renderDrawOptions(g.drawOptions, g.discardTop, true);
  } else {
    renderDrawOptions([], g.discardTop, false);
  }

  // Hand — always sorted client-side; click handlers always attached for pre-selection.
  if (me && me.hand) {
    const hand = sortHand(me.hand);
    $hand.innerHTML = hand.map((c, i) => {
      const classes = [
        'card',
        cardColor(c),
        selectedCards.includes(c.id) ? 'selected' : '',
        c.id === newCardId ? 'card-new' : '',
      ].filter(Boolean).join(' ');
      return `<div class="${classes}" data-id="${c.id}">
         <span class="card-num">${i + 1}</span>
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

    (g.isMyTurn && me.canYaniv) ? show($yanivBtn) : hide($yanivBtn);
    (g.slamdownsAllowed && g.canSlamdown && !g.isMyTurn) ? show($slamdownBtn) : hide($slamdownBtn);
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
    lastTurn.drawnFrom,
    lastTurn.drawnCard ? lastTurn.drawnCard.id : '',
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

function roundPlayerLabel(name, myName) {
  return name === myName ? 'You' : name;
}

function roundScorePriority(sc, myName, winnerName, loserName) {
  if (sc.name === myName) return 0;
  if (loserName && sc.name === loserName) return 1;
  if (winnerName && sc.name === winnerName) return 2;
  if (sc.eliminated) return 3;
  return 4;
}

function formatRoundResultModal(round, currentState) {
  const myName = getSelfPlayer(currentState)?.name;
  const winnerName = round.assaf ? round.assaf.by : round.declarer;
  const loserName = round.assaf ? round.assaf.assafed : null;
  const declarerLabel = roundPlayerLabel(round.declarer, myName);

  let heroTitle = '';
  let heroSubline = '';
  let heroClass = 'round-hero';
  if (round.assaf) {
    const assafedLabel = roundPlayerLabel(round.assaf.assafed, myName);
    const blockerLabel = roundPlayerLabel(round.assaf.by, myName);
    heroClass += ' assaf';
    heroTitle = `${assafedLabel} ${assafedLabel === 'You' ? 'were' : 'was'} ASSAF'ed!`;
    if (round.declarerHandValue != null) {
      heroSubline = `${declarerLabel} called Yaniv at ${round.declarerHandValue} pts. ${blockerLabel} matched or beat it, so ${assafedLabel} gets +30.`;
    } else {
      heroSubline = `${blockerLabel} matched or beat the Yaniv call, so ${assafedLabel} gets +30.`;
    }
  } else {
    if (round.declarer === myName) {
      heroTitle = 'You WON the round!';
    } else {
      heroTitle = `${declarerLabel} called Yaniv!`;
    }
    heroClass += ' yaniv';
    heroSubline = round.declarerHandValue != null
      ? `Yaniv declared at ${round.declarerHandValue} pts.`
      : 'Yaniv declared this round.';
  }

  let rowsHtml = '';
  if (round.scoreChanges?.length) {
    const sorted = [...round.scoreChanges].sort((a, b) => {
      const priorityDiff = roundScorePriority(a, myName, winnerName, loserName)
        - roundScorePriority(b, myName, winnerName, loserName);
      if (priorityDiff !== 0) return priorityDiff;
      const impactDiff = Math.abs(b.added) - Math.abs(a.added);
      if (impactDiff !== 0) return impactDiff;
      return a.name.localeCompare(b.name);
    });

    rowsHtml = sorted.map((sc, index) => {
      const isMe = myName === sc.name;
      const isWinner = sc.name === winnerName;
      const isLoser = loserName && sc.name === loserName;
      const finalHand = Array.isArray(sc.finalHand) ? sc.finalHand : [];
      const scoreImpact = isWinner && sc.added === 0
        ? 'WON'
        : (sc.added > 0 ? `+${sc.added}` : `${sc.added}`);
      const impactTone = isWinner
        ? 'good'
        : (isLoser || sc.eliminated || sc.added > 0)
          ? 'bad'
          : (sc.added < 0 ? 'good' : 'neutral');
      const handHtml = finalHand.length
        ? `<span class="round-hand-cards">${finalHand.map(card => `<span class="round-hand-card">${cardShortHtml(card)}</span>`).join('')}</span>`
        : '<span class="round-hand-empty">no cards</span>';

      const cls = [
        'round-player-row',
        isMe ? 'me' : '',
        isWinner ? 'winner' : '',
        isLoser ? 'loser' : '',
        sc.reset ? 'reset' : '',
        sc.eliminated ? 'elim' : '',
      ].filter(Boolean).join(' ');

      return `<div class="${cls}" style="--row-delay:${index * 80}ms">
        <div class="round-row-top">
          <div class="round-player-main">
            <div class="round-player-name"><strong>${esc(roundPlayerLabel(sc.name, myName))}</strong></div>
            <div class="round-impact ${impactTone}">
              <span class="round-impact-value">${scoreImpact}</span>
            </div>
          </div>
          <div class="round-total-score">${sc.newScore}</div>
        </div>
        <div class="round-player-hand">${handHtml}</div>
      </div>`;
    }).join('');
  }

  return `<div class="${heroClass}">
    <div class="round-hero-title">${esc(heroTitle)}</div>
    <div class="round-hero-subline">${esc(heroSubline)}</div>
  </div>
  <div class="round-score-changes">${rowsHtml}</div>`;
}

function formatLastTurn(t, me) {
  const isYou = me && me.name === t.player;
  const who = isYou ? 'You' : esc(t.player);
  if (t.isSlamdown) {
    const card = t.discarded[0];
    return `💥 ${who} slammed down <strong>${cardShortHtml(card)}</strong>`;
  }
  const cards = t.discarded.map(cardShortHtml).join(' ');
  const drew =
    t.drawnFrom === 'pile'
      ? t.drawnCard
        ? `<strong>${cardShortHtml(t.drawnCard)}</strong> from pile`
        : 'from pile'
      : 'from deck';
  return `${who} discarded <strong>${cards}</strong> · drew ${drew}`;
}
