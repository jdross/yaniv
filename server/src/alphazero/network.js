const { STATE_SIZE, ACTION_SPACE_SIZE } = require('./state_encoder');

let tf = null;

function getTf() {
  if (tf) return tf;
  try {
    tf = require('@tensorflow/tfjs-node');
  } catch {
    tf = require('@tensorflow/tfjs');
  }
  return tf;
}

function createModel() {
  const backend = getTf();

  const input = backend.input({ shape: [STATE_SIZE] });

  let x = backend.layers.dense({ units: 256, activation: 'relu', kernelRegularizer: backend.regularizers.l2({ l2: 1e-4 }) }).apply(input);
  x = backend.layers.dense({ units: 128, activation: 'relu', kernelRegularizer: backend.regularizers.l2({ l2: 1e-4 }) }).apply(x);
  x = backend.layers.dense({ units: 64, activation: 'relu', kernelRegularizer: backend.regularizers.l2({ l2: 1e-4 }) }).apply(x);

  const policyLogits = backend.layers.dense({
    units: ACTION_SPACE_SIZE,
    name: 'policy_logits',
  }).apply(x);

  const valueOutput = backend.layers.dense({
    units: 1,
    activation: 'tanh',
    name: 'value',
  }).apply(x);

  const model = backend.model({
    inputs: input,
    outputs: [policyLogits, valueOutput],
  });

  return model;
}

function predict(model, stateVector) {
  const backend = getTf();
  const inputTensor = backend.tensor2d([stateVector], [1, STATE_SIZE]);

  const [policyLogitsTensor, valueTensor] = model.predict(inputTensor);

  const policyLogits = policyLogitsTensor.dataSync();
  const value = valueTensor.dataSync()[0];

  inputTensor.dispose();
  policyLogitsTensor.dispose();
  valueTensor.dispose();

  return { policyLogits: Array.from(policyLogits), value };
}

function maskedSoftmax(logits, mask) {
  const masked = logits.map((l, i) => (mask[i] > 0 ? l : -1e9));
  const maxVal = Math.max(...masked);
  const exps = masked.map((l) => Math.exp(l - maxVal));
  const sum = exps.reduce((s, e) => s + e, 0);
  return exps.map((e) => (sum > 0 ? e / sum : 0));
}

function predictBatch(model, stateVectors) {
  const backend = getTf();
  const batchSize = stateVectors.length;
  if (batchSize === 0) return [];

  const flatData = new Float32Array(batchSize * STATE_SIZE);
  for (let i = 0; i < batchSize; i += 1) {
    flatData.set(stateVectors[i], i * STATE_SIZE);
  }

  const inputTensor = backend.tensor2d(flatData, [batchSize, STATE_SIZE]);
  const [policyLogitsTensor, valueTensor] = model.predict(inputTensor);

  const policyLogitsData = policyLogitsTensor.dataSync();
  const valueData = valueTensor.dataSync();

  const results = [];
  for (let i = 0; i < batchSize; i += 1) {
    const start = i * (policyLogitsData.length / batchSize);
    const end = start + (policyLogitsData.length / batchSize);
    results.push({
      policyLogits: Array.from(policyLogitsData.slice(start, end)),
      value: valueData[i],
    });
  }

  inputTensor.dispose();
  policyLogitsTensor.dispose();
  valueTensor.dispose();

  return results;
}

async function saveModel(model, dirPath) {
  await model.save(`file://${dirPath}`);
}

async function loadModel(dirPath) {
  const backend = getTf();
  return backend.loadLayersModel(`file://${dirPath}/model.json`);
}

module.exports = {
  getTf,
  createModel,
  predict,
  predictBatch,
  maskedSoftmax,
  saveModel,
  loadModel,
};
