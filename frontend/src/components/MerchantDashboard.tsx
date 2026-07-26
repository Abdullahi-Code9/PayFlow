import React, { useCallback, useEffect, useState } from "react";
import { getMerchantSubscribers, type MerchantSubscriber } from "../stellar";
import { formatAddress } from "../utils/format";
import { usePolling } from "../hooks/usePolling";
import MerchantSubscriberTable from "./MerchantSubscriberTable";

interface Props {
  merchantKey: string;
  refreshTrigger: number;
}

export default function MerchantDashboard({
  merchantKey,
  refreshTrigger,
}: Props) {
  const [subscribers, setSubscribers] = useState<MerchantSubscriber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSubscribers((prev) => {
      if (prev.length === 0) setLoading(true);
      return prev;
    });
    setError(null);

    try {
      const data = await getMerchantSubscribers(merchantKey);
      setSubscribers(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [merchantKey]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshTrigger]);

  usePolling({ callback: refresh, interval: 30000, enabled: true });

  if (loading) {
    return (
      <div className="dashboard">
        <p className="text-muted">Loading merchant subscribers…</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="flex-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Merchant Subscribers</h2>
          <p className="text-sm text-muted">
            Subscribers paying {formatAddress(merchantKey)}.
          </p>
        </div>
        <button className="btn-secondary" onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && (
        <p className="action-status" style={{ color: "var(--color-danger)" }}>
          Error: {error}
        </p>
      )}

      <div className="card">
        {subscribers.length > 0 && (
          <p className="text-sm text-muted mb-4">
            {subscribers.length} subscriber{subscribers.length !== 1 ? "s" : ""} found
          </p>
        )}
        <MerchantSubscriberTable subscribers={subscribers} />
      </div>
    </div>
  );
}
