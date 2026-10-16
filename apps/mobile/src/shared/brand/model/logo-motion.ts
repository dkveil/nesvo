import LOGO from '@nesvo/brand/logo.json';

export const LOGO_CYCLE_MS = LOGO.motion.durationMs;

export type LogoFrame = {
  eyeOffsetX: number;
  satelliteOffsetY: number;
  closed: boolean;
};

function getCyclePosition(elapsedMs: number): number {
  return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) % LOGO_CYCLE_MS : 0;
}

export function getLogoFrame(elapsedMs: number): LogoFrame {
  const positionMs = getCyclePosition(elapsedMs);
  let activeFrame = LOGO.motion.frames[0];
  if (!activeFrame) {
    throw new Error('The shared logo timeline requires an initial frame.');
  }

  for (const frame of LOGO.motion.frames) {
    if (frame.atMs > positionMs) break;
    activeFrame = frame;
  }

  return {
    eyeOffsetX: activeFrame.eyeDx,
    satelliteOffsetY: activeFrame.satelliteDy,
    closed: !activeFrame.eyeOpen,
  };
}

export function nextLogoFrameDelay(elapsedMs: number): number {
  const positionMs = getCyclePosition(elapsedMs);
  const nextFrame = LOGO.motion.frames.find(frame => frame.atMs > positionMs);
  return (nextFrame?.atMs ?? LOGO_CYCLE_MS) - positionMs;
}
