export function pathBasename(value: string) {
  return (
    value
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || value
  );
}
