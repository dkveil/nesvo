import { Maximize2, WrapText } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';
import { useDiffWrap } from './use-diff-wrap';

type ToggleSize = 24 | 28;

export function WrapToggle({ size = 28 }: { size?: ToggleSize }) {
  const [wrap, setWrap] = useDiffWrap();
  return (
    <IconButton
      label="Wrap diff lines"
      size={size}
      pressed={wrap}
      onClick={() => setWrap(!wrap)}
    >
      <WrapText />
    </IconButton>
  );
}

type FullscreenButtonProps = {
  path: string;
  size?: ToggleSize;
  onOpen: () => void;
};

export function FullscreenButton({
  path,
  size = 24,
  onOpen,
}: FullscreenButtonProps) {
  return (
    <IconButton
      label={`Open ${path} in fullscreen`}
      size={size}
      onClick={onOpen}
    >
      <Maximize2 />
    </IconButton>
  );
}
