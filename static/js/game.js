// ── Identity ──────────────────────────────────────────────────────────────────
const code = location.pathname.split('/').pop().toLowerCase();
const pid  = getYanivPid();
const { sortHand, suitSymbol, cardColor, validateDiscard } = window.YanivGameLogic;

let state         = null;
let selectedCards = [];
let selectedDraw  = null;
// ⚠️  DEDUP KEYS — canonical strings, NOT JSON.stringify()
//
// State arrives from two sources:
//   • SSE  — serialised from the in-memory Python dict (insertion-order keys)
//   • Poll — deserialised from a Postgres JSONB column (keys reordered
//            alphabetically by the DB engine)
//
// JSON.stringify() is key-order-sensitive, so the same logical object
// produces different strings depending on its source.  Every dedup key
// below must therefore be built by extracting named fields in a fixed,
// explicit order — never by stringifying the whole object.
let prevTurnKey     = null; // fingerprint of the last rendered turn
let prevRoundKey    = null; // fingerprint of the last rendered round banner
let prevAnimTurnKey = null; // last_turn key we've already animated
let prevYanivKey    = null; // last_round key we've already announced
let prevHandKey     = null; // hand fingerprint we've already highlighted (same rule: poll re-delivers same hand, must not re-trigger blink)

let actionInFlight = false; // true while a play/yaniv POST is in-flight
let newCardId      = null;  // id of the card just drawn (highlighted briefly)

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $joinScreen   = document.getElementById('join-screen');
const $joinCode     = document.getElementById('join-code');
const $joinPlayers  = document.getElementById('join-players');
const $joinForm     = document.getElementById('join-form');
const $joinBtn      = document.getElementById('join-btn');
const $joinNameInput = document.getElementById('join-name-input');
const $joinFullMsg  = document.getElementById('join-full-msg');
const $joinStartedMsg = document.getElementById('join-started-msg');
const $joinError    = document.getElementById('join-error');
const $lobby        = document.getElementById('lobby');
const $board        = document.getElementById('board');
const $gameover     = document.getElementById('gameover');
const $lobbyCode    = document.getElementById('lobby-code');
const $shareBtn     = document.getElementById('share-btn');
const $lobbyPlayers = document.getElementById('lobby-players');
const $startBtn     = document.getElementById('start-btn');
const $slamdownsCheckbox = document.getElementById('slamdowns-checkbox');
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
const $slamdownBtn  = document.getElementById('slamdown-btn');
const $playBtn      = document.getElementById('play-btn');
const $lobbyOptions = document.getElementById('lobby-options');
const $gameError    = document.getElementById('game-error');
const $winnerText   = document.getElementById('winner-text');
const $finalScores  = document.getElementById('final-scores');
const $playAgainBtn = document.getElementById('play-again-btn');

// ── SSE connection ────────────────────────────────────────────────────────────
// State is delivered exclusively via SSE — no periodic polling.  Polling was
// removed because it rebuilds DOM nodes on every tick, resetting CSS hover
// states and causing duplicate-entry bugs (SSE delivers dicts in insertion
// order; the poll REST endpoint returns JSONB with alphabetically-reordered
// keys, so JSON.stringify-based dedup keys never matched).
//
// Recovery: when the EventSource fires onerror (network blip, server restart,
// etc.) the browser automatically reconnects.  The server sends a fresh
// snapshot as the very first message of every new SSE connection, so no
// explicit recovery poll is needed.
const es = new EventSource(`/api/events/${code}/${pid}`);
es.onmessage = e => { onState(JSON.parse(e.data)); };
es.onerror   = () => { /* browser reconnects automatically; snapshot resent on reconnect */ };

