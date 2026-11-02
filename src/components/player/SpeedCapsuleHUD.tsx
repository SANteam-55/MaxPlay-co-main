import React from 'react';
import { Zap, FastForward, Rewind, Play } from 'lucide-react';

interface SpeedCapsuleHUDProps {
  visible: boolean;
  speed: number;
  progress: number;
  minimized?: boolean;
}

export const DISCRETE_HOLD_SPEEDS = [0.5, 1.0, 2.0, 3.0];

export const SpeedCapsuleHUD: React.FC<SpeedCapsuleHUDProps> = React.memo(({
  visible,
  speed,
  minimized = false,
}) => {
  if (!visible) return null;

  // Snap strictly to nearest discrete speed point (0.5x, 1.0x, 2.0x, 3.0x)
  const snappedSpeed = DISCRETE_HOLD_SPEEDS.reduce((prev, curr) =>
    Math.abs(curr - speed) < Math.abs(prev - speed) ? curr : prev
  );

  const isSuperFast = snappedSpeed >= 2.8;
  const isFast = snappedSpeed > 1.2 && snappedSpeed < 2.8;
  const isNormal = snappedSpeed >= 0.9 && snappedSpeed <= 1.2;
  const isSlow = snappedSpeed < 0.9;

  const compactText = Number.isInteger(snappedSpeed)
    ? `${snappedSpeed}x`
    : `${snappedSpeed.toFixed(1)}x`;

  return (
    <div
      className="absolute top-1/2 left-1/2 z-40 pointer-events-none select-none will-change-transform"
      style={{ transform: 'translate3d(-50%, -50%, 0)' }}
    >
      {minimized ? (
        /* Sleek centered compact badge when speed is locked */
        <div className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[#0B0D13]/80 border border-white/15 shadow-[0_8px_24px_rgba(0,0,0,0.65)] transition-all duration-150">
          {isSlow ? (
            <Rewind className="w-3.5 h-3.5 text-cyan-400 fill-cyan-400/20" />
          ) : isNormal ? (
            <Play className="w-3 h-3 text-white fill-white" />
          ) : isSuperFast ? (
            <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
          ) : (
            <FastForward className="w-3.5 h-3.5 text-[#A78BFA] fill-[#A78BFA]" />
          )}
          <span className="font-extrabold text-[12px] tracking-wider text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)] tabular-nums">
            {compactText}
          </span>
        </div>
      ) : (
        /* Centered discrete speed selector pill (0.5x, 1.0x, 2.0x, 3.0x) */
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-full bg-[#0B0D13]/90 border border-white/15 p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.8)]">
            {DISCRETE_HOLD_SPEEDS.map((pt) => {
              const isSelected = Math.abs(snappedSpeed - pt) < 0.05;
              const label = Number.isInteger(pt) ? `${pt}.0x` : `${pt}x`;
              return (
                <div
                  key={pt}
                  className={`flex items-center gap-1 px-3 py-1 rounded-full text-[11.5px] transition-all duration-150 tabular-nums ${
                    isSelected
                      ? 'bg-gradient-to-r from-[#8B5CF6] to-[#6D28D9] text-white font-extrabold shadow-[0_2px_12px_rgba(139,92,246,0.55)] scale-105'
                      : 'text-white/50 font-semibold'
                  }`}
                >
                  {isSelected && (
                    <>
                      {pt < 0.9 ? (
                        <Rewind className="w-3 h-3 text-white fill-white" />
                      ) : pt <= 1.2 ? (
                        <Play className="w-2.5 h-2.5 text-white fill-white" />
                      ) : pt >= 2.8 ? (
                        <Zap className="w-3 h-3 text-amber-300 fill-amber-300" />
                      ) : (
                        <FastForward className="w-3 h-3 text-white fill-white" />
                      )}
                    </>
                  )}
                  <span>{label}</span>
                </div>
              );
            })}
          </div>
          <span className="text-[10px] font-bold tracking-wider uppercase text-white/70 bg-black/50 px-2.5 py-0.5 rounded-full">
            Slide left or right to adjust speed
          </span>
        </div>
      )}
    </div>
  );
});



