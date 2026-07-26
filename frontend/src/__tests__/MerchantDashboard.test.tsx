import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("../stellar");
vi.mock("../hooks/usePolling", () => ({ usePolling: () => {} }));

// MerchantSubscriberTable uses CopyButton — mock it to keep tests simple
vi.mock("../components/CopyButton", () => ({
  default: ({ ariaLabel }: { ariaLabel?: string }) => (
    <button aria-label={ariaLabel ?? "Copy"}>Copy</button>
  ),
}));

import * as stellar from "../stellar";
import MerchantDashboard from "../components/MerchantDashboard";

const NOW = Math.floor(Date.now() / 1000);

const SAMPLE_SUBSCRIBER = {
  subscriber: "GTESTER000000000000000000000000000000000000000000",
  amount: "10000000",
  interval: 2592000,
  lastCharged: NOW - 2592000,
  nextChargeAt: NOW + 2592000, // future → active
};

describe("MerchantDashboard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders active subscribers with formatted values and copy buttons", async () => {
    vi.mocked(stellar.getMerchantSubscribers).mockResolvedValue([SAMPLE_SUBSCRIBER]);

    render(<MerchantDashboard merchantKey="GMERCHANT" refreshTrigger={0} />);

    await waitFor(() => expect(screen.getByText(/Merchant Subscribers/)).toBeTruthy());

    // Table renders truncated address via formatAddress(addr, 8, 6)
    expect(screen.getByText("GTESTER0…000000")).toBeTruthy();
    // Amount column shows XLM value
    expect(screen.getByText("1.0000000 XLM")).toBeTruthy();
    // Status badge shows Active (nextChargeAt is in the future)
    expect(screen.getByText("Active")).toBeTruthy();
    // CopyButton rendered for the subscriber address
    expect(
      screen.getByRole("button", {
        name: /copy subscriber address GTESTER000000000000000000000000000000000000000000/i,
      })
    ).toBeTruthy();
  });

  it("shows an empty state when there are no active subscribers", async () => {
    vi.mocked(stellar.getMerchantSubscribers).mockResolvedValue([]);

    render(<MerchantDashboard merchantKey="GMERCHANT" refreshTrigger={0} />);

    await waitFor(() =>
      expect(screen.getByText(/No subscribers yet/i)).toBeTruthy()
    );
  });
});