// ── API helpers ───────────────────────────────────────────────────────────────
// Fetch current state once (used only to reset actionInFlight after a POST error,
// since SSE handles all normal state delivery).
async function fetchState() {
  try {
    const res  = await fetch(`/api/room/${code}?pid=${encodeURIComponent(pid)}`);
    const data = await res.json();
    onState(data);
  } catch (_) {}
}
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
  if (s.next_room) { window.location.href = `/game/${s.next_room}`; return; }

  // Compare hands using an order-independent fingerprint so server-side sorting
  // (start_turn) doesn't falsely look like a hand change.  Only clear the
  // pre-selection when the actual set of cards changes (cards played/drawn).
  const handOf = st => {
    const h = st?.game?.players?.find(p => p.is_self)?.hand;
    return h ? h.map(c => c.id).sort((a, b) => a - b).join(',') : null;
  };
  const oldHandKey = handOf(state);
  const newHandKey = handOf(s);
  let drawnCard = null;
  if (newHandKey !== null && newHandKey !== prevHandKey) {
    // Hand is genuinely new (not a repeat delivery of the same state).
    if (oldHandKey !== null && oldHandKey !== newHandKey) {
      // Hand actually changed — player just played their turn.
      // Detect which card is new so we can highlight it.
      const prevIds = new Set((state.game?.players?.find(p => p.is_self)?.hand ?? []).map(c => c.id));
      drawnCard     = (s.game?.players?.find(p => p.is_self)?.hand ?? []).find(c => !prevIds.has(c.id)) ?? null;
      newCardId     = drawnCard ? drawnCard.id : null;
    } else {
      // First hand received (round start) — no highlight, no pre-selection.
      newCardId = null;
    }
    selectedCards = [];
    prevHandKey   = newHandKey;
  }

  // Draw animation — fires once per unique last_turn when drawn from deck or pile
  if (s.last_turn && s.status === 'playing') {
    const t = s.last_turn;
    const animKey = [t.player, (t.discarded||[]).map(c=>c.id).sort((a,b)=>a-b).join(','), t.drawn_from, t.drawn_card?t.drawn_card.id:''].join('|');
    if (animKey !== prevAnimTurnKey) {
      const df = s.last_turn.drawn_from;
      if (df === 'deck' || df === 'pile') {
        const me = s.game?.players?.find(p => p.is_self);
        const isMyDraw = !!(me && me.name === s.last_turn.player);
        // Pile card is always face-up (server always reveals it in last_turn).
        // Deck card is only known when it's our own draw.
        const cardToShow = df === 'pile'
          ? s.last_turn.drawn_card
          : (isMyDraw ? drawnCard : null);
        animateCardDraw(isMyDraw, cardToShow, df === 'pile');
      }
    }
    prevAnimTurnKey = animKey;
  }

  // Yaniv / Assaf announcement animation — guard against first-load replay
  if (s.last_round) {
    const r = s.last_round;
    const yanivKey = [r.declarer, (r.score_changes||[]).map(s=>s.name+':'+s.new_score).sort().join(',')].join('|');
    if (yanivKey !== prevYanivKey && state !== null) animateYaniv(s.last_round);
    prevYanivKey = yanivKey;
  }

  // Clear draw-source selection whenever it's not our turn.
  if (!s.game?.is_my_turn) selectedDraw = null;

  state          = s;
  actionInFlight = false;
  clearError();

  const isMember = s.members.some(m => m.pid === pid);
  if (!isMember) { showJoin(s); return; }

  if (s.status === 'waiting')        showLobby(s);
  else if (s.status === 'finished')  showGameOver(s);
  else                               showBoard(s);
}

// ── Join screen (visitor not yet in room) ────────────────────────────────────
function showJoin(s) {
  show($joinScreen); hide($lobby); hide($board); hide($gameover);
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

$joinBtn.addEventListener('click', async () => {
  const name = $joinNameInput.value.trim() || 'Player';
  const res  = await fetch('/api/join', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pid, code, name }),
  });
  const data = await res.json();
  if (data.error) { $joinError.textContent = data.error; return; }
  // Fetch state immediately so the lobby appears without waiting for SSE.
  // The SSE broadcast will also arrive and is harmlessly idempotent.
  fetchState();
});

$joinNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') $joinBtn.click();
});

// ── Lobby ─────────────────────────────────────────────────────────────────────
function showLobby(s) {
  show($lobby); hide($joinScreen); hide($board); hide($gameover);
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

  // Show slamdown option only to the creator when there are no AIs
  const firstHuman = s.members.find(m => !m.is_ai);
  const hasAi = s.members.some(m => m.is_ai);
  if (firstHuman && firstHuman.pid === pid && !hasAi) {
    if ($slamdownsCheckbox) $slamdownsCheckbox.checked = s.options?.slamdowns_allowed !== false;
    show($lobbyOptions);
  } else {
    hide($lobbyOptions);
  }
}

