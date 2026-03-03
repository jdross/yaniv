(function initHowToGuide() {
  const logic = window.YanivGameLogic;
  if (!logic) {
    return;
  }

  const cards = [
    { id: 1, rank: '7', suit: 'Hearts' },
    { id: 2, rank: '7', suit: 'Clubs' },
    { id: 3, rank: 'Joker', suit: null },
    { id: 4, rank: '4', suit: 'Hearts' },
    { id: 5, rank: '5', suit: 'Hearts' },
    { id: 6, rank: '6', suit: 'Hearts' },
    { id: 7, rank: '5', suit: 'Spades' },
    { id: 8, rank: '9', suit: 'Diamonds' },
  ];

  const suitSymbol = {
    Clubs: '♣',
    Diamonds: '♦',
    Hearts: '♥',
    Spades: '♠',
  };

  const selected = new Set();
  const byId = new Map(cards.map((card) => [card.id, card]));

  const discardChecker = document.getElementById('discard-checker');
  const discardResult = document.getElementById('discard-result');

  function setResult(element, tone, text) {
    if (!element) {
      return;
    }

    element.classList.remove('neutral', 'good', 'bad');
    element.classList.add(tone);
    element.textContent = text;
  }

  function classifyValidDiscard(selectedCards) {
    if (selectedCards.length === 1) {
      return 'single';
    }

    const nonJokers = selectedCards.filter((card) => card.rank !== 'Joker');
    if (nonJokers.length === 0 || new Set(nonJokers.map((card) => card.rank)).size === 1) {
      return 'set';
    }

    return 'run';
  }

  function updateDiscardResult() {
    if (!discardChecker || !discardResult) {
      return;
    }

    const selectedCards = [...selected].map((id) => byId.get(id)).filter(Boolean);
    discardChecker.querySelectorAll('.select-card').forEach((node) => {
      const id = Number.parseInt(node.dataset.id || '-1', 10);
      node.classList.toggle('selected', selected.has(id));
    });

    if (selectedCards.length === 0) {
      setResult(discardResult, 'neutral', 'Pick card(s) to test.');
      return;
    }

    const result = logic.validateDiscard(selectedCards);
    if (!result.valid) {
      const reason = result.reason || 'Invalid discard.';
      setResult(discardResult, 'bad', `Nope: ${reason}`);
      return;
    }

    const type = classifyValidDiscard(selectedCards);
    setResult(discardResult, 'good', `Yes. Valid ${type}.`);
  }

  function createCardButton(card) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-card';
    button.dataset.id = String(card.id);

    const label = card.rank === 'Joker'
      ? 'Joker'
      : `${card.rank}${suitSymbol[card.suit] || ''}`;
    button.textContent = label;

    if (card.suit === 'Hearts' || card.suit === 'Diamonds') {
      button.classList.add('red');
    }

    button.addEventListener('click', () => {
      if (selected.has(card.id)) {
        selected.delete(card.id);
      } else {
        selected.add(card.id);
      }
      updateDiscardResult();
    });

    return button;
  }

  if (discardChecker) {
    cards.forEach((card) => discardChecker.appendChild(createCardButton(card)));
    updateDiscardResult();
  }

  const myTotal = document.getElementById('my-total');
  const opponentTotal = document.getElementById('opponent-total');
  const yanivResult = document.getElementById('yaniv-result');

  function clampInt(value, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return min;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  function updateYanivResult() {
    if (!myTotal || !opponentTotal || !yanivResult) {
      return;
    }

    const my = clampInt(myTotal.value, 0, 30);
    const opp = clampInt(opponentTotal.value, 0, 30);
    myTotal.value = String(my);
    opponentTotal.value = String(opp);

    if (my > 5) {
      setResult(yanivResult, 'bad', `You cannot call Yaniv at ${my}. You must be 5 or less.`);
      return;
    }

    if (opp <= my) {
      setResult(yanivResult, 'bad', `Assaf: another player has ${opp} (same or lower), so you get +30.`);
      return;
    }

    setResult(yanivResult, 'good', `Safe Yaniv: your ${my} is lower than everyone else.`);
  }

  if (myTotal) {
    myTotal.addEventListener('input', updateYanivResult);
  }
  if (opponentTotal) {
    opponentTotal.addEventListener('input', updateYanivResult);
  }
  updateYanivResult();

  const currentScore = document.getElementById('current-score');
  const roundPoints = document.getElementById('round-points');
  const scoreResult = document.getElementById('score-result');

  function updateScoreResult() {
    if (!currentScore || !roundPoints || !scoreResult) {
      return;
    }

    const current = clampInt(currentScore.value, 0, 150);
    const gained = clampInt(roundPoints.value, 0, 80);
    currentScore.value = String(current);
    roundPoints.value = String(gained);

    const subtotal = current + gained;
    const resetApplies = subtotal === 50 || subtotal === 100;
    const finalScore = resetApplies ? subtotal - 50 : subtotal;

    if (finalScore > 100) {
      setResult(scoreResult, 'bad', `${current} + ${gained} = ${finalScore}. Over 100 means you are out.`);
      return;
    }

    if (resetApplies) {
      setResult(scoreResult, 'good', `${current} + ${gained} = ${subtotal}. Reset! New score is ${finalScore}.`);
      return;
    }

    setResult(scoreResult, 'neutral', `${current} + ${gained} = ${finalScore}.`);
  }

  if (currentScore) {
    currentScore.addEventListener('input', updateScoreResult);
  }
  if (roundPoints) {
    roundPoints.addEventListener('input', updateScoreResult);
  }
  updateScoreResult();
})();
