import React, { useEffect, useMemo, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { buildSubscribeTx, DEFAULT_TOKEN } from "../stellar";
import { friendlyError } from "../utils/errors";
import { STROOPS_PER_XLM, BILLING_INTERVALS } from "../constants";
import { useFormValidation } from "../hooks/useFormValidation";
import { useToast } from "../hooks/useToast";
import { useTransaction } from "../hooks/useTransaction";
import { getReferrerFromSearch } from "./ReferralPanel";
import AllowanceDisplay from "./AllowanceDisplay";
import ToastContainer from "./Toast";

interface Props {
  userKey: string;
  onSign: (xdr: string) => Promise<string>;
  onSuccess: () => void;
  announce: (message: string) => void;
}

export default function SubscribeForm({ userKey, onSign, onSuccess, announce }: Props) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [interval, setInterval] = useState(BILLING_INTERVALS[2].value);
  const [referrer, setReferrer] = useState("");
  const [referrerError, setReferrerError] = useState<string | null>(null);
  const { errors, validate } = useFormValidation();
  const { toasts, addToast, removeToast } = useToast();
  const tx = useTransaction();

  // Pre-fill referrer from ?ref= URL query param (Issue #661)
  useEffect(() => {
    const refParam = getReferrerFromSearch(window.location.search);
    if (!refParam) return;

    // Warn if the ref param equals the connected user (self-referral)
    if (refParam === userKey) {
      setReferrerError("Self-referral is not allowed — the contract will ignore it.");
      return;
    }

    // Validate it looks like a Stellar address before pre-filling
    if (StrKey.isValidEd25519PublicKey(refParam)) {
      setReferrer(refParam);
    }
  }, [userKey]);

  function validateReferrer(value: string): string | null {
    if (!value) return null; // optional field
    if (value === userKey) return "Self-referral is not allowed.";
    if (!StrKey.isValidEd25519PublicKey(value)) {
      return "Invalid Stellar address format";
    }
    return null;
  }

  function handleReferrerChange(value: string) {
    setReferrer(value);
    setReferrerError(validateReferrer(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate({ merchant, amount, interval })) return;

    const refErr = validateReferrer(referrer);
    if (refErr) {
      setReferrerError(refErr);
      return;
    }

    announce("Transaction submitted");
    const hash = await tx.submit(async () => {
      const stroops = BigInt(Math.round(parseFloat(amount) * STROOPS_PER_XLM));
      const refAddr = referrer && StrKey.isValidEd25519PublicKey(referrer) ? referrer : null;
      const xdr = await buildSubscribeTx(
        userKey,
        merchant,
        stroops,
        BigInt(interval),
        DEFAULT_TOKEN,
        refAddr,
        ""
      );
      return onSign(xdr);
    });

    if (hash) {
      addToast("Subscribed!", "success", hash);
      announce("Transaction confirmed");
      onSuccess();
    } else if (tx.error) {
      const msg = `Error: ${friendlyError(tx.error)}`;
      addToast(msg, "error");
      announce(msg);
    }
  }

  const amountStroops = useMemo(() => {
    const parsed = parseFloat(amount);
    if (!amount || Number.isNaN(parsed) || parsed <= 0) return 0n;
    return BigInt(Math.round(parsed * STROOPS_PER_XLM));
  }, [amount]);

  const pending = tx.status === "pending";

  return (
    <form onSubmit={handleSubmit} className="subscribe-form">
      <h2 className="subscribe-form__title">New Subscription</h2>

      <label className="form-group">
        <span className="form-label">Merchant address</span>
        <input
          placeholder="G…"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          required
        />
        {errors.merchant && <span className="text-error">{errors.merchant}</span>}
      </label>

      <label className="form-group">
        <span className="form-label">Amount (XLM per period)</span>
        <input
          type="number"
          min="0.0000001"
          step="0.0000001"
          placeholder="5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
        {errors.amount && <span className="text-error">{errors.amount}</span>}
        {userKey && (
          <AllowanceDisplay
            userKey={userKey}
            subscriptionAmount={amountStroops}
            refreshTrigger={0}
          />
        )}
      </label>

      <label className="form-group">
        <span className="form-label">Billing interval</span>
        <select value={interval} onChange={(e) => setInterval(Number(e.target.value))}>
          {BILLING_INTERVALS.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
        {errors.interval && <span className="text-error">{errors.interval}</span>}
      </label>

      {/* Referrer field — pre-filled from ?ref= URL param (Issue #661) */}
      <label className="form-group">
        <span className="form-label">
          Referrer address{" "}
          <span className="text-muted" style={{ fontWeight: "normal" }}>
            (optional)
          </span>
        </span>
        <input
          placeholder="G… (optional)"
          value={referrer}
          onChange={(e) => handleReferrerChange(e.target.value)}
          aria-label="Referrer Stellar address (optional)"
          aria-describedby={referrerError ? "referrer-error" : undefined}
          aria-invalid={!!referrerError}
          data-testid="referrer-input"
        />
        {referrerError && (
          <span
            id="referrer-error"
            className="text-error"
            role="alert"
            data-testid="referrer-error"
          >
            {referrerError}
          </span>
        )}
      </label>

      <button type="submit" disabled={pending} className="btn-primary subscribe-form__submit">
        {pending ? "Confirming…" : "Subscribe"}
      </button>

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </form>
  );
}
