#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const { createModel, saveModel, loadModel } = require('../network');
const { ReplayBuffer } = require('./replay_buffer');
const { generateSelfPlayBatch } = require('./self_play');
const { trainOnBatch } = require('./trainer');

const DEFAULT_CONFIG = {
  totalIterations: 200,
  gamesPerIteration: 100,
  evalGames: 50,
  evalInterval: 5,
  promotionThreshold: 0.55,
  numPlayers: 3,
  numDeterminizations: 8,
  iterationsPerDet: 50,
  explorationMoves: 15,
  batchSize: 256,
  epochsPerIteration: 10,
  learningRate: 0.001,
  replayBufferSize: 100000,
  checkpointDir: path.resolve(__dirname, '..', 'models'),
};

function evaluateModels(currentModel, bestModel, numGames, config) {
  const { AlphaZeroPlayer } = require('../alphazero_player');
  const { YanivGame } = require('../../yaniv');

  let currentWins = 0;
  let bestWins = 0;

  for (let g = 0; g < numGames; g += 1) {
    const p1 = new AlphaZeroPlayer('Current', currentModel, {
      numDeterminizations: config.numDeterminizations,
      iterationsPerDet: config.iterationsPerDet,
    });
    const p2 = new AlphaZeroPlayer('Best', bestModel, {
      numDeterminizations: config.numDeterminizations,
      iterationsPerDet: config.iterationsPerDet,
    });
    const { createAIPlayer } = require('../../aiplayer');
    const p3 = createAIPlayer('Heuristic');

    const players = g % 2 === 0 ? [p1, p2, p3] : [p2, p1, p3];
    const game = new YanivGame(players);
    game.startGame();

    let moves = 0;
    while (game.players.length > 1 && moves < 500) {
      const [currentPlayer, drawOptions] = game.startTurn();

      if (currentPlayer.hand.reduce((s, c) => s + c.value, 0) <= 5) {
        if (currentPlayer.should_declare_yaniv()) {
          const [, , winner] = game.declareYaniv(currentPlayer);
          if (winner) break;
          moves += 1;
          continue;
        }
      }

      const action = currentPlayer.decide_action();
      game.playTurn(currentPlayer, action);
      moves += 1;
    }

    const sorted = [...game.players].sort((a, b) => a.score - b.score);
    if (sorted.length > 0) {
      if (sorted[0].name === 'Current') currentWins += 1;
      else if (sorted[0].name === 'Best') bestWins += 1;
    }
  }

  return { currentWins, bestWins, total: numGames };
}

async function supervisedPretrain(model, numGames, config) {
  const { createAIPlayer } = require('../../aiplayer');
  const { YanivGame } = require('../../yaniv');
  const { encodeState, legalActionMask, discardToActionIndex, ACTION_SPACE_SIZE } = require('../state_encoder');

  console.log(`Supervised pre-training: generating ${numGames} heuristic games...`);
  const examples = [];

  for (let g = 0; g < numGames; g += 1) {
    const players = [];
    for (let i = 0; i < config.numPlayers; i += 1) {
      players.push(createAIPlayer(`H_${i}`));
    }

    const game = new YanivGame(players);
    game.startGame();

    let moves = 0;
    while (game.players.length > 1 && moves < 500) {
      const [currentPlayer, drawOptions] = game.startTurn();

      const handValue = currentPlayer.hand.reduce((s, c) => s + c.value, 0);
      if (handValue <= 5 && currentPlayer.should_declare_yaniv()) {
        game.declareYaniv(currentPlayer);
        moves += 1;
        continue;
      }

      const stateVector = encodeState(currentPlayer, drawOptions);
      const action = currentPlayer.decide_action();

      const policy = new Float32Array(ACTION_SPACE_SIZE);
      const actionIndex = discardToActionIndex(action.discard, action.draw);
      policy[actionIndex] = 1.0;

      examples.push({
        state: stateVector,
        policy,
        value: 0,
      });

      game.playTurn(currentPlayer, action);
      moves += 1;
    }

    if ((g + 1) % 100 === 0) {
      console.log(`  Generated ${g + 1}/${numGames} games (${examples.length} examples)`);
    }
  }

  console.log(`Training on ${examples.length} supervised examples...`);

  const shuffled = [...examples];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const losses = await trainOnBatch(model, shuffled, {
    batchSize: config.batchSize,
    epochs: 5,
    learningRate: config.learningRate,
  });

  console.log(`  Pre-training complete. Loss: ${losses.totalLoss.toFixed(4)} (policy: ${losses.policyLoss.toFixed(4)}, value: ${losses.valueLoss.toFixed(4)})`);
  return losses;
}

