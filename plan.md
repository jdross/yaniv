# UX Improvement Plan

## Branch
`claude/redesign-player-display-6T5U3`

---

## Change 1: Deck/Pile section floats in the middle on mobile

**Current**: The `.draw-section` is a normal flex item inside the board column, sitting between the turn log and the hand panel.

**Goal**: On mobile (`max-width: 600px`), the draw section should be `position: fixed`, centered horizontally and vertically on the screen, so it floats like a table playing area.

### CSS changes in `style.css`
Inside `@media (max-width: 600px)`:
- Add `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 50;` to `.draw-section`
- Give it a dark backdrop: `background: rgba(8, 40, 25, 0.95); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.18); border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.5);`
- Set `width: auto; max-width: calc(100vw - 2rem);`
- Since it's now out of flow, the `.turn-log` should be allowed to grow: remove `min-height`/`max-height` constraints on mobile and allow `flex: 1; overflow-y: auto;` so it fills the gap between opponents and the hand panel naturally

---

## Change 2: Opponent player display → fanned hand representation

**Current**: `#score-bar` shows all players (including self) as horizontal rounded rectangles with name, score, card count.

**Goal**:
- Show only **other** players (not self) in the top section
- Each opponent is rendered as a **fanned card-back** spread showing their hand count visually
- Name, score, and card count are **horizontally centered** above/below the fan graphic
- Self is **removed** from the top bar entirely

### HTML changes in `game.html`
- Change `class="score-bar"` to `class="opponents-bar"` on `#score-bar` (keep `id="score-bar"`)
- Remove the `#turn-status` div entirely (its role is replaced by the play button text)

### JS changes in `render.js`

**`showBoard` function**:
- Filter `g.players` to exclude self before rendering the opponents bar
- Change the innerHTML template to render the new opponent player structure (fan + info)
- Remove the `$turnStatus` show/hide block entirely

**New `fanHtml(cardCount)` helper**:
```
function fanHtml(cardCount) {
  if (cardCount === 0) return '<div class="player-fan"></div>';
  const max = Math.min(35, cardCount * 7);
  const cards = Array.from({ length: Math.min(cardCount, 10) }, (_, i) => {
    const n = Math.min(cardCount, 10);
    const angle = n === 1 ? 0 : -max + (i * 2 * max / (n - 1));
    return `<div class="fan-card" style="transform:rotate(${angle.toFixed(1)}deg)"></div>`;
  }).join('');
  return `<div class="player-fan">${cards}</div>`;
}
```

**New opponent player HTML template**:
```html
<div class="opponent-player ${current} ${isCurrent?'current':''}">
  <div class="opp-info">
    <div class="opp-name">${name}</div>
    <div class="opp-score">${score}</div>
    <div class="opp-cards">${count} card(s)</div>
  </div>
  ${fanHtml(hand_count)}
</div>
```
Info is above, fan is below (or info centered above fan).

### CSS changes in `style.css`
Replace `.score-bar` / `.score-player` styles with new `.opponents-bar` / `.opponent-player` styles:

```css
.opponents-bar {
  display: flex;
  gap: .5rem;
  justify-content: center;
  flex-wrap: wrap;
  padding: .3rem .4rem;
}

.opponent-player {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: .3rem;
  min-width: 65px;
}

.opp-info {
  text-align: center;
  line-height: 1.25;
}

.opp-name {
  font-size: .75rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
}

.opp-score {
  font-size: .88rem;
  font-weight: 800;
  color: #f4d03f;
}

.opp-cards {
  font-size: .65rem;
  opacity: .6;
}

.player-fan {
  position: relative;
  width: 60px;
  height: 52px;
}

.fan-card {
  position: absolute;
  width: 32px;
  height: 46px;
  background: linear-gradient(135deg, #1a3a6e, #0d2240);
  border-radius: 4px;
  box-shadow: 0 1px 5px rgba(0,0,0,.45);
  transform-origin: bottom center;
  bottom: 0;
  left: 50%;
  margin-left: -16px;
}

/* Current player fan — gold highlight */
.opponent-player.current .fan-card {
  border: 1px solid rgba(244,208,63,.6);
  box-shadow: 0 1px 5px rgba(0,0,0,.45), 0 0 8px rgba(244,208,63,.35);
}
```

