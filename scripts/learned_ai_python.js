#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function timestampTag() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

function defaultOutputRoot() {
  return path.resolve(process.cwd(), 'metrics', 'learned-ai');
}

function runtimeManifestPath() {
  return path.resolve(__dirname, '..', 'server', 'learned_ai', 'current_champion.json');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseArgs(argv) {
  const out = {
    command: argv[0] || 'run',
    games: 64,
    eval_games_2p: 32,
    eval_games_3p: 32,
    max_turns: 500,
    rollout_samples: 24,
    output_root: defaultOutputRoot(),
    manifest_path: runtimeManifestPath(),
    replay_path: '',
    mode: '',
    seed: 42,
    learning_rate: 0.0015,
    epochs: 10,
    policy_hidden_size: 64,
    value_hidden_size: 48,
    yaniv_hidden_size: 32,
    keep_replay: false,
    rollout_target_candidates: 2,
    rollout_target_samples: 1,
    rollout_target_turns: 6,
    rollout_target_weight: 0.55,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const value = argv[i + 1];
    if (token === '--games') out.games = Number.parseInt(value, 10);
    if (token === '--eval-games-2p') out.eval_games_2p = Number.parseInt(value, 10);
    if (token === '--eval-games-3p') out.eval_games_3p = Number.parseInt(value, 10);
    if (token === '--max-turns') out.max_turns = Number.parseInt(value, 10);
    if (token === '--rollout-samples') out.rollout_samples = Number.parseInt(value, 10);
    if (token === '--output-root') out.output_root = path.resolve(process.cwd(), value);
    if (token === '--manifest-path') out.manifest_path = path.resolve(process.cwd(), value);
    if (token === '--replay-path') out.replay_path = path.resolve(process.cwd(), value);
    if (token === '--mode') out.mode = String(value || '');
    if (token === '--seed') out.seed = Number.parseInt(value, 10);
    if (token === '--learning-rate') out.learning_rate = Number(value);
    if (token === '--epochs') out.epochs = Number.parseInt(value, 10);
    if (token === '--policy-hidden-size') out.policy_hidden_size = Number.parseInt(value, 10);
    if (token === '--value-hidden-size') out.value_hidden_size = Number.parseInt(value, 10);
    if (token === '--yaniv-hidden-size') out.yaniv_hidden_size = Number.parseInt(value, 10);
    if (token === '--keep-replay') {
      out.keep_replay = true;
      continue;
    }
    if (token === '--rollout-target-candidates') out.rollout_target_candidates = Number.parseInt(value, 10);
    if (token === '--rollout-target-samples') out.rollout_target_samples = Number.parseInt(value, 10);
    if (token === '--rollout-target-turns') out.rollout_target_turns = Number.parseInt(value, 10);
    if (token === '--rollout-target-weight') out.rollout_target_weight = Number(value);
    if (token.startsWith('--')) i += 1;
  }

  return out;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function resolvePythonExecutable() {
  if (process.env.YANIV_ML_PYTHON) {
    return process.env.YANIV_ML_PYTHON;
  }
  const venvPython = path.resolve(process.cwd(), '.venv-ml', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

function maybeDeleteReplay(replayPath, shouldDelete) {
  if (!shouldDelete || !replayPath) {
    return;
  }
  if (fs.existsSync(replayPath)) {
    fs.unlinkSync(replayPath);
  }
}

function runGenerate(config, replayPath) {
  const scriptPath = path.resolve(__dirname, 'learned_ai.js');
  const args = [
    scriptPath,
    'generate',
    '--games', String(config.games),
    '--eval-games-2p', String(config.eval_games_2p),
    '--eval-games-3p', String(config.eval_games_3p),
    '--max-turns', String(config.max_turns),
    '--rollout-samples', String(config.rollout_samples),
    '--output-root', config.output_root,
    '--manifest-path', config.manifest_path,
    '--replay-path', replayPath,
    '--seed', String(config.seed),
    '--rollout-target-candidates', String(config.rollout_target_candidates),
    '--rollout-target-samples', String(config.rollout_target_samples),
    '--rollout-target-turns', String(config.rollout_target_turns),
    '--rollout-target-weight', String(config.rollout_target_weight),
  ];
  if (config.mode) {
    args.push('--mode', config.mode);
  }
  runChecked(process.execPath, args);
}

function runPythonTrain(config, replayPath) {
  const python = resolvePythonExecutable();
  const trainerPath = path.resolve(__dirname, 'learned_ai_torch.py');
  const stdout = runChecked(python, [
    trainerPath,
    '--replay-path', replayPath,
    '--manifest-path', config.manifest_path,
    '--output-root', config.output_root,
    '--learning-rate', String(config.learning_rate),
    '--epochs', String(config.epochs),
    '--policy-hidden-size', String(config.policy_hidden_size),
    '--value-hidden-size', String(config.value_hidden_size),
    '--yaniv-hidden-size', String(config.yaniv_hidden_size),
  ]);
  const lines = stdout.split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function runEvaluate(config, candidateManifestPath) {
  const scriptPath = path.resolve(__dirname, 'learned_ai.js');
  runChecked(process.execPath, [
    scriptPath,
    'evaluate',
    '--candidate-manifest-path', candidateManifestPath,
    '--eval-games-2p', String(config.eval_games_2p),
    '--eval-games-3p', String(config.eval_games_3p),
    '--max-turns', String(config.max_turns),
    '--rollout-samples', String(config.rollout_samples),
    '--output-root', config.output_root,
    '--manifest-path', config.manifest_path,
    '--seed', String(config.seed),
  ]);
}

function runPlot(config) {
  const scriptPath = path.resolve(__dirname, 'learned_ai.js');
  runChecked(process.execPath, [
    scriptPath,
    'plot',
    '--output-root', config.output_root,
    '--manifest-path', config.manifest_path,
  ]);
}

function main() {
  const config = parseArgs(process.argv.slice(2));
  ensureDir(config.output_root);

  if (config.command === 'train') {
    if (!config.replay_path) {
      throw new Error('`train` requires --replay-path');
    }
    const trained = runPythonTrain(config, config.replay_path);
    console.log(`Candidate: ${trained.checkpoint_manifest_path}`);
    console.log(`Checkpoint: ${trained.checkpoint_path}`);
    console.log(`Device: ${trained.device}`);
    return;
  }

  const replayPath = config.replay_path
    || path.join(config.output_root, 'replay', `replay_python_${timestampTag()}.json`);
  const shouldDeleteReplay = !config.keep_replay && !config.replay_path;
  let trained;
  try {
    runGenerate(config, replayPath);
    trained = runPythonTrain(config, replayPath);
    runEvaluate(config, trained.checkpoint_manifest_path);
    runPlot(config);
  } finally {
    maybeDeleteReplay(replayPath, shouldDeleteReplay);
  }

  console.log(`Candidate: ${trained.checkpoint_manifest_path}`);
  console.log(`Checkpoint: ${trained.checkpoint_path}`);
  console.log(`Device: ${trained.device}`);
  console.log(`Plot: ${path.join(config.output_root, 'plots', 'progress.html')}`);
}

main();
