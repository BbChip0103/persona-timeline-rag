// Run inside the synthetic ptr-api pod: kubectl exec -i ... -- node - < this file.
// Reads only its own role environment and prints no credential or chat content.
const { Client } = require('pg');
let stage = 'start';

async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:56441/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`,
      'X-PTR-Owner': 'lt-k2-synthetic',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function main() {
  stage = 'session';
  const created = await request('sessions', {
    personId: 'synthetic-split-person',
    retrievalMode: 'off',
    ragCondition: 'off',
    executionProfile: 'agent_loop',
  });
  stage = 'turn_create';
  const turn = await request(`sessions/${created.session.id}/turns`, {
    clientRequestId: `k2-${Date.now()}`,
    text: JSON.stringify({
      message: 'K4_ID:echo-smoke',
      status: 'answered',
      evidenceRefs: [],
      variableUpdates: {},
    }),
  });
  stage = 'turn_poll';
  let final;
  for (let attempt = 0; attempt < 240; attempt++) {
    final = (await request(`turns/${turn.turn.id}`)).turn;
    if (['completed', 'failed', 'cancelled'].includes(final.state)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  stage = 'database_connect';
  const client = new Client({ connectionString: process.env.PTR_APP_DATABASE_URL });
  await client.connect();
  stage = 'database_ack';
  let ack;
  let outbox;
  try {
    ack = await client.query(
      'SELECT count(*)::int AS n FROM app.turn_execution_grants WHERE turn_id=$1 AND result_hash IS NOT NULL',
      [turn.turn.id],
    );
    outbox = await client.query('SELECT count(*)::int AS n FROM app.turn_outbox WHERE turn_id=$1', [turn.turn.id]);
  } finally {
    await client.end();
  }
  const result = {
    state: final?.state ?? 'timeout',
    durableAck: ack.rows[0].n === 1,
    outboxRemoved: outbox.rows[0].n === 0,
  };
  console.log(JSON.stringify(result));
  if (result.state !== 'completed' || !result.durableAck || !result.outboxRemoved) process.exitCode = 1;
}

main().catch(error => {
  const code = /^HTTP_[0-9]{3}$/.test(error?.message ?? '') ? error.message : error?.name ?? 'UNKNOWN';
  console.error(`SYNTHETIC_TURN_SMOKE_FAILED stage=${stage} code=${code}`);
  process.exitCode = 1;
});