---

## Change 3: Self score shown at bottom right of hand panel

**Current**: `$handValue` shows "(X pts)" inline after the "Your hand" label.

**Goal**: Right-aligned in the hand panel header — show hand pts and game score as "X/100".

### HTML changes in `game.html`
Wrap the hand panel header in a flex row:
```html
<div class="hand-panel-top">
  <div class="section-label your-hand-label">Your hand</div>
  <div class="my-score-info">
    <span id="hand-value" class="hand-value"></span>
    <span id="my-game-score" class="my-game-score"></span>
  </div>
</div>
```

### JS changes in `render.js` and `core.js`
- In `render.js > showBoard`: populate `$myGameScore.textContent` with `${me.score}/100`
- In `core.js`: add `const $myGameScore = document.getElementById('my-game-score');`
- Also update the `toggleCard` handler in `actions.js` to update only `$handValue` (hand pts), `$myGameScore` stays unchanged until next render

### CSS changes in `style.css`
```css
.hand-panel-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: .22rem;
}

.my-score-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: .05rem;
}

.hand-value {
  font-size: .8rem;
  opacity: .7;
}

.my-game-score {
  font-size: .8rem;
  font-weight: 700;
  color: #f4d03f;
}
```

---

## Change 4: Play button shows whose turn it is

**Current**:
- `#turn-status` shows "Your turn. Select cards to discard and where to draw." when it's your turn
- `#play-btn` always says "Play turn"

**Goal**:
- Remove the `turn-status` element and its show/hide logic
- When not your turn: button text = `"${currentPlayerName}'s turn"` (button stays disabled)
- When your turn: button text = `"Play turn"` (existing behavior)

### JS changes in `actions.js`

In `updatePlayBtn()`:
```javascript
function updatePlayBtn() {
  const g = state && state.game;
  if (!g) { $playBtn.disabled = true; $playBtn.textContent = 'Play turn'; return; }

  if (!g.is_my_turn || actionInFlight) {
    if (!g.is_my_turn) {
      const cur = g.players.find(p => p.is_current);
      $playBtn.textContent = cur ? `${cur.name}'s turn` : 'Waiting…';
    }
    $playBtn.disabled = true;
    return;
  }

  $playBtn.textContent = 'Play turn';
  if (!selectedCards.length) { $playBtn.disabled = true; clearError(); return; }

  const { valid, reason } = isValidDiscard(selectedCards);
  $playBtn.disabled = !valid || selectedDraw === null;
  if (!valid && reason) showError(reason);
  else clearError();
}
```

Also remove the `$turnStatus` DOM ref from `core.js` and the `UI_TEXT.turnPrompt` key (or just leave them unused — prefer removing to avoid confusion).

---

## Files modified

| File | Changes |
|------|---------|
| `static/game.html` | Rename score-bar class to opponents-bar; remove `#turn-status`; wrap hand panel header in `.hand-panel-top`; add `#my-game-score` |
| `static/js/game/core.js` | Remove `$turnStatus` ref; add `$myGameScore` ref; remove `UI_TEXT.turnPrompt` |
| `static/js/game/render.js` | Filter self out of opponents bar; use fanned card HTML; add `fanHtml()`; populate `$myGameScore`; remove turn-status logic |
| `static/js/game/actions.js` | Update `updatePlayBtn()` to set button text to current player name |
| `static/css/style.css` | Replace score-bar styles; add fan card styles; add hand-panel-top / my-score-info styles; add mobile fixed positioning for draw-section; adjust mobile turn-log |
