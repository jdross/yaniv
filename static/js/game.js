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
const $lastAction   = document.getElementById('last-action');
const $turnStatus   = document.getElementById('turn-status');
const $discardPile  = document.getElementById('discard-pile');
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
    if (!data.error) onState(data);
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

  // Banners
  if (s.last_round) {
    $roundBanner.innerHTML = formatRoundBanner(s.last_round);
    show($roundBanner); hide($lastAction);
  } else {
    hide($roundBanner);
    if (s.last_turn) {
      $lastAction.innerHTML = formatLastTurn(s.last_turn, me);
      show($lastAction);
    } else {
      hide($lastAction);
    }
  }

  // Turn status
  $turnStatus.textContent = g.is_my_turn
    ? 'Your turn — select cards to discard, then choose where to draw.'
    : `Waiting for ${esc(g.current_player_name)}…`;

  // Discard pile
  $discardPile.innerHTML = g.discard_top.map(c => cardHtml(c)).join('');

  // Draw section
  if (g.is_my_turn) {
    show($drawSection);
    $deckSizeLabel.textContent = `${g.deck_size} left`;
    renderDrawOptions(g.draw_options);
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

function renderDrawOptions(options) {
  $drawOptions.innerHTML = '';

  $pileHint.textContent = options.length >= 2 ? '(run — pick an end card)'
                        : options.length === 0 ? '(none)' : '';

  options.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'draw-choice' + (selectedDraw === i ? ' selected' : '');
    div.innerHTML = `${cardHtml(c)}<span class="draw-label">${esc(c.rank)}${c.suit ? ' ' + suitSymbol(c.suit) : ''}</span>`;
    div.addEventListener('click', () => selectDraw(i));
    $drawOptions.appendChild(div);
  });

  $deckBtn.className = 'draw-choice deck-choice' + (selectedDraw === 'deck' ? ' selected' : '');
  $deckBtn.onclick = () => selectDraw('deck');
}

function selectDraw(val) {
  selectedDraw = val;
  renderDrawOptions(state.game.draw_options);
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

function updatePlayBtn() {
  const g = state && state.game;
  $playBtn.disabled = !g || !g.is_my_turn || !selectedCards.length || selectedDraw === null;
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

// ── Banner formatters ─────────────────────────────────────────────────────────
function formatRoundBanner(r) {
  let html = r.assaf
    ? `😱 <strong>${esc(r.assaf.assafed)}</strong> was Assafed by <strong>${esc(r.assaf.by)}</strong>!<br>`
    : `🎉 <strong>${esc(r.declarer)}</strong> called Yaniv!<br>`;
  if (r.resets?.length)     html += `🔄 Score reset: ${r.resets.map(esc).join(', ')}<br>`;
  if (r.eliminated?.length) html += `❌ Eliminated: ${r.eliminated.map(esc).join(', ')}`;
  return html;
}

function formatLastTurn(t, me) {
  const isYou = me && me.name === t.player;
  const who   = isYou ? 'You' : esc(t.player);
  const cards  = t.discarded.map(cardShort).join(' ');
  const drew   = t.drawn_from === 'pile'
    ? (t.drawn_card ? `<strong>${cardShort(t.drawn_card)}</strong> from the pile` : 'from the pile')
    : (isYou ? 'from the deck' : 'an unknown card from the deck');
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
