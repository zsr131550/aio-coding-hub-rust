use std::collections::VecDeque;
use std::sync::Mutex;

use crate::{PlatformError, PlatformOperation, PlatformResult};

#[derive(Debug)]
pub struct Script<T> {
    operation: PlatformOperation,
    results: Mutex<VecDeque<PlatformResult<T>>>,
}

impl<T> Script<T> {
    pub fn new(operation: PlatformOperation) -> Self {
        Self {
            operation,
            results: Mutex::new(VecDeque::new()),
        }
    }

    pub fn push(&self, result: PlatformResult<T>) {
        self.results
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push_back(result);
    }

    pub fn pop(&self) -> PlatformResult<T> {
        self.results
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .pop_front()
            .unwrap_or_else(|| Err(PlatformError::unscripted(self.operation)))
    }

    pub fn len(&self) -> usize {
        self.results
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    #[doc(hidden)]
    pub fn poison_for_test(&self) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = self
                .results
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            panic!("poison fake platform script");
        }));
    }
}
