export const UnsignedNotes = () => (
  <section className="details" aria-labelledby="unsigned-title">
    <h2 id="unsigned-title" className="section-label">
      Unsigned builds
    </h2>
    <p>
      Nesvo builds are not code signed yet and do not update automatically. Your
      operating system warns about that the first time you open the app.
      Download a new version from this page when one is released.
    </p>
    <ul className="notes">
      <li>
        <strong>Windows</strong> warns about an unrecognized app. Choose{' '}
        <em>More info</em>, then <em>Run anyway</em>.
      </li>
      <li>
        <strong>macOS</strong> blocks the first launch. Control-click Nesvo in
        Applications and choose <em>Open</em>. If macOS only offers to move it
        to the Bin, open <em>System Settings › Privacy &amp; Security</em> and
        choose <em>Open Anyway</em>.
      </li>
      <li>
        <strong>The Terminal command</strong> downloads the disk image for your
        Mac, checks it against the release SHA-256 checksums, copies Nesvo to
        Applications and prints these steps. It leaves the macOS security check
        in place, so the first launch still asks you to confirm.
      </li>
    </ul>
  </section>
);
