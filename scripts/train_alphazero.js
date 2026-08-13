#!/usr/bin/env node
const { runTraining } = require('../server/src/alphazero/training/run_training');

const config = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  const val = process.argv[i + 1];
  if (val !== undefined) {
    config[key] = Number.isFinite(Number(val)) ? Number(val) : val;
  }
}

console.log('AlphaZero Yaniv Training');
console.log('========================');
console.log();
console.log('Usage: node scripts/train_alphazero.js [--key value ...]');
console.log();
console.log('Options:');
console.log('  --totalIterations N     Training iterations (default: 200)');
console.log('  --gamesPerIteration N   Self-play games per iteration (default: 100)');
console.log('  --pretrainGames N       Supervised pre-training games (default: 1000)');
console.log('  --numDeterminizations N MCTS determinizations (default: 8)');
console.log('  --iterationsPerDet N    MCTS iterations per determinization (default: 50)');
console.log('  --evalGames N           Evaluation games (default: 50)');
console.log('  --evalInterval N        Evaluate every N iterations (default: 5)');
console.log();

runTraining(config).catch((err) => {
  console.error('Training failed:', err);
  process.exit(1);
});
