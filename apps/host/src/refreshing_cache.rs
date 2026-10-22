use std::{
    sync::{Mutex, MutexGuard},
    thread::{Builder, JoinHandle},
    time::{Duration, Instant},
};

pub(crate) struct RefreshingCache<T> {
    observed: Option<(T, Instant)>,
    refreshing: bool,
    every: Duration,
}

impl<T: Clone> RefreshingCache<T> {
    pub(crate) const fn new(every: Duration) -> Self {
        Self {
            observed: None,
            refreshing: false,
            every,
        }
    }

    pub(crate) fn claim(
        &mut self,
        now: Instant,
        current: impl Fn(&T) -> bool,
    ) -> (Option<T>, bool) {
        let observed = self.observed.as_ref().filter(|(value, _)| current(value));
        let value = observed.map(|(value, _)| value.clone());
        let stale = observed.is_none_or(|(_, at)| now.saturating_duration_since(*at) >= self.every);
        let refresh = stale && !self.refreshing;
        self.refreshing |= refresh;
        (value, refresh)
    }

    pub(crate) fn store(&mut self, value: T, at: Instant) {
        self.observed = Some((value, at));
        self.refreshing = false;
    }

    pub(crate) fn release(&mut self) {
        self.refreshing = false;
    }
}

fn locked<T>(cache: &Mutex<RefreshingCache<T>>) -> MutexGuard<'_, RefreshingCache<T>> {
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Pending<T: 'static>(&'static Mutex<RefreshingCache<T>>);

impl<T> Drop for Pending<T> {
    fn drop(&mut self) {
        locked(self.0).refreshing = false;
    }
}

pub(crate) fn observe_into<T: Clone>(
    cache: &'static Mutex<RefreshingCache<T>>,
    observe: impl FnOnce() -> T,
) {
    let pending = Pending(cache);
    let value = observe();
    locked(pending.0).store(value, Instant::now());
}

pub(crate) fn refresh_in_background<T: Clone + Send + 'static>(
    cache: &'static Mutex<RefreshingCache<T>>,
    name: &str,
    observe: impl FnOnce() -> T + Send + 'static,
) -> Option<JoinHandle<()>> {
    match Builder::new()
        .name(name.into())
        .spawn(move || observe_into(cache, observe))
    {
        Ok(handle) => Some(handle),
        Err(_) => {
            locked(cache).release();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cache_refreshes_once_per_period_and_only_for_the_current_key() {
        let mut cache = RefreshingCache::new(Duration::from_secs(2));
        let start = Instant::now();
        let any = |_: &u8| true;
        assert_eq!(cache.claim(start, any), (None, true));
        assert_eq!(cache.claim(start, any), (None, false));
        cache.store(7, start);
        let within = start + Duration::from_millis(1999);
        assert_eq!(cache.claim(within, any), (Some(7), false));
        let due = start + Duration::from_secs(2);
        assert_eq!(cache.claim(due, any), (Some(7), true));
        assert_eq!(cache.claim(due, any), (Some(7), false));
        cache.release();
        assert_eq!(cache.claim(due, |value| *value == 8), (None, true));
    }

    #[test]
    fn a_panicking_refresh_releases_the_claim() {
        static CACHE: Mutex<RefreshingCache<u8>> =
            Mutex::new(RefreshingCache::new(Duration::from_secs(2)));
        let now = Instant::now();
        assert_eq!(locked(&CACHE).claim(now, |_| true), (None, true));
        let handle = refresh_in_background(&CACHE, "refresh-panics", || -> u8 {
            panic!("observation failed")
        })
        .unwrap();
        assert!(handle.join().is_err());
        assert_eq!(locked(&CACHE).claim(now, |_| true), (None, true));
        refresh_in_background(&CACHE, "refresh-stores", || 3)
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(locked(&CACHE).claim(now, |_| true), (Some(3), false));
    }
}
