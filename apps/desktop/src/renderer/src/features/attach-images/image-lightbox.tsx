import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';

type ImageLightboxProps = {
  image: { name: string; src: string; detail: string } | null;
  onClose: () => void;
};

export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  return (
    <Dialog open={!!image} onOpenChange={open => !open && onClose()}>
      <DialogContent className="w-auto max-w-[min(92vw,1400px)] gap-3 p-3 pt-12 sm:max-w-[min(92vw,1400px)]">
        <DialogTitle className="absolute top-3.5 left-4 max-w-[calc(100%-4rem)] truncate text-sm">
          {image?.name}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {image?.detail}
        </DialogDescription>
        {image && (
          <img
            src={image.src}
            alt={image.name}
            className="max-h-[80vh] max-w-full rounded-control object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
