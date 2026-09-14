import { pathToFileURL } from 'node:url';

const sigmoid = value => 1 / (1 + Math.exp(-value));
const sigmoidDerivative = output => output * (1 - output);

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function weights(rows, columns, rand) {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => rand() * 2 - 1));
}

export class NeuralNetwork {
  constructor({ inputSize, hiddenSize, outputSize, learningRate = 0.5, seed = 1 }) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    this.outputSize = outputSize;
    this.learningRate = learningRate;

    const rand = random(seed);
    this.hiddenWeights = weights(hiddenSize, inputSize, rand);
    this.hiddenBias = Array.from({ length: hiddenSize }, () => rand() * 2 - 1);
    this.outputWeights = weights(outputSize, hiddenSize, rand);
    this.outputBias = Array.from({ length: outputSize }, () => rand() * 2 - 1);
  }

  forward(input) {
    if (input.length !== this.inputSize) throw new Error(`Expected ${this.inputSize} inputs, got ${input.length}`);

    const hidden = this.hiddenWeights.map((row, index) => {
      const sum = row.reduce((total, weight, inputIndex) => total + weight * input[inputIndex], this.hiddenBias[index]);
      return sigmoid(sum);
    });

    const output = this.outputWeights.map((row, index) => {
      const sum = row.reduce((total, weight, hiddenIndex) => total + weight * hidden[hiddenIndex], this.outputBias[index]);
      return sigmoid(sum);
    });

    return { hidden, output };
  }

  predict(input) {
    return this.forward(input).output;
  }

  train(inputs, targets, epochs = 10000) {
    let loss = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      loss = 0;

      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        const target = targets[index];
        const { hidden, output } = this.forward(input);

        const outputError = target.map((value, outputIndex) => value - output[outputIndex]);
        loss += outputError.reduce((sum, error) => sum + error * error, 0) / outputError.length;

        const outputDelta = outputError.map((error, outputIndex) => error * sigmoidDerivative(output[outputIndex]));
        const hiddenError = hidden.map((_, hiddenIndex) => outputDelta.reduce((sum, delta, outputIndex) => sum + delta * this.outputWeights[outputIndex][hiddenIndex], 0));
        const hiddenDelta = hidden.map((value, hiddenIndex) => hiddenError[hiddenIndex] * sigmoidDerivative(value));

        for (let outputIndex = 0; outputIndex < this.outputSize; outputIndex++) {
          this.outputBias[outputIndex] += this.learningRate * outputDelta[outputIndex];
          for (let hiddenIndex = 0; hiddenIndex < this.hiddenSize; hiddenIndex++) {
            this.outputWeights[outputIndex][hiddenIndex] += this.learningRate * outputDelta[outputIndex] * hidden[hiddenIndex];
          }
        }

        for (let hiddenIndex = 0; hiddenIndex < this.hiddenSize; hiddenIndex++) {
          this.hiddenBias[hiddenIndex] += this.learningRate * hiddenDelta[hiddenIndex];
          for (let inputIndex = 0; inputIndex < this.inputSize; inputIndex++) {
            this.hiddenWeights[hiddenIndex][inputIndex] += this.learningRate * hiddenDelta[hiddenIndex] * input[inputIndex];
          }
        }
      }

      loss /= inputs.length;
    }

    return loss;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputs = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const targets = [[0], [1], [1], [0]];
  const network = new NeuralNetwork({ inputSize: 2, hiddenSize: 4, outputSize: 1, learningRate: 0.8, seed: 7 });
  const loss = network.train(inputs, targets, 20000);

  for (const input of inputs) {
    console.log(`${input.join(' XOR ')} = ${network.predict(input)[0].toFixed(3)}`);
  }
  console.log(`final loss: ${loss.toFixed(6)}`);
}
