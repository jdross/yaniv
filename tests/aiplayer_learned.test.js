const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Card } = require('../server/src/card');
const { AIPlayerLearned, buildLearnedActionCandidates, buildYanivFeatureMap } = require('../server/src/aiplayer_learned');
const { ACTION_FEATURE_NAMES, YANIV_FEATURE_NAMES } = require('../server/src/learned_model');

function makeRound() {
  return [
    { name: 'AI', score: 0 },
    { name: 'Opp', score: 0 },
  ];
}

function makeTempManifest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaniv-learned-'));
  const bootstrapManifest = path.resolve(__dirname, '..', 'server', 'learned_ai', 'current_champion.json');
  const bootstrapCheckpoint = path.resolve(__dirname, '..', 'server', 'learned_ai', 'checkpoints', 'bootstrap-learned.json');
  const manifest = {
    ...JSON.parse(fs.readFileSync(bootstrapManifest, 'utf8')),
    model_path: bootstrapCheckpoint,
  };
  const manifestPath = path.join(tempDir, 'current_champion.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { tempDir, manifestPath };
}

test('learned player chooses deterministic legal action for the same state', () => {
  const { tempDir, manifestPath } = makeTempManifest();

  const createPlayer = () => {
    const player = new AIPlayerLearned('AI', 24, { manifestPath });
    player.observe_round(makeRound());
    player.hand = [new Card('7', 'Spades'), new Card('8', 'Clubs'), new Card('8', 'Diamonds'), new Card('A', 'Hearts')];
    player.draw_options = [new Card('5', 'Hearts')];
    player.public_discard_pile = [new Card('5', 'Hearts')];
    player.other_players.Opp.hand_count = 2;
    player.other_players.Opp.estimated_score = 4;
    player.other_players.Opp.need_by_rank['7'] = 2.0;
    player.other_players.Opp.low_card_bias = 1.0;
    return player;
  };

  const actionOne = createPlayer().decide_action();
  const actionTwo = createPlayer().decide_action();
  assert.deepEqual(
    { draw: actionOne.draw, discard: actionOne.discard.map((card) => card._card).sort((a, b) => a - b) },
    { draw: actionTwo.draw, discard: actionTwo.discard.map((card) => card._card).sort((a, b) => a - b) },
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('learned action candidates expose only the expected feature keys', () => {
  const { tempDir, manifestPath } = makeTempManifest();
  const player = new AIPlayerLearned('AI', 24, { manifestPath });
  player.observe_round(makeRound());
  player.hand = [new Card('4', 'Hearts'), new Card('4', 'Clubs'), new Card('9', 'Spades')];
  player.draw_options = [new Card('5', 'Hearts')];
  player.public_discard_pile = [new Card('5', 'Hearts')];

  const candidates = buildLearnedActionCandidates(player, player._build_action_context(), null);
  assert.ok(candidates.length > 0);
  assert.deepEqual(Object.keys(candidates[0].action_features).sort(), [...ACTION_FEATURE_NAMES].sort());

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('learned yaniv feature map stays on the agreed public interface', () => {
  const { tempDir, manifestPath } = makeTempManifest();
  const player = new AIPlayerLearned('AI', 24, { manifestPath });
  player.observe_round(makeRound());
  player.hand = [new Card('2', 'Clubs'), new Card('2', 'Diamonds')];
  const features = buildYanivFeatureMap(player);

  assert.deepEqual(Object.keys(features).sort(), [...YANIV_FEATURE_NAMES].sort());

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('learned player throws a clear error when the manifest is missing', () => {
  assert.throws(
    () => new AIPlayerLearned('AI', 24, { manifestPath: '/definitely/missing/learned.json' }),
    /Learned champion manifest not found/,
  );
});
