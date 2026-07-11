/**
 * Regression tests for the stuck-flip bug: when a flip aborts with no result
 * (wallet cancel, send/confirm/settle failure), App resets `spinning` to false
 * while `result` stays null. CoinFlip's phase machine previously had no branch
 * for that state, so the `is-spinning` class — an infinite CSS animation —
 * stayed on the coin until a page refresh.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import CoinFlip from "../components/CoinFlip";
import { isUserRejection } from "../App";

afterEach(cleanup);

const coin = (container: HTMLElement): HTMLElement => container.querySelector(".coin")!;
const landedDeg = (el: HTMLElement): number => {
  const m = el.style.transform.match(/rotateY\((\d+)deg\)/);
  expect(m, `expected a landing transform, got "${el.style.transform}"`).not.toBeNull();
  return Number(m![1]);
};

describe("CoinFlip animation state", () => {
  it("spins while spinning=true", () => {
    const { container, rerender } = render(<CoinFlip result={null} spinning={false} />);
    expect(coin(container).classList.contains("is-spinning")).toBe(false);
    rerender(<CoinFlip result={null} spinning={true} />);
    expect(coin(container).classList.contains("is-spinning")).toBe(true);
  });

  it("stops spinning when the flip aborts with no result (the stuck-flip bug)", () => {
    const { container, rerender } = render(<CoinFlip result={null} spinning={true} />);
    expect(coin(container).classList.contains("is-spinning")).toBe(true);
    // Error/cancel path: App sets spinning=false and coinResult=null.
    rerender(<CoinFlip result={null} spinning={false} />);
    expect(coin(container).classList.contains("is-spinning")).toBe(false);
  });

  it("lands on the tails face when the flip resolves tails", () => {
    const { container, rerender } = render(<CoinFlip result={null} spinning={true} />);
    rerender(<CoinFlip result="tails" spinning={false} />);
    const el = coin(container);
    expect(el.classList.contains("is-spinning")).toBe(false);
    expect(landedDeg(el) % 360).toBe(180);
  });

  it("can flip again cleanly after an aborted flip", () => {
    const { container, rerender } = render(<CoinFlip result={null} spinning={true} />);
    rerender(<CoinFlip result={null} spinning={false} />); // aborted (cancel/error)
    rerender(<CoinFlip result={null} spinning={true} />); // user immediately retries
    expect(coin(container).classList.contains("is-spinning")).toBe(true);
    rerender(<CoinFlip result="heads" spinning={false} />); // retry lands heads
    const el = coin(container);
    expect(el.classList.contains("is-spinning")).toBe(false);
    expect(landedDeg(el) % 360).toBe(0);
  });
});

describe("isUserRejection", () => {
  it("matches the shapes wallets actually throw for a declined prompt", () => {
    // Phantom / Solflare via wallet-adapter's send path.
    expect(isUserRejection(new Error("User rejected the request."))).toBe(true);
    // Adapter sign-stage error class (name survives minification of instances).
    const signErr = Object.assign(new Error("signing failed"), { name: "WalletSignTransactionError" });
    expect(isUserRejection(signErr)).toBe(true);
    // EIP-1193-style code, sometimes nested.
    expect(isUserRejection({ code: 4001, message: "" })).toBe(true);
    expect(isUserRejection({ error: { code: 4001 } })).toBe(true);
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    // Message-only variants.
    expect(isUserRejection(new Error("Transaction approval denied"))).toBe(true);
    expect(isUserRejection(new Error("user cancelled"))).toBe(true);
  });

  it("does not swallow real failures", () => {
    expect(isUserRejection(new Error("Blockhash not found"))).toBe(false);
    expect(isUserRejection(new Error("Insufficient treasury (InsufficientTreasury / #6010)"))).toBe(false);
    expect(isUserRejection(new Error("failed to prepare flip"))).toBe(false);
    expect(isUserRejection({ code: -32002, message: "Transaction simulation failed" })).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});
