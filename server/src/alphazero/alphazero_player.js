const { AIPlayer: BaseAIPlayer } = require('../aiplayer_base');
const { encodeState, decodeAction, YANIV_ACTION_INDEX } = require('./state_encoder');
const { predict, maskedSoftmax } = require('./network');
const { runDeterminizedMCTS, selectActionFromVisits } = require('./mcts');

class AlphaZeroPlayer extends BaseAIPlayer {
  constructor(name, model, options = {}) {
    super(name, options.rolloutSamples || 24);
    this.policy_id = 'alphazero';
    this.model = model;
    this.numDeterminizations = options.numDeterminizations || 8;
    this.iterationsPerDet = options.iterationsPerDet || 50;
    this.temperature = options.temperature || 0;
    this._move_count = 0;
  }

  observe_round(roundInfo) {
    super.observe_round(roundInfo);
    this._move_count = 0;
  }

  decide_action() {
    if (!this.model) {
      return super.decide_action();
    }

    const drawOptions = [...this.draw_options];
    const seed = this._state_seed();

    const { visits, discardOptions } = runDeterminizedMCTS(
      this.model,
      this,
      drawOptions,
      {
        numDeterminizations: this.numDeterminizations,
        iterationsPerDet: this.iterationsPerDet,
        addNoise: false,
        baseSeed: seed,
      },
    );

    const temperature = this.temperature;
    const actionIndex = selectActionFromVisits(visits, temperature);

    if (actionIndex < 0) {
      return super.decide_action();
    }

    if (actionIndex === YANIV_ACTION_INDEX) {
      return super.decide_action();
    }

    const decoded = decodeAction(actionIndex, this.hand, drawOptions, discardOptions);
    if (!decoded || decoded.declareYaniv) {
      return super.decide_action();
    }

    this._move_count += 1;
    return decoded;
  }

  should_declare_yaniv() {
    const handValue = this.hand.reduce((sum, card) => sum + card.value, 0);
    if (handValue > 5) return false;

    if (!this.model) {
      return super.should_declare_yaniv();
    }

    const drawOptions = [...this.draw_options];
    const stateVector = encodeState(this, drawOptions);
    const discardOptions = this._get_discard_options_cached(this.hand);
    const canYaniv = true;

    const { policyLogits } = predict(this.model, stateVector);
    const { legalActionMask } = require('./state_encoder');
    const mask = legalActionMask(this.hand, drawOptions, discardOptions, canYaniv);
    const probs = maskedSoftmax(policyLogits, mask);

    const yanivProb = probs[YANIV_ACTION_INDEX] || 0;

    let totalPlayProb = 0;
    for (let i = 0; i < probs.length - 1; i += 1) {
      totalPlayProb += probs[i];
    }

    if (totalPlayProb + yanivProb <= 0) {
      return super.should_declare_yaniv();
    }

    return yanivProb > totalPlayProb * 0.3;
  }
}

module.exports = { AlphaZeroPlayer };
