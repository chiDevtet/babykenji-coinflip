/**
 * GameAudio behavior tests, driven through an injected fake element factory
 * (jsdom has no working HTMLMediaElement). Covers the four required behaviors:
 * bg loop + first-gesture unlock, flip loop tied to start/stop (incl. the
 * cancel/error reset), win/lose one-shots, and the persisted global mute.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { GameAudio, useGameAudio, MUTE_STORAGE_KEY } from "../lib/audio";

class FakeAudio {
  src: string;
  preload = "";
  volume = 1;
  loop = false;
  muted = false;
  currentTime = 0;
  paused = true;
  playCalls = 0;
  srcDetached = false;
  playImpl: () => Promise<void> = () => Promise.resolve();
  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    this.paused = false;
    this.playCalls++;
    return this.playImpl();
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(name: string): void {
    if (name === "src") this.srcDetached = true;
  }
  load(): void {}
}

/** GameAudio wired to fakes, plus the fakes keyed by sound for assertions. */
function makeAudio() {
  const made: Record<string, FakeAudio> = {};
  const audio = new GameAudio(((src: string) => {
    const el = new FakeAudio(src);
    const name = src.match(/\/sounds\/(.+)\.\w+$/)![1];
    made[name] = el;
    return el as unknown as HTMLAudioElement;
  }) as ConstructorParameters<typeof GameAudio>[0]);
  return { audio, made };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
});

describe("GameAudio", () => {
  it("configures bg + flip as loops with modest bg volume", () => {
    const { audio, made } = makeAudio();
    audio.unlock();
    expect(made["bg-music"].loop).toBe(true);
    expect(made["bg-music"].volume).toBeGreaterThanOrEqual(0.3);
    expect(made["bg-music"].volume).toBeLessThanOrEqual(0.4);
    expect(made["flip"].loop).toBe(true);
    expect(made["win"].loop).toBe(false);
    expect(made["lose"].loop).toBe(false);
  });

  it("starts bg on the first page gesture and primes the effect sounds", async () => {
    const { audio, made } = makeAudio();
    audio.installUnlockListener();
    window.dispatchEvent(new Event("pointerdown"));
    expect(made["bg-music"].paused).toBe(false);
    await flush();
    // Primed: played muted inside the gesture, then parked again, unmuted.
    for (const name of ["flip", "win", "lose"]) {
      expect(made[name].playCalls).toBe(1);
      expect(made[name].paused).toBe(true);
      expect(made[name].muted).toBe(false);
    }
    // Listener is one-shot: a second gesture doesn't restart anything.
    window.dispatchEvent(new Event("pointerdown"));
    expect(made["bg-music"].playCalls).toBe(1);
  });

  it("does not start bg on unlock while muted", () => {
    localStorage.setItem(MUTE_STORAGE_KEY, "1");
    const { audio, made } = makeAudio();
    audio.unlock();
    expect(made["bg-music"].playCalls).toBe(0);
  });

  it("never lets a rejected play() escape (autoplay policy)", async () => {
    // Every element rejects play() the way a blocking autoplay policy would.
    const made: Record<string, FakeAudio> = {};
    const audio = new GameAudio(((src: string) => {
      const el = new FakeAudio(src);
      el.playImpl = () => Promise.reject(new Error("NotAllowedError"));
      made[src.match(/\/sounds\/(.+)\.\w+$/)![1]] = el;
      return el as unknown as HTMLAudioElement;
    }) as ConstructorParameters<typeof GameAudio>[0]);
    // Exercise the whole surface; an unhandled rejection would fail the run.
    audio.unlock();
    audio.startFlipLoop();
    audio.playResult(true);
    audio.setMuted(true);
    audio.setMuted(false);
    await flush();
    expect(made["bg-music"].playCalls).toBeGreaterThan(0);
  });

  it("flip loop starts and stops with the spin — including the cancel/error reset", () => {
    const { audio, made } = makeAudio();
    audio.startFlipLoop(); // spinning goes true
    expect(made["flip"].paused).toBe(false);
    audio.stopFlipLoop(); // finally{} reset: cancel, error, or landing
    expect(made["flip"].paused).toBe(true);
    expect(made["flip"].currentTime).toBe(0);
  });

  it("playResult stops the flip loop and plays the right stinger once", () => {
    const { audio, made } = makeAudio();
    audio.startFlipLoop();
    audio.playResult(true);
    expect(made["flip"].paused).toBe(true);
    expect(made["win"].playCalls).toBe(1);
    expect(made["lose"].playCalls).toBe(0);
    audio.playResult(false);
    expect(made["lose"].playCalls).toBe(1);
  });

  it("mute pauses everything, persists, and survives a 'refresh'", () => {
    const { audio, made } = makeAudio();
    audio.unlock();
    audio.startFlipLoop();
    audio.setMuted(true);
    expect(made["bg-music"].paused).toBe(true);
    expect(made["flip"].paused).toBe(true);
    expect(localStorage.getItem(MUTE_STORAGE_KEY)).toBe("1");
    // New page load: preference read back.
    const { audio: reloaded } = makeAudio();
    expect(reloaded.isMuted()).toBe(true);
    // Muted: result stingers stay silent (the element is never even created).
    const { audio: a3, made: m3 } = makeAudio();
    a3.playResult(true);
    expect(m3["win"]?.playCalls ?? 0).toBe(0);
  });

  it("unmute resumes bg (and the flip loop if the coin is mid-spin)", () => {
    const { audio, made } = makeAudio();
    audio.unlock();
    audio.startFlipLoop();
    audio.setMuted(true);
    audio.setMuted(false);
    expect(localStorage.getItem(MUTE_STORAGE_KEY)).toBe("0");
    expect(made["bg-music"].paused).toBe(false);
    expect(made["flip"].paused).toBe(false); // coin still spinning → loop resumes
    audio.stopFlipLoop();
    audio.setMuted(true);
    audio.setMuted(false);
    expect(made["flip"].paused).toBe(true); // not spinning → loop stays off
  });

  it("dispose stops playback, detaches sources, and disarms the gesture listener", () => {
    const { audio, made } = makeAudio();
    audio.installUnlockListener();
    audio.unlock();
    audio.startFlipLoop();
    audio.dispose();
    for (const el of Object.values(made)) {
      expect(el.paused).toBe(true);
      expect(el.srcDetached).toBe(true);
    }
    // A gesture after unmount must not resurrect anything.
    window.dispatchEvent(new Event("pointerdown"));
    expect(made["bg-music"].playCalls).toBe(1); // only the original unlock play
  });
});

describe("useGameAudio", () => {
  it("reads the persisted mute preference and unmounts cleanly", () => {
    localStorage.setItem(MUTE_STORAGE_KEY, "1");
    const { result, unmount } = renderHook(() => useGameAudio());
    expect(result.current.muted).toBe(true);
    unmount(); // disposes + removes the gesture listener without throwing
  });
});
