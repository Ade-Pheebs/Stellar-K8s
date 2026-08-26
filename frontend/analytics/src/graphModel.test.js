import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMessage, createStreamState, ingest, materialize, normalizeSnapshot, statusForNode } from './graphModel.js';

test('normalizes operator topology snapshots and removes invalid duplicate edges', () => {
  const snapshot = normalizeSnapshot({
    nodes: [{ id: 'A', phase: 'externalize' }, { id: 'B', phase: 'CONFIRM' }],
    edges: [{ source: 'A', target: 'B' }, { source: 'A', target: 'B' }, { source: 'A', target: 'missing' }],
  });
  assert.equal(snapshot.nodes[0].phase, 'EXTERNALIZE');
  assert.deepEqual(snapshot.edges, [{ source: 'A', target: 'B' }]);
});

test('updates a node from an SCP message without replacing the existing graph', () => {
  const state = createStreamState({ nodes: [{ id: 'A' }, { id: 'B' }], edges: [] });
  applyMessage(state, {
    node_id: 'A',
    phase: 'EXTERNALIZE',
    ballot_counter: 9,
    metrics: { tps: 123.4, ledger_time_ms: 4.2 },
    quorum_set: { validators: ['B'] },
  });
  const graph = materialize(state);
  assert.equal(graph.nodes.find((node) => node.id === 'A').tps, 123.4);
  assert.deepEqual(graph.edges, [{ source: 'A', target: 'B' }]);
});

test('accepts both snapshots and individual messages through ingest', () => {
  let state = createStreamState({ nodes: [{ id: 'A' }], edges: [] });
  state = ingest(state, { node_id: 'A', phase: 'CONFIRM' });
  assert.equal(materialize(state).nodes[0].phase, 'CONFIRM');
  state = ingest(state, { nodes: [{ id: 'B', phase: 'EXTERNALIZE' }], edges: [] });
  assert.equal(materialize(state).nodes[0].id, 'B');
});

test('classifies health statuses for the visual legend', () => {
  assert.equal(statusForNode({ phase: 'EXTERNALIZE' }), 'synced');
  assert.equal(statusForNode({ phase: 'CONFIRM' }), 'degraded');
  assert.equal(statusForNode({ phase: 'UNKNOWN' }), 'falling-behind');
});
