const { AIPlayerV3 } = require('./aiplayer_v3');
const { AIPlayerLearned } = require('./aiplayer_learned');

const AI_DIFFICULTY = Object.freeze({
  EASY: 'easy',
  HARD: 'hard',
});

function normalizeAiDifficulty(rawAiDifficulty) {
  return rawAiDifficulty === AI_DIFFICULTY.EASY ? AI_DIFFICULTY.EASY : AI_DIFFICULTY.HARD;
}

function createAIPlayer(name, options = null) {
  const resolvedOptions = options && typeof options === 'object' ? options : {};
  const aiDifficulty = normalizeAiDifficulty(
    typeof options === 'string' ? options : resolvedOptions.aiDifficulty,
  );

  const player = aiDifficulty === AI_DIFFICULTY.EASY
    ? new AIPlayerV3(name, resolvedOptions.rolloutSamples)
    : new AIPlayerLearned(name, resolvedOptions.rolloutSamples, resolvedOptions.learnedOptions);

  player.aiDifficulty = aiDifficulty;
  player.policy_id = aiDifficulty === AI_DIFFICULTY.EASY ? 'v3' : 'learned';
  return player;
}

module.exports = {
  AIPlayer: AIPlayerLearned,
  AI_DIFFICULTY,
  normalizeAiDifficulty,
  createAIPlayer,
};
