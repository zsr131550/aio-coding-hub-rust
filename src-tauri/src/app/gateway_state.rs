//! Usage: Gateway runtime state container and internal manager access helpers.

use super::core_runtime::{CoreRuntimeState, ManagedCoreRuntimeState};
use crate::gateway::{manager::GatewayManager, runtime::GatewayRuntime};
use tauri::Manager;

fn with_gateway_manager<T, F>(state: &CoreRuntimeState, access: F) -> T
where
    F: FnOnce(&GatewayManager) -> T,
{
    state.gateway().with(access)
}

fn with_gateway_manager_mut<T, F>(state: &CoreRuntimeState, access: F) -> T
where
    F: FnOnce(&mut GatewayManager) -> T,
{
    state.gateway().with_mut(access)
}

fn with_gateway_running<T, F>(state: &CoreRuntimeState, access: F) -> T
where
    F: FnOnce(Option<&GatewayRuntime>) -> T,
{
    with_gateway_manager(state, |manager| access(manager.running.as_ref()))
}

fn with_gateway_running_slot_mut<T, F>(state: &CoreRuntimeState, access: F) -> T
where
    F: FnOnce(&mut Option<GatewayRuntime>) -> T,
{
    with_gateway_manager_mut(state, |manager| access(&mut manager.running))
}

pub(super) fn with_app_running_gateway<R, T, F>(app: &tauri::AppHandle<R>, access: F) -> T
where
    R: tauri::Runtime,
    F: FnOnce(Option<&GatewayRuntime>) -> T,
{
    let state = app.state::<ManagedCoreRuntimeState>();
    with_gateway_running(state.inner().as_ref(), access)
}

pub(super) fn with_app_running_gateway_slot_mut<R, T, F>(app: &tauri::AppHandle<R>, access: F) -> T
where
    R: tauri::Runtime,
    F: FnOnce(&mut Option<GatewayRuntime>) -> T,
{
    let state = app.state::<ManagedCoreRuntimeState>();
    with_gateway_running_slot_mut(state.inner().as_ref(), access)
}

pub(super) fn take_app_running_gateway<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Option<crate::gateway::runtime::GatewayRuntimeHandles> {
    let state = app.state::<ManagedCoreRuntimeState>();
    with_gateway_manager_mut(state.inner().as_ref(), GatewayManager::take_running)
}

pub(super) fn try_with_app_running_gateway<R, T, F>(
    app: &tauri::AppHandle<R>,
    access: F,
) -> Option<T>
where
    R: tauri::Runtime,
    F: FnOnce(Option<&GatewayRuntime>) -> T,
{
    app.try_state::<ManagedCoreRuntimeState>()
        .map(|state| with_gateway_running(state.inner().as_ref(), access))
}
