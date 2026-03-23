const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const benchmark = require('../scripts/benchmark');

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

test('learned training CLI completes a tiny warm-start cycle', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaniv-learned-run-'));
  const outputRoot = path.join(tempDir, 'out');
  const runtimeManifest = makeTempRuntimeManifest(tempDir);
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
  assert.ok(fs.existsSync(progressPath));
  assert.ok(fs.existsSync(plotPath));

  const progressLines = fs.readFileSync(progressPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(progressLines.length >= 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
