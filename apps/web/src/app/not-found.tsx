import { SiteFooter } from '@/components/site-footer';
import { Wordmark } from '@/components/wordmark';

const NotFound = () => (
  <>
    <main className="home">
      <a className="home-title" href="/" aria-label="Nesvo home">
        <Wordmark className="home-mark" isDecorative />
      </a>
      <h1 className="tagline">This page does not exist.</h1>
      <p className="download-meta">
        <a href="/">Go to the download page</a>
      </p>
    </main>
    <SiteFooter />
  </>
);

export default NotFound;
