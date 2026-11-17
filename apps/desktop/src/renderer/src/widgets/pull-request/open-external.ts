export function openExternal(url: string) {
  void window.nesvo?.openExternal(url)?.catch(() => undefined);
}
