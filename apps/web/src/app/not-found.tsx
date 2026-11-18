import { SiteFooter } from '@/components/site-footer';
import { Wordmark } from '@/components/wordmark';

const NotFound = () => (
  <>
    <main className="page">
      <div className="hero hero-compact">
        <a className="wordmark" href="/" aria-label="Nesvo home">
          <Wordmark />
        </a>
        <h1 className="share-title">This page does not exist</h1>
        <p className="tagline">
          <a href="/">Go to the download page</a>
        </p>
      </div>
    </main>
    <SiteFooter />
  </>
);

export default NotFound;
