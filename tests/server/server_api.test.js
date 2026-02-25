const { beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  app,
  rooms,
  sseClients,
  registerSseClient,
  unregisterSseClient,
  applyYanivOutcome,
} = require('../../server/src/server');
const { Card } = require('../../server/src/card');

beforeEach(() => {
  rooms.clear();
  sseClients.clear();
});

function routeHandler(method, path) {
  const routeLayer = app._router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );
  if (!routeLayer) {
    throw new Error(`Route not found for ${method.toUpperCase()} ${path}`);
  }
  return routeLayer.route.stack[0].handle;
}

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    set(headers) {
      this.headers = { ...this.headers, ...headers };
      return this;
    },
    sendFile(filePath) {
      this.filePath = filePath;
      return this;
    },
  };
}

async function callRoute(method, path, { body = {}, params = {}, query = {} } = {}) {
  const handler = routeHandler(method, path);
  const req = {
    body,
    params,
    query,
    on: () => {},
  };
  const res = mockResponse();
  await handler(req, res);
  return { status: res.statusCode, body: res.jsonBody };
}

async function createStartedGame() {
  const create = await callRoute('post', '/api/create', {
    body: {
    name: 'P1',
    pid: 'pid-1',
    aiCount: 0,
    },
  });
  assert.equal(create.status, 200);
  const code = create.body.code;

  const join = await callRoute('post', '/api/join', {
    body: {
    name: 'P2',
    pid: 'pid-2',
    code,
    },
  });
  assert.equal(join.status, 200);

  const start = await callRoute('post', '/api/start', {
    body: { code, pid: 'pid-1' },
  });
  assert.equal(start.status, 200);

  return code;
}

async function currentTurnIdentity(code) {
  const roomView = await callRoute('get', '/api/room/:code', {
    params: { code },
    query: { pid: 'pid-1' },
  });
  assert.equal(roomView.status, 200);

  const current = roomView.body.game.players.find((player) => player.isCurrent);
  assert.ok(current, 'Expected a current player in room state');
  assert.ok(current.pid, 'Expected current player PID in room state');
  return current.pid;
}

test('action with non-integer draw returns 400', async () => {
  const code = await createStartedGame();
  const currentPid = await currentTurnIdentity(code);

  const state = await callRoute('get', '/api/room/:code', {
    params: { code },
    query: { pid: currentPid },
  });
  assert.equal(state.status, 200);
  const me = state.body.game.players.find((player) => player.isSelf);
  const firstCard = me.hand[0].id;

  const action = await callRoute('post', '/api/action', {
    body: {
      code,
      pid: currentPid,
      discard: [firstCard],
      draw: 'not-a-number',
    },
  });

  assert.equal(action.status, 400);
  assert.ok(action.body.error);
});

test('valid action sets last turn', async () => {
  const code = await createStartedGame();
  const currentPid = await currentTurnIdentity(code);

  const state = await callRoute('get', '/api/room/:code', {
    params: { code },
    query: { pid: currentPid },
  });
  const me = state.body.game.players.find((player) => player.isSelf);
  const firstCard = me.hand[0].id;

  const action = await callRoute('post', '/api/action', {
    body: {
      code,
      pid: currentPid,
      discard: [firstCard],
      draw: 'deck',
    },
  });

  assert.equal(action.status, 200);
  assert.deepEqual(action.body, { ok: true });

  const room = rooms.get(code);
  assert.ok(room.lastTurn);
  assert.ok(['P1', 'P2'].includes(room.lastTurn.player));
  assert.ok(Object.prototype.hasOwnProperty.call(room.lastTurn, 'discarded'));
});

test('waiting room options persist across join and start', async () => {
  const create = await callRoute('post', '/api/create', {
    body: {
      name: 'P1',
      pid: 'pid-1',
      aiCount: 0,
    },
  });
  const code = create.body.code;

  const options = await callRoute('post', '/api/options', {
    body: {
      code,
      pid: 'pid-1',
      slamdownsAllowed: true,
    },
  });
  assert.equal(options.status, 200);
  assert.equal(options.body.options.slamdownsAllowed, true);

  const join = await callRoute('post', '/api/join', {
    body: {
      name: 'P2',
      pid: 'pid-2',
      code,
    },
  });
  assert.equal(join.status, 200);

  const state = await callRoute('get', '/api/room/:code', {
    params: { code },
    query: { pid: 'pid-2' },
  });
  assert.equal(state.body.options.slamdownsAllowed, true);

  const start = await callRoute('post', '/api/start', {
    body: {
      code,
      pid: 'pid-1',
    },
  });
  assert.equal(start.status, 200);
  assert.equal(rooms.get(code).options.slamdownsAllowed, true);
});

test('only creator can change waiting options', async () => {
  const create = await callRoute('post', '/api/create', {
    body: {
      name: 'P1',
      pid: 'pid-1',
      aiCount: 0,
    },
  });
  const code = create.body.code;

  const join = await callRoute('post', '/api/join', {
    body: {
      name: 'P2',
      pid: 'pid-2',
      code,
    },
  });
  assert.equal(join.status, 200);

  const options = await callRoute('post', '/api/options', {
    body: {
      code,
      pid: 'pid-2',
      slamdownsAllowed: true,
    },
  });
  assert.equal(options.status, 400);
  assert.ok(options.body.error);
});

test('sse unregister old stream keeps new reconnect', () => {
  const code = 'abcde';
  const pid = 'pid-1';
  const oldClient = { id: 'old' };
  const newClient = { id: 'new' };

  registerSseClient(code, pid, oldClient);
  registerSseClient(code, pid, newClient);
  unregisterSseClient(code, pid, oldClient);

  assert.equal(sseClients.has(code), true);
  assert.equal(sseClients.get(code).get(pid), newClient);
});

test('sse unregister current stream removes client', () => {
  const code = 'vwxyz';
  const pid = 'pid-2';
  const client = { id: 'only' };

  registerSseClient(code, pid, client);
  unregisterSseClient(code, pid, client);

  assert.equal(sseClients.has(code), false);
});

test('yaniv round payload includes final hands before redeal', async () => {
  const code = await createStartedGame();
  const room = rooms.get(code);
  const game = room.game;
  const declarer = game.getCurrentPlayer();
  const opponent = game.players.find((player) => player !== declarer);

  declarer.hand = [new Card('A', 'Clubs')];
  opponent.hand = [new Card('K', 'Spades'), new Card('Q', 'Spades')];

  applyYanivOutcome(room, game, declarer);
  const lastRound = room.lastRound;

  const changes = Object.fromEntries(lastRound.scoreChanges.map((change) => [change.name, change]));
  const declarerChange = changes[declarer.name];
  const opponentChange = changes[opponent.name];

  assert.deepEqual(declarerChange.finalHand.map((card) => card.rank), ['A']);
  assert.deepEqual(opponentChange.finalHand.map((card) => card.rank), ['K', 'Q']);
});
