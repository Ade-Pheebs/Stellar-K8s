export const MAX_NODES = 5000;
export const MAX_EDGES = 20000;

const PHASES = new Set(['PREPARE', 'CONFIRM', 'EXTERNALIZE', 'UNKNOWN']);

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function shortId(id = '') {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function metric(source, names, fallback = 0) {
  for (const name of names) {
    if (source?.[name] !== undefined) return asNumber(source[name], fallback);
    if (source?.metrics?.[name] !== undefined) return asNumber(source.metrics[name], fallback);
    if (source?.metadata?.[name] !== undefined) return asNumber(source.metadata[name], fallback);
  }
  return fallback;
}

function normalizeNode(node = {}, fallback = {}) {
  const fullId = String(node.full_id ?? node.fullId ?? node.node_id ?? node.id ?? fallback.id ?? 'unknown');
  const phase = String(node.phase ?? fallback.phase ?? 'UNKNOWN').toUpperCase();
  return {
    id: String(node.id ?? shortId(fullId)),
    fullId,
    name: String(node.node_name ?? node.nodeName ?? fallback.name ?? shortId(fullId)),
    cluster: String(node.cluster ?? node.namespace ?? fallback.cluster ?? 'default'),
    phase: PHASES.has(phase) ? phase : 'UNKNOWN',
    health: String(node.health ?? fallback.health ?? 'unknown').toLowerCase(),
    critical: Boolean(node.is_critical ?? node.isCritical ?? fallback.critical),
    stalled: Boolean(node.stalled ?? node.is_stalled ?? node.isStalled ?? fallback.stalled),
    threshold: asNumber(node.threshold ?? fallback.threshold, 0),
    ballotCounter: asNumber(node.ballot_counter ?? node.ballotCounter ?? fallback.ballotCounter, 0),
    tps: metric(node, ['tps', 'transactions_per_second'], fallback.tps),
    ledgerTimeMs: metric(node, ['ledger_time_ms', 'ledgerTimeMs', 'ledger_time'], fallback.ledgerTimeMs),
    lastSeen: asNumber(node.timestamp ?? fallback.lastSeen, Date.now()),
  };
}

function edgeKey(source, target) {
  return `${source}\u0000${target}`;
}

function nodeId(value) {
  return String(value?.id ?? value?.full_id ?? value?.fullId ?? value ?? '');
}

function normalizeEdges(edges = [], nodesById) {
  const result = [];
  const seen = new Set();
  for (const edge of edges) {
    const source = nodeId(edge.source);
    const target = nodeId(edge.target);
    if (!source || !target || !nodesById.has(source) || !nodesById.has(target)) continue;
    const key = edgeKey(source, target);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ source, target });
    }
    if (result.length >= MAX_EDGES) break;
  }
  return result;
}

export function normalizeSnapshot(snapshot = {}) {
  const sourceNodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const nodes = sourceNodes.slice(0, MAX_NODES).map((node) => normalizeNode(node));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes,
    edges: normalizeEdges(Array.isArray(snapshot.edges) ? snapshot.edges : [], nodesById),
    timestamp: snapshot.timestamp ?? new Date().toISOString(),
    healthy: snapshot.healthy !== false,
  };
}

export function applyMessage(state, message = {}) {
  const rawId = nodeId(message);
  if (!rawId) return state;
  const existing = [...state.nodesById.values()].find((candidate) =>
    candidate.id === rawId || candidate.fullId === rawId || candidate.id === shortId(rawId),
  );
  const node = normalizeNode(message, existing);
  const key = existing?.id ?? node.id;
  if (existing && existing.id !== key) state.nodesById.delete(existing.id);
  node.id = key;
  node.fullId = node.fullId || existing?.fullId || rawId;
  state.nodesById.set(key, node);

  const rawQuorum = message.quorum_set ?? message.quorumSet ?? {};
  const members = [
    ...(Array.isArray(rawQuorum.validators) ? rawQuorum.validators : []),
    ...(Array.isArray(rawQuorum.inner_sets) ? rawQuorum.inner_sets.flatMap((set) => set.validators ?? []) : []),
  ];
  for (const member of members) {
    const targetRaw = nodeId(member);
    if (!targetRaw) continue;
    const target = state.nodesById.get(targetRaw) ?? state.nodesById.get(shortId(targetRaw));
    if (!target) continue;
    const sourceId = node.id;
    const targetId = target.id;
    const edge = { source: sourceId, target: targetId };
    if (!state.edgeKeys.has(edgeKey(sourceId, targetId))) {
      state.edgeKeys.add(edgeKey(sourceId, targetId));
      state.edges.push(edge);
      if (state.edges.length > MAX_EDGES) {
        const removed = state.edges.shift();
        state.edgeKeys.delete(edgeKey(removed.source, removed.target));
      }
    }
  }

  while (state.nodesById.size > MAX_NODES) {
    const first = state.nodesById.keys().next().value;
    state.nodesById.delete(first);
  }
  state.timestamp = message.timestamp ?? new Date().toISOString();
  state.healthy = true;
  return state;
}

export function createStreamState(snapshot = {}) {
  const normalized = normalizeSnapshot(snapshot);
  return {
    nodesById: new Map(normalized.nodes.map((node) => [node.id, node])),
    edges: normalized.edges,
    edgeKeys: new Set(normalized.edges.map((edge) => edgeKey(edge.source, edge.target))),
    timestamp: normalized.timestamp,
    healthy: normalized.healthy,
  };
}

export function materialize(state) {
  return {
    nodes: [...state.nodesById.values()],
    edges: state.edges,
    timestamp: state.timestamp,
    healthy: state.healthy,
  };
}

export function ingest(state, payload) {
  if (Array.isArray(payload?.nodes)) {
    return createStreamState(payload);
  }
  return applyMessage(state, payload);
}

export function statusForNode(node) {
  if (node.stalled || node.phase === 'UNKNOWN') return 'falling-behind';
  if (node.health === 'degraded' || node.phase === 'PREPARE' || node.phase === 'CONFIRM') return 'degraded';
  return 'synced';
}
