import { memo } from 'react';

import logo from '@nesvo/brand/logo.json';
import Svg, { Path, Rect } from 'react-native-svg';

import { colors } from '@shared/theme';

import { useLogoMotion } from '../model/use-logo-motion';

type NesvoLogoProps = {
  width?: number;
  variant?: 'wordmark' | 'robot';
  active?: boolean;
  testID?: string;
};

/** The supplied pixel paths are rendered verbatim; no font approximates the wordmark. */
export const NesvoLogo = memo(function NesvoLogo({
  width = 118,
  variant = 'wordmark',
  active = false,
  testID,
}: NesvoLogoProps) {
  const frame = useLogoMotion(active);
  const viewBox = variant === 'robot' ? logo.robotViewBox : logo.viewBox;
  const height = (width * (viewBox[3] ?? 19)) / (viewBox[2] ?? 59);
  return (
    <Svg
      width={width}
      height={height}
      viewBox={viewBox.join(' ')}
      accessibilityRole="image"
      accessibilityLabel="nesvo"
      testID={testID}
    >
      <Path d={logo.paths.robot} fill={colors.accent} />
      {variant === 'wordmark' && <Path d={logo.paths.wordmark} fill={colors.text} />}
      <Rect
        {...logo.eye}
        x={logo.eye.x + frame.eyeOffsetX}
        fill={colors.text}
        opacity={frame.closed ? 0 : 1}
      />
      <Rect {...logo.eyelid} fill={colors.accent} opacity={frame.closed ? 1 : 0} />
      <Rect
        {...logo.satellite}
        y={logo.satellite.y + frame.satelliteOffsetY}
        fill={colors.accent}
      />
    </Svg>
  );
});
