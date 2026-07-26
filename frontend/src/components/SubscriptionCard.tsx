/**
 * SubscriptionCard — displays an active subscription with allowance health indicator.
 *
 * Allowance health tiers (Issue #659):
 *  - allowance === 0          → red   "No allowance — charges will fail"
 *  - allowance < amount       → amber "Allowance too low"
 *  - allowance >= amount * 3  → green "Healthy"
 *  - query failed             → neutral "Unknown"
 *
 * Clicking an amber/red/unknown badge opens IncreaseAllowanceModal.
 */
import React, { useEffect, useState } from "react";
import CopyButton from "./CopyButton";
import NextChargeCountdown from "./NextChargeCountdown";
import IncreaseAllowanceModal from "./IncreaseAllowanceModal";
import { Subscription } from "../types";
import { BILLING_INTERVALS, STROOPS_PER_XLM } from "../constants";
import { getAllowance } from "../stellar";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AllowanceHealth = "healthy" | "low" | "none" | "unknown";

interface SubscriptionCardProps {
  subscription: Subscription;
  userKey: string;
  onCancel: () => void;
  onPause: (xdr: string) => Promise<string>;
  onRefresh: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatInterval(secs: number): string {
  const monthly = BILLING_INTERVALS[2].value;
  const weekly = BILLING_INTERVALS[1].value;
  const daily = BILLING_INTERVALS[0].value;
  if (secs >= monthly) return `${Math.round(secs / monthly)}mo`;
  if (secs >= weekly) return `${Math.round(secs / weekly)}w`;
  if (secs >= daily) return `${Math.round(secs / daily)}d`;
  return `${secs}s`;
}

function formatTrialStatus(
  trial_duration: number,
  last_charged: number
): { isInTrial: boolean; trialEndDate: string; trialDaysRemaining: number } {
  if (trial_duration === 0) {
    return { isInTrial: false, trialEndDate: "", trialDaysRemaining: 0 };
  }
  const trialEndTimestamp = last_charged + trial_duration;
  const now = Math.floor(Date.now() / 1000);
  const isInTrial = now < trialEndTimestamp;
  const trialEndDate = new Date(trialEndTimestamp * 1000).toLocaleDateString();
  const trialDaysRemaining = Math.max(
    0,
    Math.ceil((trialEndTimestamp - now) / (24 * 60 * 60))
  );
  return { isInTrial, trialEndDate, trialDaysRemaining };
}

/**
 * Compute the allowance health tier given the raw allowance and subscription
 * amount (both in stroops).
 */
export function computeAllowanceHealth(
  allowance: bigint | null,
  amount: bigint
): AllowanceHealth {
  if (allowance === null) return "unknown";
  if (allowance === 0n) return "none";
  if (allowance < amount) return "low";
  if (amount > 0n && allowance >= amount * 3n) return "healthy";
  // allowance >= amount but < 3x — still considered "low" (not enough for 3 charges)
  return "low";
}

// ── AllowanceHealthBadge ──────────────────────────────────────────────────────

interface AllowanceHealthBadgeProps {
  health: AllowanceHealth;
  loading: boolean;
  onClick: () => void;
}

function AllowanceHealthBadge({ health, loading, onClick }: AllowanceHealthBadgeProps) {
  if (loading) {
    return (
      <span
        className="allowance-health-badge allowance-health-badge--unknown"
        aria-label="Checking allowance…"
      >
        Checking…
      </span>
    );
  }

  if (health === "healthy") {
    return (
      <span
        className="allowance-health-badge allowance-health-badge--healthy"
        aria-label="Allowance is healthy"
        data-testid="allowance-badge-healthy"
      >
        ✓ Healthy
      </span>
    );
  }

  // Clickable badges for actionable states
  const label =
    health === "none"
      ? "No allowance — charges will fail"
      : health === "low"
      ? "Allowance too low"
      : "Allowance unknown";

  const className =
    health === "none"
      ? "allowance-health-badge allowance-health-badge--none"
      : health === "low"
      ? "allowance-health-badge allowance-health-badge--low"
      : "allowance-health-badge allowance-health-badge--unknown";

  return (
    <button
      className={className}
      onClick={onClick}
      aria-label={`${label}. Click to increase allowance.`}
      data-testid={`allowance-badge-${health}`}
    >
      {health === "none" ? "⚠ No allowance — charges will fail" : health === "low" ? "⚠ Allowance too low" : "? Allowance unknown"}
    </button>
  );
}

// ── SubscriptionCard ──────────────────────────────────────────────────────────

export default function SubscriptionCard({
  subscription,
  userKey,
  onCancel,
  onPause,
  onRefresh,
}: SubscriptionCardProps) {
  const { merchant, amount, interval, last_charged, active, paused, trial_duration } =
    subscription;
  const nextChargeTimestamp = last_charged + interval;
  const xlm = (Number(amount) / STROOPS_PER_XLM).toFixed(2);
  const { isInTrial } = formatTrialStatus(trial_duration || 0, last_charged);

  // ── Pause / resume state ───────────────────────────────────────────────────
  const [showPauseConfirm, setShowPauseConfirm] = React.useState(false);
  const [pauseLoading, setPauseLoading] = React.useState(false);
  const [resumeLoading, setResumeLoading] = React.useState(false);
  const [pauseStatus, setPauseStatus] = React.useState("");

  // ── Allowance health state ─────────────────────────────────────────────────
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [allowanceLoading, setAllowanceLoading] = useState(true);
  const [showAllowanceModal, setShowAllowanceModal] = useState(false);

  const amountBigInt = BigInt(amount);
  const health = computeAllowanceHealth(allowance, amountBigInt);

  useEffect(() => {
    if (!active) return; // no point checking allowance on cancelled subs
    setAllowanceLoading(true);
    getAllowance(userKey)
      .then((val) => setAllowance(val))
      .catch(() => setAllowance(null)) // RPC error → "unknown" state
      .finally(() => setAllowanceLoading(false));
  }, [userKey, active]);

  // ── Pause / Resume handlers ────────────────────────────────────────────────
  const handlePause = async () => {
    setPauseLoading(true);
    setPauseStatus("");
    try {
      const { buildPauseTx } = await import("../stellar");
      const xdr = await buildPauseTx(userKey);
      await onPause(xdr);
      setPauseStatus("Paused successfully.");
      setShowPauseConfirm(false);
      onRefresh();
    } catch (e: unknown) {
      setPauseStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPauseLoading(false);
    }
  };

  const handleResume = async () => {
    setResumeLoading(true);
    setPauseStatus("");
    try {
      const { buildResumeTx } = await import("../stellar");
      const xdr = await buildResumeTx(userKey);
      await onPause(xdr);
      setPauseStatus("Resumed successfully.");
      onRefresh();
    } catch (e: unknown) {
      setPauseStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResumeLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="subscription-card__header">
        <div>
          <h2 className="subscription-card__title">Your Subscription</h2>
          {subscription.label && (
            <p className="subscription-card__label">{subscription.label}</p>
          )}
        </div>
        <span className={`badge ${active ? "badge-active" : "badge-inactive"}`}>
          {active ? (isInTrial ? "Trial Active" : "Active") : "Cancelled"}
        </span>
      </div>

      {/* Allowance health indicator — only shown for active subscriptions */}
      {active && (
        <div className="allowance-health-row">
          <span className="text-sm text-muted">Allowance:</span>
          <AllowanceHealthBadge
            health={health}
            loading={allowanceLoading}
            onClick={() => setShowAllowanceModal(true)}
          />
        </div>
      )}

      <div className="subscription-rows">
        <div className="subscription-row">
          <span className="subscription-row__label">Merchant</span>
          <div className="merchant-row">
            <span className="merchant-row__address">
              {`${merchant.slice(0, 8)}…${merchant.slice(-6)}`}
            </span>
            <CopyButton text={merchant} ariaLabel="Copy merchant address" />
          </div>
        </div>
        <Row label="Amount" value={`${xlm} XLM`} />
        <Row label="Interval" value={formatInterval(interval)} />
        <div className="subscription-row">
          <span className="subscription-row__label">Next charge</span>
          <span className="subscription-row__value">
            {active ? (
              <NextChargeCountdown nextChargeTimestamp={nextChargeTimestamp} />
            ) : (
              "—"
            )}
          </span>
        </div>
      </div>

      <div className="subscription-card__actions">
        {active && !paused && (
          <>
            <button
              onClick={() => setShowPauseConfirm(true)}
              className="btn-secondary pause-btn"
            >
              Pause
            </button>
            <button
              onClick={onCancel}
              className="btn-danger cancel-btn"
              aria-label="Cancel subscription"
            >
              Cancel
            </button>
          </>
        )}
        {active && paused && (
          <>
            <button
              onClick={handleResume}
              disabled={resumeLoading}
              className="btn-primary resume-btn"
            >
              {resumeLoading ? "Resuming…" : "Resume"}
            </button>
            <button
              onClick={onCancel}
              className="btn-danger cancel-btn"
              aria-label="Cancel subscription"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {/* Pause confirm modal */}
      {showPauseConfirm && (
        <div
          className="modal-overlay"
          onClick={() => setShowPauseConfirm(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Pause subscription?</h3>
            <p>You won't be charged while paused. You can resume anytime.</p>
            <div className="modal-actions">
              <button
                onClick={() => setShowPauseConfirm(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handlePause}
                disabled={pauseLoading}
                className="btn-primary"
              >
                {pauseLoading ? "Pausing…" : "Pause"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Increase allowance modal — opened by clicking a warning badge */}
      {showAllowanceModal && (
        <IncreaseAllowanceModal
          userKey={userKey}
          subscriptionAmount={amountBigInt}
          onSign={onPause}
          onClose={() => setShowAllowanceModal(false)}
          onSuccess={() => {
            setShowAllowanceModal(false);
            // Re-fetch allowance after successful approval
            setAllowanceLoading(true);
            getAllowance(userKey)
              .then(setAllowance)
              .catch(() => setAllowance(null))
              .finally(() => setAllowanceLoading(false));
          }}
          announce={() => {}}
        />
      )}

      {pauseStatus && (
        <p
          className="form-status"
          style={{
            color: pauseStatus.startsWith("Error")
              ? "var(--color-danger)"
              : "var(--color-success)",
          }}
        >
          {pauseStatus}
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="subscription-row">
      <span className="subscription-row__label">{label}</span>
      <span className="subscription-row__value">{value}</span>
    </div>
  );
}
