const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const benchmark = require('../scripts/benchmark');
const runLearnedIntegration = process.env.RUN_LEARNED_INTEGRATION === '1';

function makeTempRuntimeManifest(rootDir) {
  const bootstrapManifestPath = path.resolve(__dirname, '..', 'server', 'learned_ai', 'current_champion.json');
  const bootstrapCheckpointPath = path.resolve(__dirname, '..', 'server', 'learned_ai', 'checkpoints', 'bootstrap-learned.json');
  const manifest = JSON.parse(fs.readFileSync(bootstrapManifestPath, 'utf8'));
  manifest.model_path = bootstrapCheckpointPath;
  const outPath = path.join(rootDir, 'runtime_manifest.json');
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return outPath;
}

test('benchmark registry includes learned and can run a tiny head-to-head', async () => {
  assert.ok(benchmark.POLICY_REGISTRY.learned);
  const raw = await benchmark.runBenchmarks({
    players: ['learned', 'v3'],
    games: 2,
    max_turns: 300,
    seed: 123,
    rollout_samples: 12,
    jobs: 1,
  });
  const summary = benchmark.summarizeResults(raw, ['learned', 'v3']);
  assert.equal(summary.games, 2);
  assert.ok(summary.policy_labels.learned);
});

test('learned training CLI completes a tiny warm-start cycle', {
  skip: !runLearnedIntegration,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaniv-learned-run-'));
  const outputRoot = path.join(tempDir, 'out');
  const runtimeManifest = makeTempRuntimeManifest(tempDir);
  const initialManifest = fs.readFileSync(runtimeManifest, 'utf8');
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'learned_ai.js');

  execFileSync(process.execPath, [
    scriptPath,
    'run',
    '--games', '4',
    '--eval-games-2p', '2',
    '--eval-games-3p', '2',
    '--max-turns', '300',
    '--rollout-samples', '12',
    '--output-root', outputRoot,
    '--manifest-path', runtimeManifest,
    '--jobs', '1',
  ], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe',
  });

  const progressPath = path.join(outputRoot, 'progress.jsonl');
  const plotPath = path.join(outputRoot, 'plots', 'progress.html');
  const replayDir = path.join(outputRoot, 'replay');
  assert.ok(fs.existsSync(progressPath));
  assert.ok(fs.existsSync(plotPath));

  const progressLines = fs.readFileSync(progressPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(progressLines.length >= 1);
  const replayFiles = fs.existsSync(replayDir) ? fs.readdirSync(replayDir).filter((entry) => entry.endsWith('.json')) : [];
  assert.deepEqual(replayFiles, []);
  assert.equal(fs.readFileSync(runtimeManifest, 'utf8'), initialManifest);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('promote writes the selected candidate manifest explicitly', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaniv-learned-promote-'));
  const runtimeDir = path.join(tempDir, 'runtime');
  const runtimeManifest = path.join(runtimeDir, 'current_champion.json');
  const candidateDir = path.join(tempDir, 'candidate');
  fs.mkdirSync(path.join(runtimeDir, 'checkpoints'), { recursive: true });
  fs.mkdirSync(candidateDir, { recursive: true });

  const checkpointId = 'learned-test-promote';
  const candidateCheckpoint = path.join(candidateDir, `${checkpointId}.json`);
  const candidateManifest = path.join(candidateDir, `${checkpointId}.manifest.json`);
  fs.writeFileSync(candidateCheckpoint, `${JSON.stringify({ checkpoint_id: checkpointId }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(candidateManifest, `${JSON.stringify({
    schema_version: 1,
    checkpoint_id: checkpointId,
    training_iteration: 9,
    created_at: '2026-03-23T00:00:00.000Z',
    rating_2p: 1700,
    rating_3p: 1450,
    win_rate_vs_v3: 0.61,
    latency_summary: { avg_ms: 0.4, p95_ms: 0.8, max_ms: 1.2 },
    model_path: candidateCheckpoint,
  }, null, 2)}\n`, 'utf8');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'learned_ai.js');
  execFileSync(process.execPath, [
    scriptPath,
    'promote',
    '--candidate-manifest-path', candidateManifest,
    '--manifest-path', runtimeManifest,
  ], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe',
  });

  const promoted = JSON.parse(fs.readFileSync(runtimeManifest, 'utf8'));
  assert.equal(promoted.checkpoint_id, checkpointId);
  assert.equal(promoted.model_path, candidateCheckpoint);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
