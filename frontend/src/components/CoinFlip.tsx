import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "spinning" | "landing";

interface Props {
  /** "heads" | "tails" once known, else null */
  result: "heads" | "tails" | null;
  spinning: boolean;
}

/**
 * The coin shows two husky faces (heads = front, tails = rear). While `spinning`
 * is true it whirls on a CSS keyframe; once the result is known the parent flips
 * `spinning` to false and the coin eases to rest on the correct face.
 */
export default function CoinFlip({ result, spinning }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [deg, setDeg] = useState(0);
  const turns = useRef(0); // accumulated full turns, always increasing

  useEffect(() => {
    if (spinning) {
      setPhase("spinning");
      return;
    }
    if (result) {
      // Land: add several turns then the face offset (tails = 180°).
      turns.current += 6;
      const faceOffset = result === "tails" ? 180 : 0;
      setDeg(turns.current * 360 + faceOffset);
      setPhase("landing");
      return;
    }
    // Spin ended with NO result — wallet cancel, failed send/confirm, or a
    // settle error. Return to rest; without this branch the phase stayed
    // "spinning" and the is-spinning class (an infinite CSS animation) kept the
    // coin whirling until a page refresh.
    setPhase("idle");
  }, [spinning, result]);

  return (
    <div className="coin-stage">
      <div className="coin-shadow" />
      <div
        className={`coin ${phase === "spinning" ? "is-spinning" : ""}`}
        style={phase === "landing" ? { transform: `rotateY(${deg}deg)` } : undefined}
      >
        <div className="coin-face coin-heads">
          <img src="/coin-heads.png" alt="Heads — husky face" draggable={false} />
        </div>
        <div className="coin-face coin-tails">
          <img src="/coin-tails.png" alt="Tails — husky rear" draggable={false} />
        </div>
        <div className="coin-edge" />
      </div>
    </div>
  );
}
