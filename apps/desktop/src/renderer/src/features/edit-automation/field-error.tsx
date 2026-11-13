export function FieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}) {
  if (!message) return null;
  return (
    <p id={id} className="text-2xs leading-4 text-destructive">
      {message}
    </p>
  );
}
