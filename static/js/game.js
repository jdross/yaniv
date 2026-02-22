// ── Identity ──────────────────────────────────────────────────────────────────
const code = location.pathname.split('/').pop().toLowerCase();
const pid  = (() => {
  let id = localStorage.getItem('yaniv_pid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('yaniv_pid', id); }
  return id;
})();

let state        = null;
let selectedCards = [];
let selectedDraw  = null;
let prevTurnKey  = null;   // fingerprint of the last rendered turn
let prevRoundKey = null;   // fingerprint of the last rendered round banner

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $lobby        = document.getElementById('lobby');
const $board        = document.getElementById('board');
const $gameover     = document.getElementById('gameover');
const $lobbyCode    = document.getElementById('lobby-code');
const $shareUrl     = document.getElementById('share-url');
const $lobbyPlayers = document.getElementById('lobby-players');
const $startBtn     = document.getElementById('start-btn');
const $scoreBar     = document.getElementById('score-bar');
const $roundBanner  = document.getElementById('round-banner');
const $turnLog      = document.getElementById('turn-log');
const $turnStatus   = document.getElementById('turn-status');
const $drawSection  = document.getElementById('draw-section');
const $drawOptions  = document.getElementById('draw-options');
const $deckBtn      = document.getElementById('deck-btn');
const $deckSizeLabel = document.getElementById('deck-size-label');
const $pileHint     = document.getElementById('pile-hint');
const $hand         = document.getElementById('hand');
const $handValue    = document.getElementById('hand-value');
const $yanivBtn     = document.getElementById('yaniv-btn');
const $playBtn      = document.getElementById('play-btn');
const $gameError    = document.getElementById('game-error');
const $winnerText   = document.getElementById('winner-text');
const $finalScores  = document.getElementById('final-scores');

// ── SSE connection ────────────────────────────────────────────────────────────
const es = new EventSource(`/api/events/${code}/${pid}`);
es.onmessage = e => onState(JSON.parse(e.data));
es.onerror   = () => { /* reconnects automatically */ };

// Polling fallback: if the hand isn't arriving via SSE (e.g. pid mismatch from
// a cached page), fetch state over HTTP which always passes the correct pid.
setInterval(async () => {
  if (!state?.game) return;
  if (state.game.players?.find(p => p.is_self)?.hand) return; // SSE working fine
  try {
    const res  = await fetch(`/api/room/${code}?pid=${encodeURIComponent(pid)}`);
    const data = await res.json();
    onState(data); // onState handles errors (redirects home)
  } catch (_) {}
}, 1500);

// ── API helpers ───────────────────────────────────────────────────────────────
async function post(url, body) {
  clearError();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) showError(data.error);
    return data;
  } catch (err) {
    showError('Network error');
  }
}

