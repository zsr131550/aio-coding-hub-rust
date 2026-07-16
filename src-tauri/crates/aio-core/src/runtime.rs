use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

pub type BoxTask = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
pub type BlockingTask = Box<dyn FnOnce() + Send + 'static>;

pub trait TaskRuntime: Send + Sync {
    fn spawn(&self, task: BoxTask) -> TaskHandle<()>;
    fn spawn_blocking(&self, task: BlockingTask) -> TaskHandle<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TaskJoinError {
    #[error("task cancelled")]
    Cancelled,
    #[error("task panicked")]
    Panicked,
}

impl TaskJoinError {
    fn from_tokio(error: tokio::task::JoinError) -> Self {
        if error.is_panic() {
            Self::Panicked
        } else {
            Self::Cancelled
        }
    }

    pub const fn is_cancelled(self) -> bool {
        matches!(self, Self::Cancelled)
    }

    pub const fn is_panic(self) -> bool {
        matches!(self, Self::Panicked)
    }
}

#[derive(Debug)]
pub struct TaskHandle<T> {
    inner: tokio::task::JoinHandle<T>,
}

impl<T> TaskHandle<T> {
    pub fn from_tokio(inner: tokio::task::JoinHandle<T>) -> Self {
        Self { inner }
    }

    pub fn abort(&self) {
        self.inner.abort();
    }

    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }
}

impl<T> Future for TaskHandle<T> {
    type Output = Result<T, TaskJoinError>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        Pin::new(&mut this.inner)
            .poll(context)
            .map(|result| result.map_err(TaskJoinError::from_tokio))
    }
}

#[derive(Debug, Clone)]
pub struct TokioTaskRuntime {
    handle: tokio::runtime::Handle,
}

impl TokioTaskRuntime {
    pub fn from_handle(handle: tokio::runtime::Handle) -> Self {
        Self { handle }
    }

    pub fn spawn<F>(&self, task: F) -> TaskHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        TaskHandle::from_tokio(self.handle.spawn(task))
    }

    pub fn spawn_blocking<F, T>(&self, task: F) -> TaskHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        TaskHandle::from_tokio(self.handle.spawn_blocking(task))
    }

    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.handle.block_on(future)
    }
}

impl TaskRuntime for TokioTaskRuntime {
    fn spawn(&self, task: BoxTask) -> TaskHandle<()> {
        TokioTaskRuntime::spawn(self, task)
    }

    fn spawn_blocking(&self, task: BlockingTask) -> TaskHandle<()> {
        TokioTaskRuntime::spawn_blocking(self, task)
    }
}

pub struct RuntimeOwner {
    runtime: Option<tokio::runtime::Runtime>,
    tasks: Arc<TokioTaskRuntime>,
}

impl RuntimeOwner {
    pub fn new(thread_name: impl Into<String>) -> std::io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name(thread_name.into())
            .build()?;
        let tasks = Arc::new(TokioTaskRuntime::from_handle(runtime.handle().clone()));
        Ok(Self {
            runtime: Some(runtime),
            tasks,
        })
    }

    pub fn task_runtime(&self) -> Arc<TokioTaskRuntime> {
        Arc::clone(&self.tasks)
    }

    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime
            .as_ref()
            .expect("runtime owner used after shutdown")
            .block_on(future)
    }

    pub fn shutdown_timeout(mut self, timeout: Duration) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(timeout);
        }
    }
}

impl Drop for RuntimeOwner {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
