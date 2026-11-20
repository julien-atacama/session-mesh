// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {configuration, Dictation} from '../backend/dictation.ts';
import {withFixtureServer} from '../checks/dictation-browser-fixture.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

export async function assertInsertedFixtureParity(): Promise<void> {
  await withFixtureServer(async (base, api) => {
    const headers = {'X-Mesh-Dictation-Client': crypto.randomUUID(), 'X-Mesh-Request-Id': crypto.randomUUID(),
      'X-Mesh-Session': 'A', 'X-Mesh-Created': '1', 'Content-Type': 'audio/webm'};
    const upload = fetch(base + '/api/transcribe', {method: 'POST', headers, body: 'synthetic audio'});
    await waitFor('owned fake admission', 2000, () => api.jobs.length === 1);
    api.ack('A'); const admitted = await upload;
    assert.equal(admitted.status, 202);
    const job = api.jobs[0], url = base + '/api/transcribe/' + job.job_id + '/settle';
    const settle = (outcome: string, client = headers['X-Mesh-Dictation-Client']) => fetch(url, {method: 'POST',
      headers: {...headers, 'Content-Type': 'application/json', 'X-Mesh-Dictation-Client': client},
      body: JSON.stringify({outcome})});
    assert.equal((await settle('inserted')).status, 400, 'queued jobs are not inserted');
    assert.equal(job.state, 'queued');
    job.state = 'ready'; job.text = 'fixture transcript';
    assert.equal((await settle('inserted', crypto.randomUUID())).status, 404);
    assert.equal((await settle('unrecognized')).status, 400);
    const completed = await settle('inserted'); assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), {...job, state: 'settled', text: null, outcome: 'inserted'});
    assert.equal((await settle('inserted')).status, 200, 'identical settlement is idempotent');
    assert.equal((await settle('submitted')).status, 400, 'inserted is not submitted');
    assert.equal((await settle('discarded')).status, 400, 'different outcomes conflict');
  });
}

export async function assertInsertedEngineParity(): Promise<void> {
  const config = configuration({MESH_WHISPER_URL: 'http://127.0.0.1:1/unused'})!;
  const engine = new Dictation(config, {infer: async () => 'engine transcript'});
  const owner = {principal: 'a'.repeat(64), client: crypto.randomUUID()};
  try {
    const prepared = await engine.prepare({...owner, request: crypto.randomUUID(), session: 'A', created: 1,
      mime: 'audio/webm'}, (async function* () {yield Buffer.from('synthetic audio');})());
    assert.throws(() => engine.settle(owner, prepared.job.job_id, 'inserted'), {code: 'invalid_state'});
    engine.commit(owner, prepared.job.job_id, prepared.preparation);
    await waitFor('owned engine ready', 2000, () => engine.read(owner, prepared.job.job_id).state === 'ready');
    assert.throws(() => engine.settle({...owner, client: crypto.randomUUID()}, prepared.job.job_id, 'inserted'),
      {code: 'not_found'});
    const settled = engine.settle(owner, prepared.job.job_id, 'inserted');
    assert.equal(settled.state, 'settled'); assert.equal(settled.outcome, 'inserted'); assert.equal(settled.text, null);
    assert.deepEqual(engine.settle(owner, prepared.job.job_id, 'inserted'), settled);
    assert.throws(() => engine.settle(owner, prepared.job.job_id, 'submitted'), {code: 'invalid_state'});
    assert.throws(() => engine.settle(owner, prepared.job.job_id, 'discarded'), {code: 'invalid_state'});
  } finally {await engine.close();}
}

test('strict browser fake and production engine agree on inserted settlement', async () => {
  await assertInsertedEngineParity(); await assertInsertedFixtureParity();
});
