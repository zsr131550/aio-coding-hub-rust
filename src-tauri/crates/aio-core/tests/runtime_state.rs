use aio_contract::AppStartupStage;
use aio_core::{
    AppContext, AppPathOverrides, AppPathRoots, AppPaths, AppRuntimeState, AsyncInitState,
    InstanceGuard, RuntimeOwner, StartupState, StateSlot,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_init_runs_once_for_concurrent_callers() {
    let state = Arc::new(AsyncInitState::<usize, &'static str>::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let (first_started_tx, first_started_rx) = tokio::sync::oneshot::channel();

    let first = {
        let state = Arc::clone(&state);
        let calls = Arc::clone(&calls);
        tokio::spawn(async move {
            state
                .get_or_try_init(|| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    first_started_tx.send(()).expect("signal first start");
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    Ok(41)
                })
                .await
        })
    };
    first_started_rx.await.expect("first initializer starts");
    let second = {
        let state = Arc::clone(&state);
        let calls = Arc::clone(&calls);
        tokio::spawn(async move {
            state
                .get_or_try_init(|| async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(99)
                })
                .await
        })
    };

    assert_eq!(first.await.expect("join first"), Ok(41));
    assert_eq!(second.await.expect("join second"), Ok(41));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn async_init_caches_errors_and_results() {
    let failed = AsyncInitState::<usize, &'static str>::new();
    let calls = AtomicUsize::new(0);

    assert_eq!(
        failed
            .get_or_try_init(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err("first failure")
            })
            .await,
        Err("first failure")
    );
    assert_eq!(
        failed
            .get_or_try_init(|| async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(7)
            })
            .await,
        Err("first failure")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let ready = AsyncInitState::<usize, &'static str>::new();
    assert_eq!(ready.get_or_try_init(|| async { Ok(7) }).await, Ok(7));
    assert_eq!(ready.cached().await, Some(Ok(7)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reset_guard_excludes_reinitialization_until_released() {
    let state = Arc::new(AsyncInitState::<usize, &'static str>::new());
    assert_eq!(state.get_or_try_init(|| async { Ok(1) }).await, Ok(1));

    let reset_guard = state.begin_reset().await;
    assert_eq!(reset_guard.cached(), None);

    let mut reinitialize = {
        let state = Arc::clone(&state);
        tokio::spawn(async move { state.get_or_try_init(|| async { Ok(2) }).await })
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut reinitialize)
            .await
            .is_err()
    );

    drop(reset_guard);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), reinitialize)
            .await
            .expect("reinitialization resumes")
            .expect("join reinitialization"),
        Ok(2)
    );
}

#[test]
fn state_slot_recovers_after_poisoning() {
    let slot = StateSlot::new(vec![1_u8]);
    let panic = catch_unwind(AssertUnwindSafe(|| {
        slot.with_mut(|values| {
            values.push(2);
            panic!("poison state slot");
        });
    }));
    assert!(panic.is_err());

    slot.with_mut(|values| values.push(3));
    assert_eq!(slot.with(Clone::clone), vec![1, 2, 3]);
}

#[test]
fn startup_state_returns_transition_snapshots() {
    let startup = StartupState::default();

    let started = startup.try_begin_run().expect("first run starts");
    assert!(started.running);
    assert_eq!(started.current_stage, AppStartupStage::InitializingDb);
    assert!(startup.try_begin_run().is_none());

    let reading = startup.set_stage(AppStartupStage::ReadingSettings);
    assert_eq!(reading.current_stage, AppStartupStage::ReadingSettings);

    let failed = startup.fail(AppStartupStage::ReadingSettings, "bad settings");
    assert!(!failed.running);
    assert_eq!(failed.current_stage, AppStartupStage::Failed);
    assert_eq!(failed.failed_stage, Some(AppStartupStage::ReadingSettings));
    assert_eq!(failed.error_message.as_deref(), Some("bad settings"));
    assert!(failed.can_retry);

    let restarted = startup.try_begin_run().expect("retry starts");
    assert_eq!(restarted.error_message, None);
    let ready = startup.finish();
    assert_eq!(ready.current_stage, AppStartupStage::Ready);
    assert!(!ready.running);
    assert!(!ready.can_retry);
}

#[test]
fn app_runtime_state_keeps_plugin_initialization_lazy() {
    let temp = tempfile::tempdir().expect("temp dir");
    let paths = Arc::new(
        AppPaths::resolve(
            AppPathRoots {
                platform_home: temp.path().join("home"),
                resource_dir: temp.path().join("resources"),
            },
            AppPathOverrides::default(),
        )
        .expect("resolve paths"),
    );
    let instance = Arc::new(InstanceGuard::try_acquire(paths.as_ref()).expect("instance guard"));
    let runtime_owner = RuntimeOwner::new("runtime-state-test").expect("runtime owner");
    let context = Arc::new(AppContext::new(
        paths,
        runtime_owner.task_runtime(),
        Arc::new(aio_core::NoopEventSink),
        Arc::new(StartupState::default()),
        instance,
    ));
    let state = AppRuntimeState::<usize, Vec<u8>, String, &'static str>::new(context, vec![]);

    runtime_owner.block_on(async {
        assert_eq!(state.plugins().cached().await, None);
        assert_eq!(
            state
                .plugins()
                .get_or_try_init(|| async { Ok("plugin-registry".to_string()) })
                .await,
            Ok("plugin-registry".to_string())
        );
    });
    assert_eq!(state.gateway().with(Vec::len), 0);

    drop(state);
    runtime_owner.shutdown_timeout(Duration::from_secs(1));
}
