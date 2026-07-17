use crate::PlatformResult;

pub trait AutostartService: Send + Sync {
    fn set_enabled(&self, enabled: bool) -> PlatformResult<()>;
}
