# Deployment Guide

Covers building the FlowPay contract, deploying to Testnet and Mainnet using the provided scripts, post-deployment verification, and rollback procedures.

---

## Prerequisites

| Tool             | Version | Install                                     |
| ---------------- | ------- | ------------------------------------------- |
| Rust             | 1.70+   | `curl https://sh.rustup.rs -sSf \| sh`      |
| wasm32 target    | —       | `rustup target add wasm32-unknown-unknown`  |
| Soroban CLI      | 21.x    | `cargo install --locked soroban-cli`        |
| Node.js          | 18+     | [nodejs.org](https://nodejs.org/)           |
| Freighter Wallet | —       | [freighter.app](https://www.freighter.app/) |

Verify your setup:

```bash
rustc --version    # 1.70+
soroban --version  # 21.x
node --version     # v18+
```

---

## Build

```bash
cd contract
cargo build --release --target wasm32-unknown-unknown
```

The compiled WASM is written to `target/wasm32-unknown-unknown/release/flow_pay.wasm`.

---

## Testnet Deployment

Use `scripts/deploy.sh` to deploy to Testnet:

```bash
bash scripts/deploy.sh --network testnet --source <DEPLOYER_KEYPAIR> --token <SAC_ADDRESS>
```

The script:

1. Uploads the WASM and obtains a hash.
2. Deploys the contract and captures the contract ID.
3. Calls `initialize(token, admin)` with the provided SAC address.
4. Prints the contract ID — save it for subsequent steps.

Set the returned contract ID in `frontend/.env`:

```bash
VITE_CONTRACT_ID=<CONTRACT_ID>
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

---

## Mainnet Deployment

> **Warning:** FlowPay has not been formally audited. Do not manage real funds on Mainnet until an independent security audit is complete.

FlowPay is currently deployed on **Testnet only**. When you are ready for Mainnet, follow the full phased checklist (security gates, key management, pre-deploy verification, deploy commands, post-deploy smoke tests, and go-live):

**→ [`MAINNET-DEPLOYMENT.md`](MAINNET-DEPLOYMENT.md)**

Quick script form (only after audit + checklist Phase 0–1):

```bash
bash scripts/deploy.sh --network mainnet --source <DEPLOYER_KEYPAIR> --token <SAC_ADDRESS>
```

Set the returned contract ID in `frontend/.env`:

```bash
VITE_CONTRACT_ID=<CONTRACT_ID>
VITE_RPC_URL=https://soroban-mainnet.stellar.org
VITE_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
```

---

## Post-Deployment Verification

After deploying, run the post-deployment check script:

```bash
bash scripts/verify-contract.sh --network <testnet|mainnet> --id <CONTRACT_ID>
```

The script calls the following read functions and asserts expected values:

| Check                | Expected           |
| -------------------- | ------------------ |
| `get_schema_version` | Latest version     |
| `get_health`         | `is_healthy: true` |
| Token configured     | Non-empty address  |
| Admin configured     | Non-empty address  |

You can also run these manually:

```bash
soroban contract invoke --id <CONTRACT_ID> --network <NETWORK> -- health_check
soroban contract invoke --id <CONTRACT_ID> --network <NETWORK> -- get_protocol_stats
```

---

## State Migration

`migrate(users)` is **admin-only** (`admin::require_admin`). It takes a page of subscriber addresses. Current target is `CURRENT_VERSION` **3** in [`contract/src/migration.rs`](../contract/src/migration.rs). Already-migrated slots are no-ops; repeating `migrate` at version 3 does not bump the version again.

Paged workflow (also documented on `require_current_version` / `migrate` in that file):

1. Upgrade WASM. `schema_version` stays at the pre-upgrade value until migration finishes.
2. Page subscribers with `get_subscriber_page` (capped at 50 addresses per call).
3. Invoke `migrate` for each page.
4. Confirm `get_schema_version() == 3` before treating the instance as caught up.

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source admin \
  --network testnet \
  -- get_subscriber_page --offset 0 --limit 50

soroban contract invoke \
  --id <CONTRACT_ID> \
  --source admin \
  --network testnet \
  -- migrate --users '["<USER_ADDRESS>"]'

soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_schema_version
```

Optional helper: [`scripts/migrate-contract.ts`](../scripts/migrate-contract.ts) (`npx tsx scripts/migrate-contract.ts [--dry-run]`), using `VITE_CONTRACT_ID` / `VITE_RPC_URL` / `VITE_NETWORK_PASSPHRASE`. Prefer the CLI invokes above unless you have validated that script in your environment.

If subscription writes fail with **error 42**, follow [SchemaMigrationRequired (error 42)](#schemamigrationrequired-error-42) — do not treat it as a random subscribe bug.

### Migration History

| Version | Changes                                                                                  |
| ------- | ---------------------------------------------------------------------------------------- |
| v1      | Initial schema (`Subscription` without `paused`)                                         |
| v2      | Adds `paused`; writes `SchemaVersion`                                                    |
| v3      | Backfills `referrer` from `DataKey::Referral` (`CURRENT_VERSION`)                        |

---

## SchemaMigrationRequired (error 42)

Canonical operator note for the schema-version **write-denial** safety rail. Error-code lookup: [`ERROR-CODES.md` — 42](ERROR-CODES.md#42--schemamigrationrequired).

### Invariant

After a WASM upgrade, on-chain code knows the current `Subscription` shape (`CURRENT_VERSION` = 3), but unmigrated slots may still hold v1/v2 blobs. The intended rail is: **refuse new subscription-blob writes until `get_schema_version() == CURRENT_VERSION`**, so operators paging through `migrate()` never mix freshly written current-version blobs with stale ones.

This is the comment on `migration::require_current_version` in [`contract/src/migration.rs`](../contract/src/migration.rs):

> Invariant guard: panics with `ContractError::SchemaMigrationRequired` when `schema_version < CURRENT_VERSION`. Call this at the top of any entrypoint that writes new subscription blobs (e.g. `subscribe_inner`) so that mixed-version storage can never be created after a WASM upgrade.

`require_current_version` panics with **code 42** when `get_schema_version() < 3`. The helper is the source of the typed error. Intended write surfaces are **`subscribe` / `subscribe_with_metadata`** (they share `subscribe_inner`). `migrate` does **not** call this guard.

### How to recognize it

- User or integrator `subscribe` / `subscribe_with_metadata` panics with `SchemaMigrationRequired` / Soroban error **42** (GitHub issue discussions may call this “#42”).
- `get_schema_version` returns `0`, `1`, or `2` (unset defaults to **0**).
- `contract_health_check` / `get_protocol_stats` report a `schema_version` below 3.

This is **intentional**, not a keeper or wallet defect.

### Remedy (order)

1. Confirm version: `get_schema_version` (and optional `contract_health_check`).
2. Keep **admin** access — you still need it for `migrate`.
3. Run the [paged `migrate(users)` procedure](#state-migration) until `get_schema_version() == 3`.
4. Retry the subscription write.

Do not redeploy a new contract ID solely because of 42. Do not skip paging on a large `SubscriberIndex`.

### Admin paths while the rail is active

`require_current_version` is not applied to administrative entrypoints. While schema is stale, operators can still:

| Still available (not gated by 42) | Role |
| --------------------------------- | ---- |
| `migrate(users)`                  | The catch-up entrypoint (admin) |
| `propose_upgrade` / `commit_upgrade` / `cancel_pending_upgrade` | WASM ceremony |
| `pause_contract` / `unpause_contract` | Incident control |
| Whitelist / freeze / fee propose-commit | Merchant and fee admin |
| `get_schema_version`, `get_subscriber_page`, `contract_health_check`, `get_protocol_stats` | Reads |

Keepers charging **existing** subscriptions are a separate path: they do not go through `require_current_version`. After a layout-changing upgrade, still migrate before relying on new fields (`paused`, `referrer`).

---

## Contract Upgrade (WASM)

```bash
# 1. Upload new WASM
soroban contract upload \
  --source deployer \
  --network <NETWORK> \
  --wasm target/wasm32-unknown-unknown/release/flow_pay.wasm

# 2. Upgrade the deployed contract
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network <NETWORK> \
  -- upgrade <NEW_WASM_HASH>

# 3. Run paged migration if storage layout changed (see State Migration)
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source admin \
  --network <NETWORK> \
  -- migrate --users '["<USER_ADDRESS>"]'
```

An `upgraded` event is emitted on success.

---

## Rollback Procedure

FlowPay does not support automatic rollback. To revert to a previous WASM:

1. **Retrieve the previous WASM hash** from the `upgraded` event emitted at the time of the last deployment (use `soroban events` or your indexer DB).
2. **Re-upload the previous WASM** if needed (if the hash is still on-chain, skip this step):
   ```bash
   soroban contract upload --source deployer --network <NETWORK> --wasm <previous.wasm>
   ```
3. **Upgrade back to the previous hash**:
   ```bash
   soroban contract invoke \
     --id <CONTRACT_ID> \
     --source deployer \
     --network <NETWORK> \
     -- upgrade <PREVIOUS_WASM_HASH>
   ```
4. **Run migration** if the restored WASM still requires schema catch-up (paged `migrate(users)` — [State Migration](#state-migration)):
   ```bash
   soroban contract invoke --id <CONTRACT_ID> --source admin --network <NETWORK> -- migrate --users '["<USER_ADDRESS>"]'
   ```
5. **Verify** the rollback using `verify-contract.sh`.

> Note: Storage written by the newer WASM version remains on-chain. If the rollback WASM reads keys introduced by the newer version, those reads will return `None` or the default value — existing subscription data is unaffected.

---

## Frontend Environment Variables

| Variable                  | Required | Default                               | Description                |
| ------------------------- | -------- | ------------------------------------- | -------------------------- |
| `VITE_CONTRACT_ID`        | Yes      | `""`                                  | Deployed contract ID       |
| `VITE_RPC_URL`            | No       | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint       |
| `VITE_NETWORK_PASSPHRASE` | No       | `Networks.TESTNET`                    | Stellar network passphrase |

---

## Related operations

- Keeper bot setup and cadence: [`docs/KEEPER.md`](KEEPER.md)
- Advanced keeper scenarios (DLQ replay, multi-instance locks, RPC failover, incident pause): [`docs/operations/keeper_runbook.md`](operations/keeper_runbook.md)