// ── Share link ────────────────────────────────────────────────────────────────
function isMobileDevice() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
    return navigator.userAgentData.mobile;
  }
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(ua)) return true;
  // iPadOS can report as Mac; touch points disambiguate.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function canUseNativeShareSheet() {
  return isMobileDevice() && typeof navigator.share === 'function';
}

function getShareButtonLabel() {
  return canUseNativeShareSheet() ? 'Share link' : 'Copy link';
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fall back to execCommand below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (_) {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

$shareBtn.addEventListener('click', async () => {
  if (canUseNativeShareSheet()) {
    try {
      await navigator.share({
        title: 'Yaniv',
        text: 'Join my Yaniv game',
        url: location.href,
      });
      return;
    } catch (err) {
      // If share is cancelled, do nothing. Otherwise fall back to copy.
      if (err && err.name === 'AbortError') return;
    }
  }

  const copied = await copyTextToClipboard(location.href);
  if (copied) {
    $shareBtn.textContent = 'Copied!';
    $shareBtn.classList.add('copied');
    setTimeout(() => {
      $shareBtn.textContent = getShareButtonLabel();
      $shareBtn.classList.remove('copied');
    }, 2000);
  }
});

$startBtn.addEventListener('click', () => {
  const slamdowns_allowed = $slamdownsCheckbox ? $slamdownsCheckbox.checked : false;
  post('/api/start', { code, pid, slamdowns_allowed });
});

if ($slamdownsCheckbox) {
  $slamdownsCheckbox.addEventListener('change', async () => {
    if (!state || state.status !== 'waiting') return;

    const firstHuman = state.members.find(m => !m.is_ai);
    const hasAi = state.members.some(m => m.is_ai);
    const canEdit = !!firstHuman && firstHuman.pid === pid && !hasAi;
    if (!canEdit) {
      $slamdownsCheckbox.checked = false;
      return;
    }

    try {
      const res = await fetch('/api/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          pid,
          slamdowns_allowed: $slamdownsCheckbox.checked,
        }),
      });
      const data = await res.json();
      if (data.error) {
        fetchState();
        return;
      }
      if (data.options) {
        $slamdownsCheckbox.checked = !!data.options.slamdowns_allowed;
      }
    } catch (_) {
      fetchState();
    }
  });
}

// ── Board ─────────────────────────────────────────────────────────────────────
function showBoard(s) {
  hide($joinScreen); hide($lobby); show($board); hide($gameover);

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

  // Turn status — only shown when it's your turn
  if (g.is_my_turn) {
    $turnStatus.textContent = 'Your turn — select cards to discard, then choose where to draw.';
    show($turnStatus);
  } else {
    hide($turnStatus);
  }

  // Draw section — always visible; interactive only on your turn
  show($drawSection);
  $deckSizeLabel.textContent = `${g.deck_size} left`;
  if (g.is_my_turn) {
    if (selectedDraw === null) selectedDraw = 'deck';
    renderDrawOptions(g.draw_options, g.discard_top, true);
  } else {
    renderDrawOptions([], g.discard_top, false);
  }

  // Hand — always sorted client-side; click handlers always attached for pre-selection
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

    $handValue.textContent = `(${me.hand.reduce((s, c) => s + c.value, 0)} pts)`;

    // Always attach click handlers — cards can be pre-selected while waiting
    $hand.querySelectorAll('.card').forEach(el => {
      el.onclick = () => toggleCard(parseInt(el.dataset.id));
    });

    (g.is_my_turn && me.can_yaniv) ? show($yanivBtn) : hide($yanivBtn);
    (g.slamdowns_allowed && g.can_slamdown && !g.is_my_turn) ? show($slamdownBtn) : hide($slamdownBtn);
  } else {
    $hand.innerHTML = '<span style="opacity:.5;font-size:.85rem">Waiting for your hand…</span>';
    $handValue.textContent = '';
    hide($yanivBtn);
    hide($slamdownBtn);
  }

  updatePlayBtn();
}

