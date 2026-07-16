use aio_contract::AppEvent;
use std::sync::{Mutex, MutexGuard};

pub trait EventSink: Send + Sync {
    fn publish(&self, event: AppEvent);
}

#[derive(Debug, Default)]
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn publish(&self, _event: AppEvent) {}
}

#[derive(Debug, Default)]
pub struct RecordingEventSink {
    events: Mutex<Vec<AppEvent>>,
}

impl RecordingEventSink {
    pub fn events(&self) -> Vec<AppEvent> {
        lock_or_recover(&self.events).clone()
    }

    pub fn drain(&self) -> Vec<AppEvent> {
        std::mem::take(&mut *lock_or_recover(&self.events))
    }
}

impl EventSink for RecordingEventSink {
    fn publish(&self, event: AppEvent) {
        lock_or_recover(&self.events).push(event);
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
