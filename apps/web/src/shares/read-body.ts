export type BodyReadResult =
  | { status: 'read'; text: string }
  | { status: 'too-large' }
  | { status: 'invalid' };

const concatChunks = (chunks: Uint8Array[], totalBytes: number): Uint8Array => {
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
};

export const readBodyWithLimit = async (
  request: Request,
  limitBytes: number,
): Promise<BodyReadResult> => {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    return { status: 'too-large' };
  }
  if (!request.body) return { status: 'read', text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > limitBytes) {
      await reader.cancel();
      return { status: 'too-large' };
    }
    chunks.push(value);
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return {
      status: 'read',
      text: decoder.decode(concatChunks(chunks, receivedBytes)),
    };
  } catch {
    return { status: 'invalid' };
  }
};
