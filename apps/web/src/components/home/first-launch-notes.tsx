import { DOWNLOAD_TARGETS } from '@/releases/download-targets';

export const FirstLaunchNotes = () => (
  <ul className="panel-list">
    <li>
      Builds are unsigned and do not update automatically; get new versions
      here.
    </li>
    <li>
      <strong>Windows</strong>: choose <em>More info</em>, then{' '}
      <em>Run anyway</em>.
    </li>
    <li>
      <strong>macOS</strong> — Use the Terminal installer. It verifies the
      checksum.
    </li>
    <li>
      <strong>Manual disk image</strong> — {DOWNLOAD_TARGETS.mac.firstLaunch}
    </li>
  </ul>
);
