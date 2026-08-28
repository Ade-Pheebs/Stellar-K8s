# Disaster Recovery & Quorum Loss Runbook

Scenario-based recovery procedures for a single Stellar-K8s `StellarNode` — a
crashed pod, a corrupted data volume, or a validator that can no longer reach
quorum. Format: **Symptom → Diagnosis → Mitigation → Resolution**, in that
order, so you can jump straight to the step you need.

**Scope**: single-cluster, single-node recovery using this operator's own
finalizer/PVC/CRD mechanics. For losing an entire region/cluster, see
[DR Failover Guide](../dr-failover.md) instead — that's a different feature
(`spec.drConfig`, cross-cluster) and a different procedure.

---

## Read this first: the one mistake that turns an outage into data loss

```bash
kubectl get stellarnode <name> -o jsonpath='{.spec.storage.retentionPolicy}'
```

- **`Delete` (the CRD default)**: deleting the `StellarNode` resource runs the
  operator's finalizer (`stellarnode.stellar.org/finalizer`), which deletes
  the node's PVC as part of cleanup.
- **`Retain`**: the finalizer cleans up the StatefulSet/Deployment/Service but
  leaves the PVC (`<name>-data`) behind.

**Every scenario below recovers a node without ever deleting the
`StellarNode` resource.** Deleting the pod is always safe (the StatefulSet
recreates it against the same PVC); deleting the `StellarNode` is a
data-loss risk under the default policy and is not a step in this runbook.
If you ever consider it, check `retentionPolicy` first — no exceptions.

Two non-destructive levers you'll use throughout, instead of deleting the CR:

| Field | Effect | Use it to… |
|---|---|---|
| `spec.suspended: true` | Scales the workload to 0 replicas. PVC and Service untouched. Also disables the operator's auto-remediation loop (§ below). | Safely stop the pod before touching its PVC. |
| `spec.maintenanceMode: true` | Pauses **all** reconciliation for this node (status → `Maintenance`); the operator won't revert manual patches. | Freeze the operator's hands off a node while you work on it by other means (`kubectl debug`, manual PVC ops). |

Both are reversible by flipping the field back and reapplying — no data is
touched by either.

### What the operator already tries automatically (and why it isn't enough)

The reconciler has a built-in stale-ledger watchdog
(`src/controller/remediation.rs`): if the ledger hasn't advanced for **15
minutes**, it emits a `Warning` event and deletes the pod once (a `Restart`,
throttled to once per **10 minutes** via the
`stellar.org/last-remediation-time` annotation):

```bash
kubectl get events --field-selector reason=AutoRemediationRestart -n <namespace>
```

If a restart doesn't fix it, the watchdog's own logic computes a second
escalation level called `ClearAndResync` — **but as of this operator
version, nothing in the reconciler actually acts on that level.** It's
tracked in the `stellar.org/remediation-level` annotation but no PVC wipe or
resync is triggered automatically. In other words: **if a node is still
stuck after ~25 minutes (15 to first detection + one 10-minute-throttled
restart), do not wait for the operator to fix it further — it won't.** Move
to the manual scenarios below.

```bash
kubectl get stellarnode <name> -o jsonpath='{.metadata.annotations.stellar\.org/remediation-level}'
# "2" (ClearAndResync) with no further action taken confirms this is where you are
```

### Naming reference (so commands below aren't guesswork)

For a `StellarNode` named `my-validator` of type `Validator`:

| Resource | Name | Notes |
|---|---|---|
| Workload | `my-validator` | `StatefulSet` for `Validator`; `Deployment` for `Horizon`/`SorobanRpc` |
| Pod | `my-validator-0` | Validators always run exactly 1 replica (`spec.replicas` is not honored for this node type — see `build_statefulset`) |
| PVC | `my-validator-data` | Standalone PVC, not a StatefulSet volume-claim template — the operator creates/deletes it independently of the pod |
| Data mount | `/opt/stellar/data` (Validator) or `/data` (Horizon/SorobanRpc) | Where the ledger/bucket state lives |
| ConfigMap | `my-validator-config` | Holds the quorum-set/`CATCHUP_*` fragment the operator manages |

---

## Scenario 1: Complete Pod Failure

**Symptom**: pod is `CrashLoopBackOff`, stuck `Pending`, or repeatedly OOMKilled.

```bash
kubectl stellar status my-validator
# STATUS column shows something other than Synced/Ready
kubectl get pods -l app.kubernetes.io/instance=my-validator
```

### Diagnosis

```bash
kubectl stellar events my-validator            # operator-level events first
kubectl describe pod my-validator-0            # scheduling/OOM/image-pull detail
kubectl stellar logs my-validator --tail 200   # application-level crash reason
```

Common root causes at this point: node-level resource pressure (compare
against [resource-limits.md](../resource-limits.md)), a bad `version` bump,
or an `ImagePullBackOff` from a typo'd `spec.version`.

### Mitigation

The pod is disposable — its state lives entirely in the PVC. Just delete it;
the StatefulSet recreates it against the same `my-validator-data` volume:

```bash
kubectl delete pod my-validator-0
```

If it immediately crash-loops again with the *same* error, the cause isn't
transient (go fix the root cause found in Diagnosis — e.g. revert
`spec.version`) rather than repeating this step.

**Do not** `kubectl delete stellarnode my-validator` to "restart" it — see
the warning above. This step never needs it: a StatefulSet pod restart is
always sufficient for a pod-level failure.

### Resolution

```bash
kubectl stellar status my-validator
# STATUS: CatchingUp → Synced (Recent/Full history mode determines how long)
```

Confirm the ledger is actually advancing, not just that the pod is
`Running`:

```bash
kubectl stellar logs my-validator -f | grep -i ledger
```

---

## Scenario 2: Corrupted PVC Recovery

**Symptom**: pod is `Running` but crash-loops or hangs with on-disk
corruption signatures in the logs — bucket hash mismatches, SQLite/Postgres
"database disk image is malformed," or repeated panics immediately after
the container starts (as opposed to Scenario 1's scheduling/OOM signatures).

### Diagnosis

```bash
kubectl stellar logs my-validator --tail 500 | grep -iE "corrupt|malformed|bucket.*mismatch|panic"
kubectl stellar debug my-validator                       # exec in if the container is up long enough
# inside: du -sh /opt/stellar/data ; ls -la /opt/stellar/data
```

If the container restarts too fast to exec into, use an ephemeral debug
container against the same pod instead:

```bash
kubectl stellar debug my-validator --ephemeral
```

### Mitigation

The PVC is a standalone resource — you can delete and let the operator
recreate it **without ever touching the `StellarNode`**. Do this in order,
not by deleting the CR:

```bash
# 1. Stop the workload first — scaling to 0 also disables auto-remediation,
#    so it can't race you and restart the pod mid-wipe.
kubectl patch stellarnode my-validator --type=merge -p '{"spec":{"suspended":true}}'
kubectl wait --for=delete pod/my-validator-0 --timeout=120s

# 2. Now that nothing has the PVC mounted, delete it directly.
#    This does NOT go through the StellarNode finalizer or retentionPolicy —
#    those only fire on StellarNode deletion, not on a direct PVC delete —
#    so this works the same regardless of retentionPolicy.
kubectl delete pvc my-validator-data

# 3. Resume. The operator's ensure_pvc reconciliation recreates
#    my-validator-data fresh, then scales the StatefulSet back to 1.
kubectl patch stellarnode my-validator --type=merge -p '{"spec":{"suspended":false}}'
```

If you only suspect *partial* corruption and have a known-good CSI snapshot,
restore from that instead of a full wipe — see
[Volume Snapshots](../volume-snapshots.md) — and skip straight to Resolution.

### Resolution

A fresh PVC has no ledger state, so the pod boots into whatever your
`historyMode` implies (see table below) and starts a full or
recent-history catchup — expect `CatchingUp` for longer than a normal
restart:

```bash
kubectl stellar status my-validator
kubectl stellar logs my-validator -f | grep -i "catchup\|ledger"
```

| `spec.historyMode` | Config the operator generates | What happens on a fresh volume |
|---|---|---|
| `Recent` (default) | `CATCHUP_COMPLETE=false`, `CATCHUP_RECENT=60480` | Catches up ~60,480 ledgers (≈3.5 days at current ledger-close time) from history archives, then tracks live |
| `Full` | `CATCHUP_COMPLETE=true` | Replays the entire chain from genesis via history archives — can take hours to days depending on network age; this is the deliberate choice for a full-history archive node, not something to switch to casually mid-incident |

---

## Scenario 3: Total Quorum Loss (forcing a sync from archives)

**Symptom**: the node runs and the pod is healthy, but `syncState` never
reaches `Synced` — it sits in `CatchingUp` (or `Unknown`) indefinitely, and
the auto-remediation restart (see above) didn't help. Stellar Core's own
logs are the primary signal here; `status.syncState` only has three values
(`CatchingUp` / `Synced` / `Unknown`) and doesn't distinguish "still
replaying history" from "can't reach quorum," so you must read the logs:

```bash
kubectl stellar logs my-validator --tail 500 | grep -iE "quorum|out of sync|SCP"
```

Look for the node stuck reporting the same ledger for an extended period
with quorum-related warnings, rather than steadily incrementing ledger
numbers (which would just mean a slow catchup, not quorum loss).

### Diagnosis

1. **Is the configured quorum set still valid?** A partition or a peer
   rotation can leave `validatorConfig.quorumSet` pointing at validators
   that are gone or unreachable:
   ```bash
   kubectl get stellarnode my-validator -o jsonpath='{.spec.validatorConfig.quorumSet}'
   ```
2. **Are the configured history archives reachable?** (needed for the
   resync in Mitigation regardless of the quorum-set outcome):
   ```bash
   kubectl get stellarnode my-validator -o jsonpath='{.spec.validatorConfig.historyArchiveUrls}'
   for url in $(kubectl get stellarnode my-validator -o jsonpath='{.spec.validatorConfig.historyArchiveUrls[*]}'); do
     curl -sf -o /dev/null -w "%{http_code} $url/.well-known/stellar-history.json\n" "$url/.well-known/stellar-history.json"
   done
   ```
3. **Has the network's canonical quorum configuration changed** (e.g. a
   Tier-1 validator rotated keys)? Cross-check against
   [Peer Discovery](../peer-discovery.md) and the network's published
   quorum configuration before assuming *your* config is at fault.