// ── State handler ─────────────────────────────────────────────────────────────
function onState(s) {
  if (s.error) { window.location.href = '/'; return; }

  state        = s;
  selectedCards = [];
  selectedDraw  = null;
  clearError();

  if (s.status === 'waiting')        showLobby(s);
  else if (s.status === 'finished')  showGameOver(s);
  else                               showBoard(s);
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function showLobby(s) {
  show($lobby); hide($board); hide($gameover);
  $lobbyCode.textContent = s.code;
  $shareUrl.textContent  = location.href;

  $lobbyPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.is_ai ? '🤖' : '👤'}</span>
       <span>${esc(m.name)}${m.pid === pid ? ' (you)' : ''}</span>
     </div>`
  ).join('');
}

$startBtn.addEventListener('click', () => {
  post('/api/start', { code, pid });
});

// ── Board ─────────────────────────────────────────────────────────────────────
function showBoard(s) {
  hide($lobby); show($board); hide($gameover);

  const g  = s.game;
  const me = g.players.find(p => p.is_self);

  // Scores
  $scoreBar.innerHTML = g.players.map(p =>
    `<div class="score-player ${p.is_current ? 'current' : ''} ${p.is_self ? 'self' : ''}">
       <div class="sp-name">${esc(p.name)}</div>
       <div class="sp-score">${p.score}</div>
       <div class="sp-cards">${p.hand_count} card${p.hand_count !== 1 ? 's' : ''}</div>
     </div>`
  ).join('');

  // Round result banner (Yaniv / Assaf) — persists for one full lap
  if (s.last_round) {
    $roundBanner.innerHTML = formatRoundBanner(s.last_round);
    show($roundBanner);
  } else {
    hide($roundBanner);
  }

  // Turn log (last 3 plays, animated)
  renderTurnLog(s.last_turn, s.last_round);

  // Turn status
  $turnStatus.textContent = g.is_my_turn
    ? 'Your turn — select cards to discard, then choose where to draw.'
    : `Waiting for ${esc(g.current_player_name)}…`;

  // Draw section
  if (g.is_my_turn) {
    show($drawSection);
    $deckSizeLabel.textContent = `${g.deck_size} left`;
    renderDrawOptions(g.draw_options, g.discard_top);
  } else {
    hide($drawSection);
  }

  // Hand
  if (me && me.hand) {
    $hand.innerHTML = me.hand.map((c, i) =>
      `<div class="card ${cardColor(c)} ${selectedCards.includes(c.id) ? 'selected' : ''}"
            data-id="${c.id}">
         <span class="card-num">${i+1}</span>
         <span class="card-rank">${esc(c.rank)}</span>
         <span class="card-suit">${c.suit ? suitSymbol(c.suit) : '🃏'}</span>
         <span class="card-rank-bot">${esc(c.rank)}</span>
       </div>`
    ).join('');

    $handValue.textContent = `(${me.hand.reduce((s, c) => s + c.value, 0)} pts)`;

    if (g.is_my_turn) {
      $hand.querySelectorAll('.card').forEach(el => {
        el.onclick = () => toggleCard(parseInt(el.dataset.id));
      });
    }

    (g.is_my_turn && me.can_yaniv) ? show($yanivBtn) : hide($yanivBtn);
  } else {
    $hand.innerHTML = '<span style="opacity:.5;font-size:.85rem">Waiting for your hand…</span>';
    $handValue.textContent = '';
    hide($yanivBtn);
  }

  updatePlayBtn();
}

function renderDrawOptions(options, discardTop) {
  $drawOptions.innerHTML = '';

  // Distinguish single / set / run for the hint label
  if (!discardTop || discardTop.length === 0 || options.length === 0) {
    $pileHint.textContent = options.length === 0 ? '(none)' : '';
  } else if (discardTop.length === 1) {
    $pileHint.textContent = '';
  } else if (discardTop.length > options.length) {
    // run: fewer selectable options than cards discarded (only end cards)
    $pileHint.textContent = '(run — pick an end card)';
  } else {
    // set: all discarded cards are selectable
    $pileHint.textContent = '(set — choose 1 card)';
  }

  // Show ALL discarded cards; only valid picks are clickable
  (discardTop || []).forEach(c => {
    const optionIndex = options.findIndex(o => o.id === c.id);
    const isSelectable = optionIndex !== -1;

    const div = document.createElement('div');
    div.className = 'draw-choice'
      + (isSelectable && selectedDraw === optionIndex ? ' selected' : '')
      + (isSelectable ? '' : ' pile-inactive');
    div.innerHTML = `${cardHtml(c)}<span class="draw-label">${esc(c.rank)}${c.suit ? ' ' + suitSymbol(c.suit) : ''}</span>`;
    if (isSelectable) div.addEventListener('click', () => selectDraw(optionIndex));
    $drawOptions.appendChild(div);
  });

  $deckBtn.className = 'draw-choice deck-choice' + (selectedDraw === 'deck' ? ' selected' : '');
  $deckBtn.onclick = () => selectDraw('deck');
}

function selectDraw(val) {
  selectedDraw = val;
  renderDrawOptions(state.game.draw_options, state.game.discard_top);
  updatePlayBtn();
}

function toggleCard(id) {
  selectedCards = selectedCards.includes(id)
    ? selectedCards.filter(x => x !== id)
    : [...selectedCards, id];

  $hand.querySelectorAll('.card').forEach(el => {
    el.classList.toggle('selected', selectedCards.includes(parseInt(el.dataset.id)));
  });

  const me = state.game.players.find(p => p.is_self);
  if (me && me.hand) {
    $handValue.textContent = `(${me.hand.reduce((s, c) => s + c.value, 0)} pts)`;
  }
  updatePlayBtn();
}

function isValidRun(cards) {
  const nonJokers = cards.filter(c => c.rank !== 'Joker');
  const jokerCount = cards.length - nonJokers.length;
  if (nonJokers.length > 0 && new Set(nonJokers.map(c => c.suit)).size > 1) return false;
  const ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const ranks = nonJokers.map(c => ORDER.indexOf(c.rank)).sort((a, b) => a - b);
  let needed = 0;
  for (let i = 0; i < ranks.length - 1; i++) needed += ranks[i + 1] - ranks[i] - 1;
  return needed <= jokerCount;
}

function isValidDiscard(ids) {
  const me = state?.game?.players?.find(p => p.is_self);
  if (!me?.hand) return { valid: false };
  const cards = ids.map(id => me.hand.find(c => c.id === id)).filter(Boolean);
  if (cards.length === 0) return { valid: false };
  if (cards.length === 1) return { valid: true };

  // Set: all non-jokers share the same rank
  const nonJokers = cards.filter(c => c.rank !== 'Joker');
  if (nonJokers.length === 0 || new Set(nonJokers.map(c => c.rank)).size === 1) {
    return { valid: true };
  }

  // Run: 3+ cards, same suit, consecutive (jokers fill gaps)
  if (cards.length >= 3 && isValidRun(cards)) return { valid: true };

  if (cards.length === 2) {
    return { valid: false, reason: 'Two cards must share the same rank' };
  }
  return { valid: false, reason: 'Cards must form a set (same rank) or a run (3+ same suit, consecutive)' };
}

function updatePlayBtn() {
  const g = state && state.game;
  if (!g || !g.is_my_turn) { $playBtn.disabled = true; return; }
  if (!selectedCards.length) { $playBtn.disabled = true; clearError(); return; }

  const { valid, reason } = isValidDiscard(selectedCards);
  $playBtn.disabled = !valid || selectedDraw === null;
  if (!valid && reason) showError(reason);
  else clearError();
}

$playBtn.addEventListener('click', playTurn);
$yanivBtn.addEventListener('click', () => {
  post('/api/action', { code, pid, declare_yaniv: true });
});

async function playTurn() {
  if (!state?.game?.is_my_turn) return;
  if (!selectedCards.length)  { showError('Select cards to discard'); return; }
  if (selectedDraw === null)  { showError('Choose where to draw from'); return; }
  post('/api/action', { code, pid, discard: selectedCards, draw: selectedDraw });
}

// ── Game Over ─────────────────────────────────────────────────────────────────
function showGameOver(s) {
  hide($lobby); hide($board); show($gameover);
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

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!state?.game?.is_my_turn) return;
  const me = state.game.players.find(p => p.is_self);
  if (!me?.hand) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  const n = parseInt(e.key);
  if (n >= 1 && n <= me.hand.length) {
    e.preventDefault(); toggleCard(me.hand[n - 1].id);
  } else if (e.key === 'd' || e.key === 'D') {
    e.preventDefault(); selectDraw('deck');
  } else if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    const opts = state.game.draw_options;
    if (opts.length === 1) selectDraw(0);
    else if (opts.length > 1) {
      const next = (selectedDraw === null || selectedDraw === 'deck') ? 0
                 : (selectedDraw + 1) % opts.length;
      selectDraw(next);
    }
  } else if (e.key === 'Enter') {
    e.preventDefault(); if (!$playBtn.disabled) playTurn();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    if (me.can_yaniv) post('/api/action', { code, pid, declare_yaniv: true });
  }
});

// ── Card rendering helpers ────────────────────────────────────────────────────
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

function suitSymbol(suit) {
  return { Clubs: '♣', Diamonds: '♦', Hearts: '♥', Spades: '♠' }[suit] || '';
}

function cardColor(c) {
  return (c.suit === 'Hearts' || c.suit === 'Diamonds') ? 'red' : '';
}

// ── Turn log (last 3 plays with slide-in animation) ───────────────────────────
function renderTurnLog(lastTurn, lastRound) {
  // When a brand-new round starts, wipe the log so old turns don't linger
  const roundKey = lastRound ? JSON.stringify(lastRound) : null;
  if (roundKey !== prevRoundKey) {
    if (roundKey && !prevRoundKey) {
      // New round just started — clear old turns
      $turnLog.innerHTML = '';
      prevTurnKey = null;
    }
    prevRoundKey = roundKey;
  }

  if (!lastTurn) return;

  const key = JSON.stringify(lastTurn);
  if (key === prevTurnKey) return; // already rendered this turn
  prevTurnKey = key;

  const me = state?.game?.players?.find(p => p.is_self);
  const el = document.createElement('div');
  el.className = 'turn-log-item new';
  el.innerHTML = formatLastTurn(lastTurn, me);
  $turnLog.insertBefore(el, $turnLog.firstChild);

  // Keep at most 3 entries
  while ($turnLog.children.length > 3) $turnLog.removeChild($turnLog.lastChild);
}

// ── Banner formatters ─────────────────────────────────────────────────────────
function formatRoundBanner(r) {
  const myName = state?.game?.players?.find(p => p.is_self)?.name;
  const handPts = r.declarer_hand_value != null ? ` (${r.declarer_hand_value} pts)` : '';

  // Headline
  let headline;
  if (r.assaf) {
    const assafedStr = myName === r.assaf.assafed ? 'You' : `<strong>${esc(r.assaf.assafed)}</strong>`;
    const byStr      = myName === r.assaf.by      ? 'you'  : `<strong>${esc(r.assaf.by)}</strong>`;
    headline = `😱 ${assafedStr} called Yaniv${handPts} but got Assaf'd by ${byStr}!`;
  } else {
    const who = myName === r.declarer ? 'You' : `<strong>${esc(r.declarer)}</strong>`;
    headline = `🎉 ${who} called Yaniv${handPts}!`;
  }

  // Per-player score chips
  let chipsHtml = '';
  if (r.score_changes?.length) {
    const chips = r.score_changes.map(sc => {
      const isMe       = myName === sc.name;
      const name       = isMe ? 'You' : esc(sc.name);
      const isAssafed  = r.assaf?.assafed === sc.name;

      let delta;
      if (sc.added === 0)  delta = `→ ${sc.new_score}`;
      else if (sc.reset)   delta = `+${sc.added} → reset to ${sc.new_score}`;
      else                 delta = `+${sc.added} → ${sc.new_score}`;
      if (sc.eliminated)   delta += ' ❌';

      const cls = ['score-chip',
        isAssafed   ? 'assafed' : '',
        sc.reset    ? 'reset'   : '',
        sc.eliminated ? 'elim'  : '',
      ].filter(Boolean).join(' ');

      return `<span class="${cls}"><strong>${name}</strong> ${delta}</span>`;
    }).join('');
    chipsHtml = `<div class="round-score-changes">${chips}</div>`;
  }

  return `<div class="round-headline">${headline}</div>${chipsHtml}`;
}

function formatLastTurn(t, me) {
  const isYou = me && me.name === t.player;
  const who   = isYou ? 'You' : esc(t.player);
  const cards = t.discarded.map(cardShort).join(' ');
  const drew  = t.drawn_from === 'pile'
    ? (t.drawn_card ? `<strong>${cardShort(t.drawn_card)}</strong> from pile` : 'from pile')
    : (isYou ? 'from deck' : 'unknown card from deck');
  return `${who} discarded <strong>${cards}</strong> · drew ${drew}`;
}

// ── Misc ──────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function showError(msg) { $gameError.textContent = msg; }
function clearError()   { $gameError.textContent = ''; }
