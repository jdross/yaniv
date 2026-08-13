const { STATE_SIZE, ACTION_SPACE_SIZE } = require('../state_encoder');

async function trainOnBatch(model, examples, options = {}) {
  const tf = require('../network').getTf();
  const {
    batchSize = 256,
    epochs = 10,
    learningRate = 0.001,
    valueLossWeight = 1.0,
  } = options;

  if (examples.length === 0) return { policyLoss: 0, valueLoss: 0, totalLoss: 0 };

  const numExamples = examples.length;
  const stateData = new Float32Array(numExamples * STATE_SIZE);
  const policyTargets = new Float32Array(numExamples * ACTION_SPACE_SIZE);
  const valueTargets = new Float32Array(numExamples);

  for (let i = 0; i < numExamples; i += 1) {
    stateData.set(examples[i].state, i * STATE_SIZE);
    policyTargets.set(examples[i].policy, i * ACTION_SPACE_SIZE);
    valueTargets[i] = examples[i].value;
  }

  const statesTensor = tf.tensor2d(stateData, [numExamples, STATE_SIZE]);
  const policyTensor = tf.tensor2d(policyTargets, [numExamples, ACTION_SPACE_SIZE]);
  const valueTensor = tf.tensor2d(valueTargets, [numExamples, 1]);

  const optimizer = tf.train.adam(learningRate);

  let lastPolicyLoss = 0;
  let lastValueLoss = 0;
  let lastTotalLoss = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let start = 0; start < numExamples; start += batchSize) {
      const end = Math.min(start + batchSize, numExamples);
      const batchStates = statesTensor.slice([start, 0], [end - start, STATE_SIZE]);
      const batchPolicy = policyTensor.slice([start, 0], [end - start, ACTION_SPACE_SIZE]);
      const batchValue = valueTensor.slice([start, 0], [end - start, 1]);

      const lossInfo = optimizer.minimize(() => {
        const [policyLogits, valueOut] = model.predict(batchStates);

        const policyLoss = tf.losses.softmaxCrossEntropy(batchPolicy, policyLogits);
        const valueLoss = tf.losses.meanSquaredError(batchValue, valueOut);
        const totalLoss = policyLoss.add(valueLoss.mul(valueLossWeight));

        lastPolicyLoss = policyLoss.dataSync()[0];
        lastValueLoss = valueLoss.dataSync()[0];
        lastTotalLoss = totalLoss.dataSync()[0];

        return totalLoss;
      }, true);

      if (lossInfo) lossInfo.dispose();
      batchStates.dispose();
      batchPolicy.dispose();
      batchValue.dispose();
    }
  }

  statesTensor.dispose();
  policyTensor.dispose();
  valueTensor.dispose();
  optimizer.dispose();

  return {
    policyLoss: lastPolicyLoss,
    valueLoss: lastValueLoss,
    totalLoss: lastTotalLoss,
  };
}

module.exports = { trainOnBatch };