function renderDrawOptions(options, discardTop, isMyTurn) {
  $drawOptions.innerHTML = '';

  // Pile hint — only meaningful on your turn
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

  // Show ALL discarded cards; only valid picks are clickable (on your turn)
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

  // Deck — selectable only on your turn
  $deckBtn.className = 'draw-choice deck-choice'
    + (isMyTurn && selectedDraw === 'deck' ? ' selected' : '')
    + (!isMyTurn ? ' pile-inactive' : '');
  $deckBtn.onclick = isMyTurn ? () => selectDraw('deck') : null;
}

function selectDraw(val) {
  selectedDraw = val;
  renderDrawOptions(state.game.draw_options, state.game.discard_top, state.game.is_my_turn);
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

function isValidDiscard(ids) {
  const me = state?.game?.players?.find(p => p.is_self);
  if (!me?.hand) return { valid: false };
  const cards = ids.map(id => me.hand.find(c => c.id === id)).filter(Boolean);
  return validateDiscard(cards);
}

function updatePlayBtn() {
  const g = state && state.game;
  if (!g || !g.is_my_turn || actionInFlight) { $playBtn.disabled = true; return; }
  if (!selectedCards.length) { $playBtn.disabled = true; clearError(); return; }

  const { valid, reason } = isValidDiscard(selectedCards);
  $playBtn.disabled = !valid || selectedDraw === null;
  if (!valid && reason) showError(reason);
  else clearError();
}

async function submitAction(payload, { hideSlamdown = false } = {}) {
  if (actionInFlight) return null;
  actionInFlight = true;
  if (hideSlamdown) hide($slamdownBtn);

  const res = await post('/api/action', { code, pid, ...payload });
  if (res?.error) {
    // On error the SSE update won't arrive, so fetch current state to reset
    // actionInFlight and show the real server state.
    fetchState();
  } else {
    // Success: SSE will deliver state and call onState(), which resets this too.
    actionInFlight = false;
  }
  return res;
}

$playBtn.addEventListener('click', playTurn);
$yanivBtn.addEventListener('click', async () => {
  await submitAction({ declare_yaniv: true });
});

$slamdownBtn.addEventListener('click', async () => {
  await submitAction({ declare_slamdown: true }, { hideSlamdown: true });
});

async function playTurn() {
  if (actionInFlight) return;
  if (!state?.game?.is_my_turn) return;
  if (!selectedCards.length)  { showError('Select cards to discard'); return; }
  if (selectedDraw === null)  { showError('Choose where to draw from'); return; }
  updatePlayBtn();
  await submitAction({ discard: selectedCards, draw: selectedDraw });
}

// ── Game Over ─────────────────────────────────────────────────────────────────
function showGameOver(s) {
  hide($joinScreen); hide($lobby); hide($board); show($gameover);
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

// ── Play again ────────────────────────────────────────────────────────────────
$playAgainBtn.addEventListener('click', async () => {
  $playAgainBtn.disabled = true;
  $playAgainBtn.textContent = 'Starting…';
  try {
    const res  = await fetch('/api/play_again', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code, pid }),
    });
    const data = await res.json();
    if (data.next_room) {
      window.location.href = `/game/${data.next_room}`;
    } else {
      $playAgainBtn.disabled = false;
      $playAgainBtn.textContent = 'Play again';
    }
  } catch (_) {
    $playAgainBtn.disabled = false;
    $playAgainBtn.textContent = 'Play again';
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const g = state?.game;
  if (!g) return;
  const me = g.players.find(p => p.is_self);
  if (!me?.hand) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  // Number keys: pre-select cards even while waiting for your turn
  const hand = sortHand(me.hand);
  const n = parseInt(e.key);
  if (n >= 1 && n <= hand.length) {
    e.preventDefault(); toggleCard(hand[n - 1].id); return;
  }

  // Draw / play / Yaniv shortcuts: only on your turn
  if (!g.is_my_turn) return;
  if (e.key === 'd' || e.key === 'D') {
    // Cycle through all draw options: deck → pile-0 → pile-1 → … → deck
    e.preventDefault();
    const opts = state.game.draw_options;
    if (opts.length === 0 || selectedDraw === null) {
      selectDraw('deck');
    } else if (selectedDraw === 'deck') {
      selectDraw(0);
    } else if (typeof selectedDraw === 'number' && selectedDraw < opts.length - 1) {
      selectDraw(selectedDraw + 1);
    } else {
      selectDraw('deck');
    }
  } else if (e.key === 'Enter') {
    e.preventDefault(); if (!$playBtn.disabled) playTurn();
  } else if (e.key === 'y' || e.key === 'Y') {
    e.preventDefault();
    if (me.can_yaniv && !actionInFlight) {
      submitAction({ declare_yaniv: true });
    }
  }
});

