// API helpers, user actions, and event bindings.

async function fetchState() {
  try {
    const res = await fetch(`/api/room/${code}?pid=${encodeURIComponent(pid)}`);
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
  } catch (_) {
    showError('Network error');
  }
}

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
      // Fall through to execCommand fallback.
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

function selectDraw(val) {
  selectedDraw = val;
  renderDrawOptions(state.game.drawOptions, state.game.discardTop, state.game.isMyTurn);
  updatePlayBtn();
}

function toggleCard(id) {
  selectedCards = selectedCards.includes(id)
    ? selectedCards.filter((x) => x !== id)
    : [...selectedCards, id];

  $hand.querySelectorAll('.card').forEach((el) => {
    el.classList.toggle('selected', selectedCards.includes(parseInt(el.dataset.id, 10)));
  });

  const me = getSelfPlayer();
  if (me && me.hand) {
    $handValue.textContent = `(${me.hand.reduce((sum, c) => sum + c.value, 0)} pts)`;
  }
  updatePlayBtn();
}

function isValidDiscard(ids) {
  const me = getSelfPlayer();
  if (!me?.hand) return { valid: false };
  const cards = ids.map((id) => me.hand.find((c) => c.id === id)).filter(Boolean);
  return validateDiscard(cards);
}

function updatePlayBtn() {
  const g = state && state.game;
  if (!g || !g.isMyTurn || actionInFlight) {
    $playBtn.disabled = true;
    return;
  }
  if (!selectedCards.length) {
    $playBtn.disabled = true;
    clearError();
    return;
  }

  const { valid, reason } = isValidDiscard(selectedCards);
  $playBtn.disabled = !valid || selectedDraw === null;
  if (!valid && reason) showError(reason);
  else clearError();
}

async function submitAction(payload, { hideSlamdown = false } = {}) {
  if (isRoundResultModalOpen()) return null;
  if (actionInFlight) return null;
  actionInFlight = true;
  if (hideSlamdown) hide($slamdownBtn);

  const res = await post('/api/action', { code, pid, ...payload });
  if (res?.error) {
    // On error SSE update won't arrive, so fetch state to reset action lock.
    fetchState();
  } else {
    // Success: SSE will deliver state and onState() resets this as well.
    actionInFlight = false;
  }
  return res;
}

async function playTurn() {
  if (isRoundResultModalOpen()) return;
  if (actionInFlight) return;
  if (!state?.game?.isMyTurn) return;
  if (!selectedCards.length) {
    showError('Select cards to discard');
    return;
  }
  if (selectedDraw === null) {
    showError('Choose where to draw from');
    return;
  }
  updatePlayBtn();
  await submitAction({ discard: selectedCards, draw: selectedDraw });
}

function preventNonInputSelection(event) {
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
}

function bindEventHandlers() {
  if (isLikelyTouchDevice()) {
    $board.addEventListener('selectstart', preventNonInputSelection);
    $roundResultModal.addEventListener('selectstart', preventNonInputSelection);
  }

  $joinBtn.addEventListener('click', async () => {
    const name = $joinNameInput.value.trim() || 'Player';
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, code, name }),
    });
    const data = await res.json();
    if (data.error) {
      $joinError.textContent = data.error;
      return;
    }
    if (data.pid) localStorage.setItem('yanivPid', data.pid);
    fetchState();
  });

  $joinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $joinBtn.click();
  });

  $joinClaimBtn?.addEventListener('click', async () => {
    const playAsPid = $joinPlayerSelect?.value || '';
    if (!playAsPid) {
      $joinError.textContent = 'Select a player';
      return;
    }

    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid, code, playAsPid }),
    });
    const data = await res.json();
    if (data.error) {
      $joinError.textContent = data.error;
      return;
    }
    if (data.pid) {
      localStorage.setItem('yanivPid', data.pid);
      window.location.reload();
    }
  });
  $joinPlayerSelect?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $joinClaimBtn?.click();
  });

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
    const slamdownsAllowed = $slamdownsCheckbox ? $slamdownsCheckbox.checked : false;
    post('/api/start', { code, pid, slamdownsAllowed });
  });

  if ($slamdownsCheckbox) {
    $slamdownsCheckbox.addEventListener('change', async () => {
      if (!state || state.status !== 'waiting') return;

      const firstHuman = state.members.find((m) => !m.isAi);
      const hasAi = state.members.some((m) => m.isAi);
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
            slamdownsAllowed: $slamdownsCheckbox.checked,
          }),
        });
        const data = await res.json();
        if (data.error) {
          fetchState();
          return;
        }
        if (data.options) {
          $slamdownsCheckbox.checked = !!data.options.slamdownsAllowed;
        }
      } catch (_) {
        fetchState();
      }
    });
  }

  $playBtn.addEventListener('click', playTurn);
  $yanivBtn.addEventListener('click', async () => {
    await submitAction({ declareYaniv: true });
  });

  $slamdownBtn.addEventListener('click', async () => {
    await submitAction({ declareSlamdown: true }, { hideSlamdown: true });
  });

  $playAgainBtn.addEventListener('click', async () => {
    $playAgainBtn.disabled = true;
    $playAgainBtn.textContent = 'Starting…';
    try {
      const res = await fetch('/api/playAgain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, pid }),
      });
      const data = await res.json();
      if (data.nextRoom) {
        window.location.href = `/game/${data.nextRoom}`;
      } else {
        $playAgainBtn.disabled = false;
        $playAgainBtn.textContent = 'Play again';
      }
    } catch (_) {
      $playAgainBtn.disabled = false;
      $playAgainBtn.textContent = 'Play again';
    }
  });

  $roundResultContinue?.addEventListener('click', dismissRoundResultModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isRoundResultModalOpen()) {
      e.preventDefault();
      dismissRoundResultModal();
      return;
    }

    if (isRoundResultModalOpen()) return;

    const g = state?.game;
    if (!g) return;
    const me = getSelfPlayer();
    if (!me?.hand) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    // Number keys: pre-select cards even while waiting for your turn.
    const hand = sortHand(me.hand);
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= hand.length) {
      e.preventDefault();
      toggleCard(hand[n - 1].id);
      return;
    }

    // Draw / play / Yaniv shortcuts: only on your turn.
    if (!g.isMyTurn) return;
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      const opts = state.game.drawOptions;
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
      e.preventDefault();
      if (!$playBtn.disabled) playTurn();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      if (me.canYaniv && !actionInFlight) {
        submitAction({ declareYaniv: true });
      }
    }
  });
}
