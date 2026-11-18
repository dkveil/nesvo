const STORAGE_KEY = 'nesvo.pull-request.file-list-open.v1';

export const readFileListOpen = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const saveFileListOpen = (open: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
    return;
  }
};
