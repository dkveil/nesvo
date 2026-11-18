import {
  attachmentLimits,
  type DesktopApi,
  type MessageAttachment,
} from '@nesvo/contracts';

const BINARY_SLICE_BYTES = 32 * 1024;

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BINARY_SLICE_BYTES)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BINARY_SLICE_BYTES),
    );
  return btoa(binary);
};

export const stageFile = async (
  api: Pick<DesktopApi, 'stageAttachment'>,
  file: Blob,
  name: string,
): Promise<MessageAttachment> => {
  const uploadId = crypto.randomUUID();
  for (let offset = 0; ;) {
    const chunk = new Uint8Array(
      await file
        .slice(offset, offset + attachmentLimits.chunkBytes)
        .arrayBuffer(),
    );
    const final = offset + chunk.length >= file.size;
    const upload = await api.stageAttachment({
      uploadId,
      name,
      offset,
      data: toBase64(chunk),
      final,
    });
    offset += chunk.length;
    if (!final) continue;
    if (!upload.attachment)
      throw new Error('The computer did not confirm the file.');
    return upload.attachment;
  }
};
