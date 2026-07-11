import { useCallback, useEffect, useState } from "react";

/**
 * Game audio manager.
 *
 * Four sounds, four behaviors:
 *  - bg    — background music; loops the entire time the game is open. Browsers
 *            block autoplay before the first user gesture, so it starts on the
 *            first click/tap/keypress anywhere on the page (or on the mute
 *            toggle if that's unmuting), and every play() rejection is caught.
 *  - flip  — loops while the coin is visually flipping. Started/stopped from
 *            the same `spinning` state the stuck-flip fix made airtight, so it
 *            can never keep looping after the coin stops (cancel/error included).
 *  - win / lose — one-shots at the moment the result is shown.
 *
 * A single mute toggle silences everything and persists across refreshes via
 * localStorage. Muting pauses the background music; unmuting resumes it (and
 * the flip loop, if the coin is mid-flip).
 *
 * Files live in frontend/public/sounds/ and are served from the site root,
 * same as the coin faces (/coin-heads.png).
 */

export const MUTE_STORAGE_KEY = "babykenji:muted";

const SOURCES = {
  bg: "/sounds/bg-music.mp3",
  flip: "/sounds/flip.wav",
  win: "/sounds/win.mp3",
  lose: "/sounds/lose.mp3",
} as const;
type SoundName = keyof typeof SOURCES;

// Background sits under the effects; the flip whoosh repeats so it stays below
// the one-shot result stingers.
const VOLUMES: Record<SoundName, number> = { bg: 0.35, flip: 0.55, win: 0.9, lose: 0.9 };

function readStoredMute(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === "1";
  } catch {
    return false; // storage unavailable (private mode etc.) — default to sound on
  }
}
function writeStoredMute(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {}
}

/** play() rejects on autoplay policy or when a pause() races a pending play().
 *  Neither may ever surface as an unhandled rejection. */
function safePlay(el: HTMLAudioElement): void {
  const p = el.play();
  if (p) p.catch(() => {});
}

/** Injectable for tests — jsdom has no working HTMLMediaElement. */
type AudioFactory = (src: string) => HTMLAudioElement;

export class GameAudio {
  private els: Record<SoundName, HTMLAudioElement> | null = null;
  private muted = readStoredMute();
  private unlocked = false; // a user gesture has blessed playback
  private flipWanted = false; // the coin is visually flipping right now
  private removeUnlock: (() => void) | null = null;

  constructor(private readonly createEl: AudioFactory = (src) => new Audio(src)) {}

  /** Lazily build the four elements (idempotent; rebuilt after dispose()). */
  private ensure(): Record<SoundName, HTMLAudioElement> {
    if (!this.els) {
      const make = (name: SoundName): HTMLAudioElement => {
        const el = this.createEl(SOURCES[name]);
        el.preload = "auto";
        el.volume = VOLUMES[name];
        return el;
      };
      this.els = { bg: make("bg"), flip: make("flip"), win: make("win"), lose: make("lose") };
      this.els.bg.loop = true;
      this.els.flip.loop = true;
    }
    return this.els;
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * First-gesture hook: start the background loop (unless muted) and prime the
   * effect elements. Priming matters on Safari, where autoplay permission is
   * per-element: win/lose fire when the backend settles — outside any gesture —
   * so each element gets one muted play()+pause() inside this gesture.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    const els = this.ensure();
    if (!this.muted) safePlay(els.bg);
    for (const name of ["flip", "win", "lose"] as const) {
      const el = els[name];
      el.muted = true;
      const p = el.play();
      if (p) {
        p.then(() => {
          // Don't yank a flip loop that legitimately started while priming.
          if (!(name === "flip" && this.flipWanted)) {
            el.pause();
            try {
              el.currentTime = 0;
            } catch {}
          }
          el.muted = false;
        }).catch(() => {
          el.muted = false;
        });
      } else {
        el.muted = false; // test fakes may return void from play()
      }
    }
  }

  /** Unlock audio on the first click/tap/keypress anywhere on the page. */
  installUnlockListener(): void {
    if (this.removeUnlock) return;
    const onGesture = () => {
      this.unlock();
      remove();
    };
    const remove = () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      this.removeUnlock = null;
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    this.removeUnlock = remove;
  }

  /** Mute/unmute ALL game audio and persist the preference. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    writeStoredMute(muted);
    const els = this.ensure();
    if (muted) {
      els.bg.pause();
      els.flip.pause();
      els.win.pause();
      els.lose.pause();
    } else {
      // The toggle click is itself a user gesture, so play() is allowed here
      // even when unmuting is the first interaction on the page.
      this.unlocked = true;
      safePlay(els.bg);
      if (this.flipWanted) safePlay(els.flip);
    }
  }

  /** Start the flip loop (called the moment the coin starts spinning). */
  startFlipLoop(): void {
    this.flipWanted = true;
    if (this.muted) return;
    const el = this.ensure().flip;
    try {
      el.currentTime = 0;
    } catch {}
    safePlay(el);
  }

  /** Stop the flip loop (coin landed, or any cancel/error reset the spin). */
  stopFlipLoop(): void {
    this.flipWanted = false;
    if (!this.els) return;
    this.els.flip.pause();
    try {
      this.els.flip.currentTime = 0;
    } catch {}
  }

  /** One-shot result stinger; always kills the flip loop first. */
  playResult(won: boolean): void {
    this.stopFlipLoop();
    if (this.muted) return;
    const el = this.ensure()[won ? "win" : "lose"];
    try {
      el.currentTime = 0;
    } catch {}
    safePlay(el);
  }

  /** Stop everything and release the elements (component unmount). */
  dispose(): void {
    if (this.removeUnlock) this.removeUnlock();
    if (this.els) {
      for (const el of Object.values(this.els)) {
        el.pause();
        // Detach the source so the browser releases the decoder/stream instead
        // of keeping an orphaned <audio> alive after navigation.
        el.removeAttribute("src");
        try {
          el.load();
        } catch {}
      }
      this.els = null;
    }
    this.unlocked = false;
    this.flipWanted = false;
  }
}

export interface GameAudioControls {
  muted: boolean;
  toggleMuted: () => void;
  startFlipLoop: () => void;
  stopFlipLoop: () => void;
  playResult: (won: boolean) => void;
}

/** React binding: owns one GameAudio for the component's lifetime, installs the
 *  first-gesture unlock listener, and tears everything down on unmount. */
export function useGameAudio(): GameAudioControls {
  const [audio] = useState(() => new GameAudio());
  const [muted, setMuted] = useState(() => audio.isMuted());

  useEffect(() => {
    audio.installUnlockListener();
    return () => audio.dispose();
  }, [audio]);

  const toggleMuted = useCallback(() => {
    const next = !audio.isMuted();
    audio.setMuted(next);
    setMuted(next);
  }, [audio]);
  const startFlipLoop = useCallback(() => audio.startFlipLoop(), [audio]);
  const stopFlipLoop = useCallback(() => audio.stopFlipLoop(), [audio]);
  const playResult = useCallback((won: boolean) => audio.playResult(won), [audio]);

  return { muted, toggleMuted, startFlipLoop, stopFlipLoop, playResult };
}
