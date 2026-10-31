import React from 'react';
import { Zap, FastForward, Rewind, Play } from 'lucide-react';

interface SpeedCapsuleHUDProps {
  visible: boolean;
  speed: number;
  progress: number;
  minimized?: boolean;
}

export const DISCRETE_HOLD_SPEEDS = [0.5, 1.0, 2.0, 3.0];

export const SpeedCapsuleHUD: React.FC<SpeedCapsuleHUDProps> = ({
  visible,
  speed,
  minimized = false,
}) => {
  if (!visible) return null;

  // Snap strictly to nearest discrete speed point (0.5x, 1.0x, 2.0x, 3.0x)
  const snappedSpeed = DISCRETE_HOLD_SPEEDS.reduce((prev, curr) =>
    Math.abs(curr - speed) < Math.abs(prev - speed) ? curr : prev
  );

  // Calculate discrete progress across the 4 points (0%, 33.33%, 66.67%, 100%)
  const pointIndex = DISCRETE_HOLD_SPEEDS.indexOf(snappedSpeed);
  const discreteProgress =
    pointIndex >= 0
      ? (pointIndex / (DISCRETE_HOLD_SPEEDS.length - 1)) * 100
      : 66.67;

  const isSuperFast = snappedSpeed >= 2.8;
  const isFast = snappedSpeed > 1.2 && snappedSpeed < 2.8;
  const isNormal = snappedSpeed >= 0.9 && snappedSpeed <= 1.2;
  const isSlow = snappedSpeed < 0.9;

  let speedLabel = `${snappedSpeed.toFixed(1)}x Fast`;
  if (isSuperFast) {
    speedLabel = '3.0x Max';
  } else if (isFast) {
    speedLabel = '2.0x Fast';
  } else if (isNormal) {
    speedLabel = '1.0x Normal';
  } else if (isSlow) {
    speedLabel = '0.5x Slow';
  }

  const compactText = Number.isInteger(snappedSpeed)
    ? `${snappedSpeed}x`
    : `${snappedSpeed.toFixed(1)}x`;

  return (
    <div className="absolute top-3 sm:top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none">
      {minimized ? (
        /* Minimized subtle near-invisible box at top so overall video view is never blocked */
        <div className="flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-black/20 border border-white/10 backdrop-blur-[2px] transition-all duration-200 animate-in fade-in duration-150">
          {isSlow ? (
            <Rewind className="w-3 h-3 text-cyan-300/90 animate-pulse" />
          ) : isNormal ? (
            <Play className="w-2.5 h-2.5 text-white/90 fill-white/90" />
          ) : (
            <FastForward className="w-3 h-3 text-purple-300/90 animate-pulse" />
          )}
          <span className="font-extrabold text-[11px] tracking-wider text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)] tabular-nums">
            {compactText}
          </span>
        </div>
      ) : (
        /* Compact Discrete Speed Pill */
        <div className="flex flex-col items-center gap-1.5 animate-in fade-in zoom-in-95 duration-150">
          <div className="w-[210px] sm:w-[235px] bg-black/75 backdrop-blur-xl border border-white/20 rounded-2xl px-3.5 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.7)] flex flex-col gap-1.5">
            {/* Compact Header Row */}
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-1.5">
                {isSuperFast ? (
                  <Zap className="w-3.5 h-3.5 fill-amber-400 text-amber-400 animate-pulse" />
                ) : isFast ? (
                  <FastForward className="w-3.5 h-3.5 fill-purple-400 text-purple-400 animate-pulse" />
                ) : isNormal ? (
                  <Play className="w-3 h-3 fill-white text-white" />
                ) : (
                  <Rewind className="w-3.5 h-3.5 fill-cyan-400 text-cyan-400 animate-pulse" />
                )}
                <span className="font-black text-xs text-white tracking-wide">
                  {speedLabel}
                </span>
              </div>
              <span className="text-[9px] text-white/55 font-semibold">
                Slide ◀ ▶
              </span>
            </div>

            {/* Discrete Point Track */}
            <div className="relative w-full h-1.5 bg-white/15 rounded-full flex items-center my-0.5">
              {/* Active progress fill */}
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  isSuperFast
                    ? 'bg-gradient-to-r from-purple-500 via-orange-500 to-amber-400'
                    : isFast
                    ? 'bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1]'
                    : isNormal
                    ? 'bg-white/50'
                    : 'bg-gradient-to-r from-cyan-400 to-blue-500'
                }`}
                style={{ width: `${discreteProgress}%` }}
              />

              {/* Discrete Snap Point Dots */}
              {DISCRETE_HOLD_SPEEDS.map((pt, idx) => {
                const pos = (idx / (DISCRETE_HOLD_SPEEDS.length - 1)) * 100;
                const isSelected = Math.abs(snappedSpeed - pt) < 0.05;
                return (
                  <div
                    key={pt}
                    className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full transition-all duration-150 ${
                      isSelected
                        ? 'w-3 h-3 bg-white border-2 border-[#8B5CF6] shadow-[0_0_10px_#8B5CF6]'
                        : 'w-1.5 h-1.5 bg-white/35'
                    }`}
                    style={{ left: `${pos}%` }}
                  />
                );
              })}
            </div>

            {/* Speed Milestones: 0.5x ➔ 1.0x ➔ 2.0x ➔ 3.0x */}
            <div className="flex justify-between items-center text-[9px] font-bold px-0.5 select-none">
              <span className={isSlow ? 'text-cyan-300 font-black scale-105' : 'text-white/45'}>
                0.5x
              </span>
              <span className={isNormal ? 'text-white font-black scale-105' : 'text-white/45'}>
                1.0x
              </span>
              <span className={isFast ? 'text-purple-300 font-black scale-105' : 'text-white/45'}>
                2.0x
              </span>
              <span className={isSuperFast ? 'text-amber-300 font-black scale-105' : 'text-white/45'}>
                3.0x
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

