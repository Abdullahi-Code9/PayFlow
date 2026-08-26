use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::charge_exec;
use crate::grace;
use crate::{DataKey, Subscription};
// sync trigger
pub const MAX_BATCH_SIZE: u32 = 50;

// ─────────────────────────────────────────────────────────────
// Decode-compatibility note
// ─────────────────────────────────────────────────────────────
// `ChargeResult` is decoded off-chain by keepers, alert scripts
// (alert-failed-charges.ts), and indexers.  Its discriminant
// layout is:
//
//   Charged            = 0
//   Skipped            = 1
//   NoSubscription     = 2
//   Inactive           = 3
//   Paused             = 4
//   GracePeriodElapsed = 5
//
// When adding new variants ALWAYS append at the end so existing
// off-chain parsers continue to recognise the original codes.
// Renaming or reordering is a breaking change for all consumers.
// The golden tests in test.rs lock this layout.
/// The outcome for a single user in a batch_cancel call.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum CancelResult {
    /// Subscription was cancelled successfully.
    Cancelled,
    /// No subscription found for this address.
    NoSubscription,
    /// Subscription was already cancelled.
    AlreadyCancelled,
}

/// The outcome for a single user in a batch_charge call.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ChargeResult {
    /// Funds were transferred successfully.
    Charged,
    /// Interval has not elapsed yet — skipped without error.
    Skipped,
    /// No subscription found for this address.
    NoSubscription,
    /// Subscription is inactive (cancelled).
    Inactive,
    /// Subscription is paused.
    Paused,
    /// Grace period has elapsed.
    GracePeriodElapsed,
}

pub(crate) fn get_max_batch_size(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MaxBatchSize)
        .unwrap_or(MAX_BATCH_SIZE)
}

/// Attempts to charge each user in `users`.
///
/// Individual failures do **not** abort the batch — every address is
/// processed and its outcome is recorded in the returned `Vec`.
pub fn batch_charge(env: &Env, users: Vec<Address>) -> Vec<ChargeResult> {
    let mut results: Vec<ChargeResult> = Vec::new(env);

    let max_size = get_max_batch_size(env);
    if users.len() > max_size {
        env.panic_with_error(crate::errors::ContractError::BatchTooLarge);
    }

    let now = env.ledger().timestamp();
    let grace_period = grace::get_grace_period(env);

    for user in users.iter() {
        let key = DataKey::Subscription(user.clone());

        let sub_opt: Option<Subscription> = env.storage().persistent().get(&key);

        let result = match sub_opt {
            None => ChargeResult::NoSubscription,
            Some(mut sub) => {
                if sub.paused {
                    charge_exec::try_auto_resume(env, &user, &mut sub, now);
                }
                match charge_exec::precheck_charge(&sub, now, grace_period) {
                    Err(skip) => skip,
                    Ok(()) => {
                        charge_exec::execute_charge(env, &user, &key, &mut sub, now);
                        ChargeResult::Charged
                    }
                }
            }
        };

        results.push_back(result);
    }

    results
}

/// Bumps TTL for all provided subscriptions in one call.
/// Panics with BatchTooLarge if `users` exceeds max batch size.
/// Skips addresses without a subscription entry.
/// Returns a Vec<Address> of addresses that were extended.
pub fn batch_extend_subscription_ttl(env: &Env, users: Vec<Address>) -> Vec<Address> {
    let max_size = get_max_batch_size(env);
    if users.len() > max_size {
        env.panic_with_error(crate::errors::ContractError::BatchTooLarge);
    }

    let mut extended: Vec<Address> = Vec::new(env);
    for user in users.iter() {
        let key = DataKey::Subscription(user.clone());
        if env.storage().persistent().has(&key) {
            crate::storage::extend_subscription_ttl(env, &user);
            extended.push_back(user.clone());
        }
    }
    extended
}

pub fn batch_cancel(env: &Env, users: Vec<Address>) -> Vec<CancelResult> {
    if users.len() > crate::MAX_BATCH_PAUSE_SUBSCRIPTIONS {
        env.panic_with_error(crate::errors::ContractError::BatchTooLarge);
    }

    let mut results: Vec<CancelResult> = Vec::new(env);

    for user in users.iter() {
        let key = DataKey::Subscription(user.clone());
        let sub_opt: Option<Subscription> = env.storage().persistent().get(&key);

        let result = match sub_opt {
            None => CancelResult::NoSubscription,
            Some(sub) => {
                if !sub.active {
                    CancelResult::AlreadyCancelled
                } else {
                    crate::cancel_inner(env, &user);
                    crate::events::publish_cancelled(env, &user);
                    CancelResult::Cancelled
                }
            }
        };

        results.push_back(result);
    }

    results
}

