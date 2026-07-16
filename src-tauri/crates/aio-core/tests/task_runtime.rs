use aio_core::{RuntimeOwner, TaskJoinError, TaskRuntime};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[test]
fn spawned_async_task_returns_typed_result() {
    let owner = RuntimeOwner::new("aio-core-async-test").expect("create runtime");
    let runtime = owner.task_runtime();
    let task = runtime.spawn(async { 42_u32 });

    assert_eq!(owner.block_on(task).expect("join async task"), 42);
    owner.shutdown_timeout(Duration::from_secs(1));
}

#[test]
fn blocking_task_transports_typed_result() {
    let owner = RuntimeOwner::new("aio-core-blocking-test").expect("create runtime");
    let runtime = owner.task_runtime();
    let task = runtime.spawn_blocking(|| "done".to_string());

    assert_eq!(owner.block_on(task).expect("join blocking task"), "done");
    owner.shutdown_timeout(Duration::from_secs(1));
}

#[test]
fn aborted_task_reports_typed_cancellation() {
    let owner = RuntimeOwner::new("aio-core-abort-test").expect("create runtime");
    let runtime = owner.task_runtime();
    let task = runtime.spawn(std::future::pending::<()>());
    task.abort();

    let error = owner.block_on(task).expect_err("aborted task must fail");
    assert_eq!(error, TaskJoinError::Cancelled);
    owner.shutdown_timeout(Duration::from_secs(1));
}

#[test]
fn panicked_task_redacts_its_payload() {
    let owner = RuntimeOwner::new("aio-core-panic-test").expect("create runtime");
    let runtime = owner.task_runtime();
    let task = runtime.spawn_blocking(|| panic!("secret user payload"));

    let error = owner.block_on(task).expect_err("panicked task must fail");
    assert_eq!(error, TaskJoinError::Panicked);
    assert!(!error.to_string().contains("secret user payload"));
    owner.shutdown_timeout(Duration::from_secs(1));
}

#[test]
fn task_runtime_trait_is_object_safe() {
    let owner = RuntimeOwner::new("aio-core-trait-test").expect("create runtime");
    let runtime: Arc<dyn TaskRuntime> = owner.task_runtime();
    let task = runtime.spawn(Box::pin(async {}));

    owner.block_on(task).expect("join boxed task");
    owner.shutdown_timeout(Duration::from_secs(1));
}

#[test]
fn shutdown_timeout_is_bounded_for_pending_tasks() {
    let owner = RuntimeOwner::new("aio-core-shutdown-test").expect("create runtime");
    let runtime = owner.task_runtime();
    let _task = runtime.spawn(std::future::pending::<()>());
    let started = Instant::now();

    owner.shutdown_timeout(Duration::from_millis(50));

    assert!(started.elapsed() < Duration::from_secs(1));
}
