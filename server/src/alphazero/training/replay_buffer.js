const fs = require('node:fs');

class ReplayBuffer {
  constructor(maxSize = 100000) {
    this.maxSize = maxSize;
    this.buffer = [];
    this.position = 0;
    this.totalAdded = 0;
  }

  add(example) {
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(example);
    } else {
      this.buffer[this.position] = example;
    }
    this.position = (this.position + 1) % this.maxSize;
    this.totalAdded += 1;
  }

  addBatch(examples) {
    for (const example of examples) {
      this.add(example);
    }
  }

  sample(batchSize) {
    const size = Math.min(batchSize, this.buffer.length);
    const indices = new Set();
    while (indices.size < size) {
      indices.add(Math.floor(Math.random() * this.buffer.length));
    }
    return [...indices].map((i) => this.buffer[i]);
  }

  get size() {
    return this.buffer.length;
  }

  save(filePath) {
    const data = {
      maxSize: this.maxSize,
      position: this.position,
      totalAdded: this.totalAdded,
      buffer: this.buffer.map((ex) => ({
        state: Array.from(ex.state),
        policy: Array.from(ex.policy),
        value: ex.value,
      })),
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
  }

  static load(filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rb = new ReplayBuffer(data.maxSize);
    rb.position = data.position;
    rb.totalAdded = data.totalAdded;
    rb.buffer = data.buffer.map((ex) => ({
      state: new Float32Array(ex.state),
      policy: new Float32Array(ex.policy),
      value: ex.value,
    }));
    return rb;
  }
}

module.exports = { ReplayBuffer };
