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
      <strong>macOS</strong>: Control-click Nesvo in Applications and choose{' '}
      <em>Open</em>, or use <em>System Settings › Privacy &amp; Security</em> ›{' '}
      <em>Open Anyway</em>.
    </li>
    <li>
      <strong>Terminal</strong>: the command verifies the SHA-256 checksum,
      copies Nesvo to Applications and keeps the macOS check in place.
    </li>
  </ul>
);