### Mitigation

If the quorum set is stale, fix it first — a resync won't help a node that
still can't agree with its peers once caught up:

```bash
kubectl patch stellarnode my-validator --type=merge -p '{
  "spec": {
    "validatorConfig": {
      "quorumSet": "[QUORUM_SET]\nTHRESHOLD_PERCENT=67\nVALIDATORS=[\n  \"$sdf1\", \"$sdf2\", \"$sdf3\"\n]\n"
    }
  }
}'
```

Then force a clean resync from archives using the **same suspend → wipe PVC
→ resume** sequence as Scenario 2 (a node that has diverged or can't
reconcile its local ledger with the network needs to discard local state,
not just restart the process):

```bash
kubectl patch stellarnode my-validator --type=merge -p '{"spec":{"suspended":true}}'
kubectl wait --for=delete pod/my-validator-0 --timeout=120s
kubectl delete pvc my-validator-data
kubectl patch stellarnode my-validator --type=merge -p '{"spec":{"suspended":false}}'
```

**Never** hand-edit ledger state files inside `/opt/stellar/data` to try to
"fix" a fork — that's how you end up double-signing or diverging further.
Discard the volume and let Stellar Core rebuild it from archives; that's
the whole point of history archives existing.

### Resolution

Same verification as Scenario 2, plus confirming quorum is actually being
reached (not just that ledgers are advancing during catchup):

```bash
kubectl stellar logs my-validator -f | grep -i "quorum set\|externalize"
kubectl stellar status my-validator
```

A node that reaches `Synced` and keeps advancing without further quorum
warnings has recovered. If it stalls again at the same point, the root
cause is upstream of this node (a genuinely broken network-wide quorum
configuration) — escalate to the network's Tier-1 operators rather than
repeating this procedure.

---

## Recovery Mode manifest

The issue behind this runbook asks for a "Recovery Mode" that bypasses
standard readiness probes. Worth stating plainly: **by default, Stellar-K8s
pods have no Kubernetes-native readiness probe at all** —
`apply_probe_override` in `src/controller/resources.rs` only emits a probe
when you've explicitly set one under `spec.probes`; with no override, the
function returns `None` and the container has no `readinessProbe` to
bypass in the first place. Kubernetes-level readiness isn't what gates
anything here — the operator's own `status.conditions` and `syncState` are
the real signal, and `maintenanceMode`/`suspended` (not a probe override)
are what stop the operator from fighting your manual recovery steps.

The example below is for the case where *you* previously opted into a
strict custom readiness probe (e.g. gating a Service or PodDisruptionBudget
on it) and need to stop it from fighting a legitimate multi-hour resync:
[`examples/recovery-mode-validator.yaml`](../../examples/recovery-mode-validator.yaml).

---

## `kubectl stellar` command reference for incident response

| Command | Use during an incident to… |
|---|---|
| `kubectl stellar status [name] [-A]` | Check `syncState`/readiness at a glance |
| `kubectl stellar events [name] [-w]` | See operator-level events (including `AutoRemediationRestart`) |
| `kubectl stellar logs <name> [-f] [--tail N]` | Read Stellar Core / Horizon / RPC application logs |
| `kubectl stellar debug <name> [--ephemeral]` | Exec into the pod (or attach an ephemeral debug container if it won't stay up) |
| `kubectl stellar summary [-A]` | Aggregate health across every managed node — useful to confirm an incident is isolated to one node, not fleet-wide |
| `kubectl stellar explain <error_code>` | Decode a Stellar result code (e.g. `tx_bad_auth`) seen in logs |
| `kubectl stellar audit list` | Check whether a recent `kubectl patch`/config change (by you or someone else) correlates with the incident's start |

---

## References

- [`src/controller/finalizers.rs`](../../src/controller/finalizers.rs) — finalizer and `retentionPolicy` behavior
- [`src/controller/remediation.rs`](../../src/controller/remediation.rs) — auto-remediation watchdog and its `ClearAndResync` gap
- [`src/controller/resources.rs`](../../src/controller/resources.rs) — PVC/StatefulSet naming, `historyMode` → `CATCHUP_*` mapping, probe generation
- [`src/kubectl_plugin.rs`](../../src/kubectl_plugin.rs) — full `kubectl stellar` command surface
- [DR Failover Guide](../dr-failover.md) — cross-region/cross-cluster failover (a different scope from this runbook)
- [Volume Snapshots](../volume-snapshots.md) — snapshot-based restore as an alternative to a full PVC wipe
- [Resource Limits for Stellar Node Types](../resource-limits.md)
