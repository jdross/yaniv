// ── State ──────────────────────────────────────────────────────────────────────
const code = location.pathname.split('/').pop().toLowerCase();
const pid  = (() => {
  let id = localStorage.getItem('yaniv_pid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('yaniv_pid', id); }
  return id;
})();

let state = null;          // latest server state
let selectedCards = [];    // card ids selected for discard
let selectedDraw  = null;  // 'deck' or index number

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $lobby     = document.getElementById('lobby');
const $board     = document.getElementById('board');
const $gameover  = document.getElementById('gameover');
const $lobbyCode = document.getElementById('lobby-code');
const $shareUrl  = document.getElementById('share-url');
const $lobbyPlayers = document.getElementById('lobby-players');
const $startBtn  = document.getElementById('start-btn');
const $scoreBar  = document.getElementById('score-bar');
const $roundBanner = document.getElementById('round-banner');
const $turnStatus  = document.getElementById('turn-status');
const $discardPile = document.getElementById('discard-pile');
const $drawSection = document.getElementById('draw-section');
const $drawOptions = document.getElementById('draw-options');
const $deckBtn     = document.getElementById('deck-btn');
const $hand        = document.getElementById('hand');
const $handValue   = document.getElementById('hand-value');
const $yanivBtn    = document.getElementById('yaniv-btn');
const $playBtn     = document.getElementById('play-btn');
const $gameError   = document.getElementById('game-error');
const $winnerText  = document.getElementById('winner-text');
const $finalScores = document.getElementById('final-scores');

// ── Socket ────────────────────────────────────────────────────────────────────
const socket = io();
socket.on('connect', () => {
  socket.emit('subscribe', { code, pid });
});
socket.on('state', onState);
socket.on('error', d => showError(d.msg));

// ── Initial load ──────────────────────────────────────────────────────────────
fetch(`/api/room/${code}`)
  .then(r => r.json())
  .then(d => { if (!d.error) onState(d); });

// ── State handler ─────────────────────────────────────────────────────────────
function onState(s) {
  state = s;
  selectedCards = [];
  selectedDraw  = null;
  clearError();

  if (s.status === 'waiting') {
    showLobby(s);
  } else if (s.status === 'finished') {
    showGameOver(s);
  } else {
    showBoard(s);
  }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function showLobby(s) {
  show($lobby); hide($board); hide($gameover);
  $lobbyCode.textContent = s.code;
  const url = location.href;
  $shareUrl.textContent = url;

  $lobbyPlayers.innerHTML = s.members.map(m =>
    `<div class="lobby-player">
       <span class="player-icon">${m.is_ai ? '🤖' : '👤'}</span>
       <span>${esc(m.name)}${m.pid === pid ? ' (you)' : ''}</span>
     </div>`
  ).join('');
}

$startBtn.addEventListener('click', () => {
  socket.emit('start', { code, pid });
});

// ── Board ─────────────────────────────────────────────────────────────────────
function showBoard(s) {
  hide($lobby); show($board); hide($gameover);

  const g = s.game;
  const me = g.players.find(p => p.is_self);

  // Scores
  $scoreBar.innerHTML = g.players.map(p =>
    `<div class="score-player ${p.is_current ? 'current' : ''} ${p.is_self ? 'self' : ''}">
       <div class="sp-name">${esc(p.name)}</div>
       <div class="sp-score">${p.score}</div>
       <div class="sp-cards">${p.hand_count} cards</div>
     </div>`
  ).join('');

  // Round banner
  if (s.last_round) {
    $roundBanner.innerHTML = formatRoundBanner(s.last_round);
    show($roundBanner);
  } else {
    hide($roundBanner);
  }

  // Turn status
  if (g.is_my_turn) {
    $turnStatus.textContent = 'Your turn — select cards to discard, then choose where to draw from.';
  } else {
    $turnStatus.textContent = `Waiting for ${esc(g.current_player_name)}…`;
  }

  // Discard pile
  $discardPile.innerHTML = g.discard_top.map(c => cardHtml(c)).join('');

  // Draw section
  if (g.is_my_turn) {
    show($drawSection);
    renderDrawOptions(g.draw_options);
  } else {
    hide($drawSection);
  }

  // Hand
  if (me && me.hand) {
    $hand.innerHTML = me.hand.map((c, i) =>
      `<div class="card ${cardColor(c)} ${selectedCards.includes(c.id) ? 'selected' : ''}"
            data-id="${c.id}" data-idx="${i}">
         <span class="card-num">${i+1}</span>
         <span class="card-rank">${esc(c.rank)}</span>
         <span class="card-suit">${suitSymbol(c.suit)}</span>
         <span class="card-rank-bot">${esc(c.rank)}</span>
       </div>`
    ).join('');

    const total = me.hand.reduce((s,c) => s + c.value, 0);
    $handValue.textContent = `(${total} pts)`;

    if (g.is_my_turn) {
      $hand.querySelectorAll('.card').forEach(el => {
        el.addEventListener('click', () => toggleCard(parseInt(el.dataset.id)));
      });
    }

    // Yaniv button
    if (g.is_my_turn && me.can_yaniv) {
      show($yanivBtn);
    } else {
      hide($yanivBtn);
    }
  } else {
    $hand.innerHTML = '<span style="opacity:.5;font-size:.85rem">Waiting for your hand…</span>';
    $handValue.textContent = '';
    hide($yanivBtn);
  }

  updatePlayBtn();
}

function renderDrawOptions(options) {
  // Keep deck button, rebuild pile options
  const existing = $drawOptions.querySelectorAll('.draw-choice:not(.deck-choice)');
  existing.forEach(e => e.remove());

  options.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'draw-choice' + (selectedDraw === i ? ' selected' : '');
    div.dataset.draw = i;
    div.innerHTML = `${cardHtml(c)}<span>${esc(c.rank)}${c.suit ? ' ' + suitSymbol(c.suit) : ''}</span>`;
    div.addEventListener('click', () => selectDraw(i));
    $drawOptions.appendChild(div);
  });

  // Update deck selected state
  $deckBtn.className = 'draw-choice deck-choice' + (selectedDraw === 'deck' ? ' selected' : '');
  $deckBtn.onclick = () => selectDraw('deck');
}

