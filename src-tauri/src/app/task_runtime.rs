//! Usage: Process-owned task runtime adapter for the legacy Tauri shell.

use std::future::Future;
use std::sync::{Arc, OnceLock};

pub(crate) type JoinHandle<T> = aio_core::TaskHandle<T>;

static PROCESS_RUNTIME: OnceLock<Arc<aio_core::TokioTaskRuntime>> = OnceLock::new();

#[cfg(debug_assertions)]
static FALLBACK_RUNTIME: OnceLock<aio_core::RuntimeOwner> = OnceLock::new();

pub(crate) fn install(runtime: Arc<aio_core::TokioTaskRuntime>) -> Result<(), &'static str> {
    PROCESS_RUNTIME
        .set(runtime)
        .map_err(|_| "process task runtime is already installed")
}

pub(crate) fn current() -> Arc<aio_core::TokioTaskRuntime> {
    if let Some(runtime) = PROCESS_RUNTIME.get() {
        return Arc::clone(runtime);
    }

    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        return Arc::new(aio_core::TokioTaskRuntime::from_handle(handle));
    }

    #[cfg(debug_assertions)]
    {
        FALLBACK_RUNTIME
            .get_or_init(|| {
                aio_core::RuntimeOwner::new("aio-coding-hub-test-runtime")
                    .expect("create fallback task runtime")
            })
            .task_runtime()
    }

    #[cfg(not(debug_assertions))]
    panic!("process task runtime has not been installed");
}

pub(crate) fn spawn<F>(task: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    current().spawn(task)
}

pub(crate) fn spawn_blocking<F, T>(task: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    current().spawn_blocking(task)
}

pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    current().block_on(future)
}
