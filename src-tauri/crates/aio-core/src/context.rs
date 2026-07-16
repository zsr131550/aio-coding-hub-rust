use crate::{AppPaths, EventSink, InstanceGuard, StartupState, TaskRuntime};
use std::sync::Arc;

pub struct AppContext {
    paths: Arc<AppPaths>,
    tasks: Arc<dyn TaskRuntime>,
    events: Arc<dyn EventSink>,
    startup: Arc<StartupState>,
    instance: Arc<InstanceGuard>,
}

impl AppContext {
    pub fn new(
        paths: Arc<AppPaths>,
        tasks: Arc<dyn TaskRuntime>,
        events: Arc<dyn EventSink>,
        startup: Arc<StartupState>,
        instance: Arc<InstanceGuard>,
    ) -> Self {
        Self {
            paths,
            tasks,
            events,
            startup,
            instance,
        }
    }

    pub fn paths(&self) -> &Arc<AppPaths> {
        &self.paths
    }

    pub fn tasks(&self) -> &Arc<dyn TaskRuntime> {
        &self.tasks
    }

    pub fn events(&self) -> &Arc<dyn EventSink> {
        &self.events
    }

    pub fn startup(&self) -> &Arc<StartupState> {
        &self.startup
    }

    pub fn instance(&self) -> &Arc<InstanceGuard> {
        &self.instance
    }
}