function selectDraw(val) {
  selectedDraw = val;
  // re-render draw choices highlighting
  const g = state.game;
  renderDrawOptions(g.draw_options);
  updatePlayBtn();
}

function toggleCard(id) {
  if (selectedCards.includes(id)) {
    selectedCards = selectedCards.filter(x => x !== id);
  } else {
    selectedCards.push(id);
  }
  // Re-render hand with new selection
  showBoard(state);
  updatePlayBtn();
}

function updatePlayBtn() {
  const g = state && state.game;
  if (!g || !g.is_my_turn) { $playBtn.disabled = true; return; }
  $playBtn.disabled = !(selectedCards.length > 0 && selectedDraw !== null);
}

$playBtn.addEventListener('click', playTurn);
$yanivBtn.addEventListener('click', () => {
  socket.emit('action', { code, pid, declare_yaniv: true });
});

function playTurn() {
  if (!state || !state.game || !state.game.is_my_turn) return;
  if (!selectedCards.length) { showError('Select cards to discard'); return; }
  if (selectedDraw === null) { showError('Choose where to draw from'); return; }
  socket.emit('action', {
    code, pid,
    discard: selectedCards,
    draw: selectedDraw,
  });
}

// ── Game Over ─────────────────────────────────────────────────────────────────
function showGameOver(s) {
  hide($lobby); hide($board); show($gameover);
  $winnerText.textContent = `${s.winner} wins!`;
  if (s.game) {
    $finalScores.innerHTML = s.game.players
      .slice()
      .sort((a,b) => a.score - b.score)
      .map(p => `<div class="final-score-row ${p.name === s.winner ? 'winner' : ''}">
                   <span>${esc(p.name)}</span><span>${p.score} pts</span>
                 </div>`)
      .join('');
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!state || state.status !== 'playing') return;
  const g = state.game;
  if (!g || !g.is_my_turn) return;

  const me = g.players.find(p => p.is_self);
  if (!me || !me.hand) return;

  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const n = parseInt(e.key);
  if (n >= 1 && n <= me.hand.length) {
    e.preventDefault();
    toggleCard(me.hand[n-1].id);
  } else if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    selectDraw('deck');
  } else if (e.key === 'p' || e.key === 'P') {
    e.preventDefault();
    if (g.draw_options.length === 1) selectDraw(0);
    else if (g.draw_options.length > 1) {
      const next = (selectedDraw === null || selectedDraw === 'deck') ? 0
                 : (selectedDraw + 1) % g.draw_options.length;
      selectDraw(next);
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!$playBtn.disabled) playTurn();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    if (me.can_yaniv) socket.emit('action', { code, pid, declare_yaniv: true });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function cardHtml(c) {
  const suit = c.suit ? suitSymbol(c.suit) : '🃏';
  const color = cardColor(c);
  return `<div class="card ${color}">
    <span class="card-rank">${esc(c.rank)}</span>
    <span class="card-suit">${suit}</span>
    <span class="card-rank-bot">${esc(c.rank)}</span>
  </div>`;
}

function suitSymbol(suit) {
  return { Clubs: '♣', Diamonds: '♦', Hearts: '♥', Spades: '♠' }[suit] || '';
}

function cardColor(c) {
  return (c.suit === 'Hearts' || c.suit === 'Diamonds') ? 'red' : '';
}

function formatRoundBanner(r) {
  let html = '';
  if (r.assaf) {
    html += `😱 <strong>${esc(r.assaf.assafed)}</strong> was Assafed by <strong>${esc(r.assaf.by)}</strong>!<br>`;
  } else {
    html += `🎉 <strong>${esc(r.declarer)}</strong> called Yaniv!<br>`;
  }
  if (r.resets && r.resets.length) {
    html += `🔄 Score reset: ${r.resets.map(esc).join(', ')}<br>`;
  }
  if (r.eliminated && r.eliminated.length) {
    html += `❌ Eliminated: ${r.eliminated.map(esc).join(', ')}`;
  }
  return html;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function showError(msg) { $gameError.textContent = msg; }
function clearError() { $gameError.textContent = ''; }