async function runTraining(userConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };

  if (!fs.existsSync(config.checkpointDir)) {
    fs.mkdirSync(config.checkpointDir, { recursive: true });
  }

  console.log('AlphaZero Training Pipeline');
  console.log('==========================');
  console.log(`Config: ${JSON.stringify(config, null, 2)}`);
  console.log();

  let model;
  const resumePath = path.join(config.checkpointDir, 'current');
  if (fs.existsSync(path.join(resumePath, 'model.json'))) {
    console.log('Resuming from checkpoint...');
    model = await loadModel(resumePath);
  } else {
    console.log('Creating new model...');
    model = createModel();

    await supervisedPretrain(model, config.pretrainGames || 1000, config);
    await saveModel(model, resumePath);
    console.log('Saved pre-trained model.');
  }

  const bestModelPath = path.join(config.checkpointDir, 'best');
  if (!fs.existsSync(path.join(bestModelPath, 'model.json'))) {
    await saveModel(model, bestModelPath);
  }

  const replayBuffer = new ReplayBuffer(config.replayBufferSize);
  const bufferPath = path.join(config.checkpointDir, 'replay_buffer.json');
  if (fs.existsSync(bufferPath)) {
    try {
      const loaded = ReplayBuffer.load(bufferPath);
      replayBuffer.buffer = loaded.buffer;
      replayBuffer.position = loaded.position;
      replayBuffer.totalAdded = loaded.totalAdded;
      console.log(`Loaded replay buffer: ${replayBuffer.size} examples`);
    } catch {
      console.log('Could not load replay buffer, starting fresh.');
    }
  }

  const startIteration = config.startIteration || 1;
  for (let iter = startIteration; iter <= config.totalIterations; iter += 1) {
    const iterStart = performance.now();
    console.log(`\n--- Iteration ${iter}/${config.totalIterations} ---`);

    console.log(`Generating ${config.gamesPerIteration} self-play games...`);
    const spStart = performance.now();
    const { examples, results } = generateSelfPlayBatch(model, config.gamesPerIteration, {
      numPlayers: config.numPlayers,
      numDeterminizations: config.numDeterminizations,
      iterationsPerDet: config.iterationsPerDet,
      explorationMoves: config.explorationMoves,
      baseSeed: iter * 31337,
    });
    const spTime = ((performance.now() - spStart) / 1000).toFixed(1);

    const winners = {};
    for (const r of results) {
      winners[r.winner] = (winners[r.winner] || 0) + 1;
    }
    console.log(`  Self-play: ${examples.length} examples, ${spTime}s. Winners: ${JSON.stringify(winners)}`);

    replayBuffer.addBatch(examples);
    console.log(`  Replay buffer: ${replayBuffer.size} examples`);

    if (replayBuffer.size >= config.batchSize) {
      console.log('Training...');
      const trainStart = performance.now();
      const sampled = replayBuffer.sample(Math.min(replayBuffer.size, config.batchSize * config.epochsPerIteration));

      const lr = iter > config.totalIterations / 2 ? config.learningRate / 10 : config.learningRate;
      const losses = await trainOnBatch(model, sampled, {
        batchSize: config.batchSize,
        epochs: config.epochsPerIteration,
        learningRate: lr,
      });
      const trainTime = ((performance.now() - trainStart) / 1000).toFixed(1);
      console.log(`  Training: ${trainTime}s. Loss: ${losses.totalLoss.toFixed(4)} (policy: ${losses.policyLoss.toFixed(4)}, value: ${losses.valueLoss.toFixed(4)})`);
    }

    await saveModel(model, resumePath);

    if (iter % config.evalInterval === 0) {
      console.log(`Evaluating vs best model (${config.evalGames} games)...`);
      const bestModel = await loadModel(bestModelPath);
      const evalResult = evaluateModels(model, bestModel, config.evalGames, config);
      const winRate = evalResult.currentWins / evalResult.total;
      console.log(`  Eval: Current ${evalResult.currentWins}W, Best ${evalResult.bestWins}W, WR=${(winRate * 100).toFixed(1)}%`);

      if (winRate >= config.promotionThreshold) {
        console.log('  New best model! Promoting...');
        await saveModel(model, bestModelPath);
      }

      bestModel.dispose();
    }

    if (iter % 10 === 0) {
      replayBuffer.save(bufferPath);
    }

    const iterTime = ((performance.now() - iterStart) / 1000).toFixed(1);
    console.log(`  Iteration time: ${iterTime}s`);
  }

  console.log('\nTraining complete!');
  await saveModel(model, path.join(config.checkpointDir, 'final'));
  replayBuffer.save(bufferPath);
  console.log('Saved final model and replay buffer.');
}

if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    const val = process.argv[i + 1];
    args[key] = Number.isFinite(Number(val)) ? Number(val) : val;
  }

  runTraining(args).catch((err) => {
    console.error('Training failed:', err);
    process.exit(1);
  });
}

module.exports = { runTraining, supervisedPretrain };