// ── Card draw animation ───────────────────────────────────────────────────────
// Spawns a card that flies from the source (deck or pile) toward the hand
// (my draw) or score bar (opponent's draw), fading out over 1 s.
// drawnCard: card object to show face-up, or null for a face-down back.
// fromPile:  true → source is the discard pile area; false → deck button.
function animateCardDraw(isMyDraw, drawnCard, fromPile) {
  const srcEl   = fromPile ? $drawOptions : $deckBtn;
  const srcRect = srcEl.getBoundingClientRect();
  if (!srcRect.width) return; // source not visible

  const W = 60, H = 88;
  const srcCX = srcRect.left + srcRect.width  / 2;
  const srcCY = srcRect.top  + srcRect.height / 2;

  let tgtCX, tgtCY;
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

  flyEl.style.left = `${srcCX - W / 2}px`;
  flyEl.style.top  = `${srcCY - H / 2}px`;
  document.body.appendChild(flyEl);

  // Force a reflow so the start position is painted before the transition kicks in
  flyEl.getBoundingClientRect();
  flyEl.style.transition = 'left 1s ease-in-out, top 1s ease-in-out, opacity 1s ease-in-out';
  flyEl.style.left    = `${tgtCX - W / 2}px`;
  flyEl.style.top     = `${tgtCY - H / 2}px`;
  flyEl.style.opacity = '0';

  setTimeout(() => flyEl.remove(), 1100);
}

// ── Yaniv / Assaf announcement animation ──────────────────────────────────────
// Big text zooms out of the centre toward the viewer and fades over 1 s.
function animateYaniv(round) {
  const isAssaf = !!round.assaf;
  const el = document.createElement('div');
  el.className = 'yaniv-announce' + (isAssaf ? ' assaf' : '');
  el.textContent = isAssaf ? '😱 Assaf!' : '🎉 Yaniv!';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

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

// Coloured version for the turn log: red suits in red, black suits unstyled.
function cardShortHtml(c) {
  if (!c) return '?';
  const text = cardShort(c);
  return (c.suit === 'Hearts' || c.suit === 'Diamonds')
    ? `<span class="log-red">${text}</span>`
    : text;
}

// ── Turn log (last 3 plays with slide-in animation) ───────────────────────────
function renderTurnLog(lastTurn, lastRound) {
  // When a brand-new round starts, wipe the log so old turns don't linger.
  // Use a canonical key (not JSON.stringify) so JSONB key-reordering from
  // Postgres doesn't cause a false mismatch between SSE and poll responses.
  const roundKey = lastRound
    ? [lastRound.declarer, (lastRound.score_changes || []).map(s => s.name + ':' + s.new_score).sort().join(',')].join('|')
    : null;
  if (roundKey !== prevRoundKey) {
    if (roundKey && !prevRoundKey) {
      // New round just started — clear old turns from DOM
      $turnLog.innerHTML = '';
    }
    prevRoundKey = roundKey;
  }

  if (!lastTurn) return;

  // Build a canonical key from the fields that identify a turn in a fixed
  // order. JSON.stringify is key-order-sensitive, and the poll endpoint
  // returns JSONB from Postgres which may reorder keys vs the in-memory
  // dict delivered via SSE, causing a spurious mismatch and duplicate entry.
  const key = [
    lastTurn.player,
    (lastTurn.discarded || []).map(c => c.id).sort((a, b) => a - b).join(','),
    lastTurn.drawn_from,
    lastTurn.drawn_card ? lastTurn.drawn_card.id : '',
    roundKey,
  ].join('|');
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
  if (t.is_slamdown) {
    const card = t.discarded[0];
    return `💥 ${who} slammed down <strong>${cardShortHtml(card)}</strong>`;
  }
  const cards = t.discarded.map(cardShortHtml).join(' ');
  const drew  = t.drawn_from === 'pile'
    ? (t.drawn_card ? `<strong>${cardShortHtml(t.drawn_card)}</strong> from pile` : 'from pile')
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
