// Shared state, DOM refs, and utility helpers for the game client.
const code = location.pathname.split('/').pop().toLowerCase();
const pid  = getYanivPid();
const { sortHand, suitSymbol, cardColor, validateDiscard } = window.YanivGameLogic;

const UI_TEXT = {
  turnPrompt: 'Your turn. Select cards to discard and where to draw.',
  waitingHand: '<span style="opacity:.5;font-size:.85rem">Waiting for your hand…</span>',
};

const DRAW_ANIMATION = {
  durationMs: 950,
  moveEase: 'cubic-bezier(0.22, 0, 0.86, 1)',
  fadeEase: 'cubic-bezier(0.55, 0, 1, 1)',
};

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
// produces different strings depending on its source. Every dedup key
// below must therefore be built by extracting named fields in a fixed,
// explicit order — never by stringifying the whole object.
let prevTurnKey     = null; // fingerprint of the last rendered turn
let prevRoundKey    = null; // fingerprint of the last rendered round banner
let prevAnimTurnKey = null; // lastTurn key we've already animated
let prevYanivKey    = null; // lastRound key we've already announced
let prevHandKey     = null; // hand fingerprint we've already highlighted
let activeRoundModalKey = null;
let dismissedRoundModalKey = null;

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
const $roundResultModal = document.getElementById('round-result-modal');
const $roundResultContent = document.getElementById('round-result-content');
const $roundResultClose = document.getElementById('round-result-close');
const $roundResultContinue = document.getElementById('round-result-continue');

const SCREEN_ELEMENTS = [$joinScreen, $lobby, $board, $gameover];

function getSelfPlayer(st = state) {
  return st?.game?.players?.find(p => p.isSelf) ?? null;
}

function getSelfHand(st = state) {
  return getSelfPlayer(st)?.hand ?? null;
}

function handKey(st) {
  const hand = getSelfHand(st);
  return hand ? hand.map(c => c.id).sort((a, b) => a - b).join(',') : null;
}

function roundResultKey(round) {
  if (!round) return null;
  return [
    round.declarer,
    (round.scoreChanges || []).map(sc => `${sc.name}:${sc.newScore}`).sort().join(','),
  ].join('|');
}

function showScreen(activeScreen) {
  SCREEN_ELEMENTS.forEach(el => {
    if (el === activeScreen) show(el);
    else hide(el);
  });
}

function isRoundResultModalOpen() {
  return !$roundResultModal.classList.contains('hidden');
}

function showRoundResultModal(round, currentState) {
  if (!round) return;
  $roundResultContent.innerHTML = formatRoundResultModal(round, currentState);
  show($roundResultModal);
  $roundResultModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('round-modal-open');
}

function hideRoundResultModal() {
  hide($roundResultModal);
  $roundResultModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('round-modal-open');
}

function dismissRoundResultModal() {
  if (activeRoundModalKey) dismissedRoundModalKey = activeRoundModalKey;
  hideRoundResultModal();
}

function resetRoundResultState() {
  hideRoundResultModal();
  activeRoundModalKey = null;
  dismissedRoundModalKey = null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function showError(msg) { $gameError.textContent = msg; }
function clearError()   { $gameError.textContent = ''; }
