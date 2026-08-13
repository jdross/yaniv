const { YanivGame } = require('../../yaniv');
const { AlphaZeroPlayer } = require('../alphazero_player');
const { encodeState, legalActionMask, ACTION_SPACE_SIZE } = require('../state_encoder');
const { runDeterminizedMCTS, visitsToPolicy, selectActionFromVisits, mulberry32 } = require('../mcts');

function generateSelfPlayGame(model, options = {}) {
  const {
    numPlayers = 3,
    numDeterminizations = 8,
    iterationsPerDet = 50,
    explorationMoves = 15,
    gameSeed = Date.now(),
  } = options;

  const rng = mulberry32(gameSeed);

  const players = [];
  for (let i = 0; i < numPlayers; i += 1) {
    const player = new AlphaZeroPlayer(`AZ_${i}`, model, {
      numDeterminizations,
      iterationsPerDet,
    });
    players.push(player);
  }

  const gameRng = {
    random: rng,
    randint(min, max) { return min + Math.floor(rng() * (max - min + 1)); },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    },
  };

  const game = new YanivGame(players, gameRng);
  game.startGame();

  const trainingExamples = [];
  const playerMoveHistory = {};
  for (const p of players) {
    playerMoveHistory[p.name] = [];
  }

  let moveCount = 0;
  const maxMoves = 500;

  while (game.players.length > 1 && moveCount < maxMoves) {
    const [currentPlayer, drawOptions] = game.startTurn();

    if (!(currentPlayer instanceof AlphaZeroPlayer)) {
      break;
    }

    const handValue = currentPlayer.hand.reduce((s, c) => s + c.value, 0);

    if (handValue <= 5 && currentPlayer.should_declare_yaniv()) {
      const [, , winner] = game.declareYaniv(currentPlayer);
      if (winner) break;
      moveCount += 1;
      continue;
    }

    const discardOptions = currentPlayer._get_discard_options_cached(currentPlayer.hand);
    const canYaniv = handValue <= 5;
    const mask = legalActionMask(currentPlayer.hand, drawOptions, discardOptions, canYaniv);
    const stateVector = encodeState(currentPlayer, drawOptions);

    const seed = currentPlayer._state_seed();
    const { visits } = runDeterminizedMCTS(
      model,
      currentPlayer,
      drawOptions,
      {
        numDeterminizations,
        iterationsPerDet,
        addNoise: true,
        baseSeed: seed,
      },
    );

    const temperature = moveCount < explorationMoves ? 1.0 : 0.1;
    const policy = visitsToPolicy(visits, temperature);

    playerMoveHistory[currentPlayer.name].push({
      state: new Float32Array(stateVector),
      policy: new Float32Array(policy),
      playerName: currentPlayer.name,
    });

    const actionIndex = selectActionFromVisits(visits, temperature);
    if (actionIndex < 0) {
      const action = currentPlayer.decide_action();
      game.playTurn(currentPlayer, action);
    } else {
      const decoded = require('../state_encoder').decodeAction(
        actionIndex, currentPlayer.hand, drawOptions, discardOptions,
      );
      if (decoded && !decoded.declareYaniv) {
        game.playTurn(currentPlayer, decoded);
      } else {
        const action = currentPlayer.decide_action();
        game.playTurn(currentPlayer, action);
      }
    }

    moveCount += 1;
  }

  const finalScores = {};
  for (const p of players) {
    finalScores[p.name] = p.score;
  }

  const sortedPlayers = [...players].sort((a, b) => a.score - b.score);
  const valueTargets = {};
  for (let i = 0; i < sortedPlayers.length; i += 1) {
    const p = sortedPlayers[i];
    if (i === 0) {
      valueTargets[p.name] = 1.0;
    } else if (i === sortedPlayers.length - 1) {
      valueTargets[p.name] = -1.0;
    } else {
      valueTargets[p.name] = -0.5;
    }
  }

  for (const p of players) {
    const examples = playerMoveHistory[p.name];
    const value = valueTargets[p.name];
    for (const example of examples) {
      trainingExamples.push({
        state: example.state,
        policy: example.policy,
        value,
      });
    }
  }

  return {
    examples: trainingExamples,
    finalScores,
    moveCount,
    winner: sortedPlayers[0].name,
  };
}

function generateSelfPlayBatch(model, numGames, options = {}) {
  const allExamples = [];
  const results = [];

  for (let g = 0; g < numGames; g += 1) {
    const gameOptions = {
      ...options,
      gameSeed: (options.baseSeed || Date.now()) + g * 7919,
    };

    const result = generateSelfPlayGame(model, gameOptions);
    allExamples.push(...result.examples);
    results.push({
      winner: result.winner,
      moveCount: result.moveCount,
      finalScores: result.finalScores,
    });
  }

  return { examples: allExamples, results };
}

module.exports = { generateSelfPlayGame, generateSelfPlayBatch };
