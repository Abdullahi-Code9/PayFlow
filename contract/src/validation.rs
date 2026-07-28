use soroban_sdk::{token, Address, Env};

use crate::errors::ContractError;
use crate::Subscription;

/// Validates that `addr` is not the contract's own address.
/// Panics with `ContractError::InvalidFeeCollector` if they match.
/// Must be called before storing any address that will receive token transfers.
pub fn validate_recipient_address(env: &Env, addr: &Address) {
    if addr == &env.current_contract_address() {
        env.panic_with_error(ContractError::InvalidFeeCollector);
    }
}

/// Verifies that `user` has granted the contract an allowance of at least
/// `min_amount` for `token`. Panics with `ContractError::InsufficientAllowance`
/// if the check fails.
pub fn check_allowance(env: &Env, user: &Address, token: &Address, min_amount: i128) {
    let client = token::Client::new(env, token);
    let allowance = client.allowance(user, &env.current_contract_address());
    if allowance < min_amount {
        env.panic_with_error(ContractError::InsufficientAllowance);
    }
}

/// Composable helper that asserts a subscription is ready to be used:
/// the subscription must be active and the user must have sufficient
/// allowance for the subscription's token and amount.
pub fn validate_subscription_readiness(env: &Env, user: &Address, sub: &Subscription) {
    if !sub.active {
        env.panic_with_error(ContractError::SubscriptionNotActive);
    }
    check_allowance(env, user, &sub.token, sub.amount);
}

/// Validates that `new_amount` is a legal subscription amount: must be positive
/// and must not exceed `MAX_SUBSCRIPTION_AMOUNT`. Panics with the appropriate
/// `ContractError` variant on failure.
pub fn require_valid_amount(env: &Env, new_amount: i128) {
    if new_amount <= 0 {
        env.panic_with_error(ContractError::AmountMustBePositive);
    }
    if new_amount > crate::MAX_SUBSCRIPTION_AMOUNT {
        env.panic_with_error(ContractError::AmountExceedsMaximum);
    }
}

/// Validates that `new_interval` is a legal subscription interval: must be
/// strictly greater than zero. Panics with `ContractError::IntervalTooShort`
/// if the floor is not met.
pub fn require_valid_interval(env: &Env, new_interval: u64) {
    if new_interval == 0 {
        env.panic_with_error(ContractError::IntervalTooShort);
    }
}

pub fn require_positive_amount(amount: i128) {
    assert!(amount > 0, "amount must be positive");
}

pub fn require_positive_interval(interval: u64) {
    assert!(interval > 0, "interval must be positive");
}

pub fn require_active_subscription(active: bool) {
    assert!(active, "subscription is not active");
}

pub fn require_charge_interval_elapsed(now: u64, last_charged: u64, interval: u64) {
    assert!(now >= last_charged + interval, "interval not elapsed yet");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_require_positive_amount_accepts_positive() {
        require_positive_amount(1);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_require_positive_amount_panics_on_zero() {
        require_positive_amount(0);
    }

    #[test]
    fn test_require_positive_interval_accepts_positive() {
        require_positive_interval(60);
    }

    #[test]
    #[should_panic(expected = "interval must be positive")]
    fn test_require_positive_interval_panics_on_zero() {
        require_positive_interval(0);
    }

    #[test]
    fn test_require_active_subscription_accepts_true() {
        require_active_subscription(true);
    }

    #[test]
    #[should_panic(expected = "subscription is not active")]
    fn test_require_active_subscription_panics_on_false() {
        require_active_subscription(false);
    }

    #[test]
    fn test_require_charge_interval_elapsed_accepts_elapsed_interval() {
        require_charge_interval_elapsed(100, 40, 60);
    }

    #[test]
    #[should_panic(expected = "interval not elapsed yet")]
    fn test_require_charge_interval_elapsed_panics_if_too_early() {
        require_charge_interval_elapsed(99, 40, 60);
    }
}
