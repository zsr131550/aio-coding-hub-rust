use aio_contract::{AppStartupStage, AppStartupStatus};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};

pub struct AsyncInitState<T, E> {
    inner: AsyncMutex<Option<Result<T, E>>>,
}

impl<T, E> AsyncInitState<T, E> {
    pub const fn new() -> Self {
        Self {
            inner: AsyncMutex::const_new(None),
        }
    }

    pub async fn get_or_try_init<F, Fut>(&self, initialize: F) -> Result<T, E>
    where
        T: Clone,
        E: Clone,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, E>>,
    {
        let mut guard = self.inner.lock().await;
        if let Some(value) = guard.as_ref() {
            return value.clone();
        }

        let value = initialize().await;
        *guard = Some(value.clone());
        value
    }

    pub async fn cached(&self) -> Option<Result<T, E>>
    where
        T: Clone,
        E: Clone,
    {
        self.inner.lock().await.clone()
    }

    pub async fn replace_cached(&self, value: Option<Result<T, E>>) -> Option<Result<T, E>> {
        std::mem::replace(&mut *self.inner.lock().await, value)
    }

    pub async fn begin_reset(&self) -> AsyncInitResetGuard<'_, T, E> {
        let mut guard = self.inner.lock().await;
        *guard = None;
        AsyncInitResetGuard { guard }
    }
}

impl<T, E> Default for AsyncInitState<T, E> {
    fn default() -> Self {
        Self::new()
    }
}

pub struct AsyncInitResetGuard<'a, T, E> {
    guard: AsyncMutexGuard<'a, Option<Result<T, E>>>,
}

impl<T, E> AsyncInitResetGuard<'_, T, E> {
    pub fn cached(&self) -> Option<Result<T, E>>
    where
        T: Clone,
        E: Clone,
    {
        self.guard.clone()
    }
}

pub struct StateSlot<T> {
    inner: Mutex<T>,
}

impl<T> StateSlot<T> {
    pub const fn new(value: T) -> Self {
        Self {
            inner: Mutex::new(value),
        }
    }

    pub fn with<R>(&self, access: impl FnOnce(&T) -> R) -> R {
        let guard = lock_or_recover(&self.inner);
        access(&guard)
    }

    pub fn with_mut<R>(&self, access: impl FnOnce(&mut T) -> R) -> R {
        let mut guard = lock_or_recover(&self.inner);
        access(&mut guard)
    }

    pub fn replace(&self, value: T) -> T {
        self.with_mut(|slot| std::mem::replace(slot, value))
    }
}

impl<T: Default> StateSlot<T> {
    pub fn take(&self) -> T {
        self.with_mut(std::mem::take)
    }
}

impl<T: Default> Default for StateSlot<T> {
    fn default() -> Self {
        Self::new(T::default())
    }
}

#[derive(Default)]
pub struct StartupState {
    inner: Mutex<AppStartupStatus>,
}

impl StartupState {
    pub fn snapshot(&self) -> AppStartupStatus {
        lock_or_recover(&self.inner).clone()
    }

    pub fn try_begin_run(&self) -> Option<AppStartupStatus> {
        let mut status = lock_or_recover(&self.inner);
        if status.running {
            return None;
        }

        status.running = true;
        status.current_stage = AppStartupStage::InitializingDb;
        status.failed_stage = None;
        status.error_message = None;
        status.can_retry = false;
        Some(status.clone())
    }

    pub fn set_stage(&self, stage: AppStartupStage) -> AppStartupStatus {
        self.update(|status| {
            status.running = true;
            status.current_stage = stage;
            status.failed_stage = None;
            status.error_message = None;
            status.can_retry = false;
        })
    }

    pub fn fail(&self, stage: AppStartupStage, message: impl Into<String>) -> AppStartupStatus {
        let message = message.into();
        self.update(|status| {
            status.running = false;
            status.current_stage = AppStartupStage::Failed;
            status.failed_stage = Some(stage);
            status.error_message = Some(message);
            status.can_retry = true;
        })
    }

    pub fn finish(&self) -> AppStartupStatus {
        self.update(|status| {
            status.running = false;
            status.current_stage = AppStartupStage::Ready;
            status.failed_stage = None;
            status.error_message = None;
            status.can_retry = false;
        })
    }

    fn update(&self, update: impl FnOnce(&mut AppStartupStatus)) -> AppStartupStatus {
        let mut status = lock_or_recover(&self.inner);
        update(&mut status);
        status.clone()
    }
}

pub struct AppRuntimeState<Db, Gateway, Plugins, Error> {
    context: Arc<crate::AppContext>,
    database: AsyncInitState<Db, Error>,
    gateway: StateSlot<Gateway>,
    plugins: AsyncInitState<Plugins, Error>,
}

impl<Db, Gateway, Plugins, Error> AppRuntimeState<Db, Gateway, Plugins, Error> {
    pub fn new(context: Arc<crate::AppContext>, gateway: Gateway) -> Self {
        Self {
            context,
            database: AsyncInitState::new(),
            gateway: StateSlot::new(gateway),
            plugins: AsyncInitState::new(),
        }
    }

    pub fn context(&self) -> &Arc<crate::AppContext> {
        &self.context
    }

    pub fn database(&self) -> &AsyncInitState<Db, Error> {
        &self.database
    }

    pub fn gateway(&self) -> &StateSlot<Gateway> {
        &self.gateway
    }

    pub fn plugins(&self) -> &AsyncInitState<Plugins, Error> {
        &self.plugins
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
