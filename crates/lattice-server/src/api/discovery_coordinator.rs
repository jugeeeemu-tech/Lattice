use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use lattice_core::{
    Device, DiscoveryEngine, DiscoveryRelations, DiscoveryResult, DiscoveryTree, Topology,
};
use tokio::sync::OwnedMutexGuard;
use tokio::sync::{broadcast, Mutex, Notify, RwLock};
use tracing::{error, info, warn};

use crate::api::view_snapshot::{build_view_snapshot, DiscoveryStatus, ViewSnapshot};

#[async_trait]
pub trait DiscoveryRunner: Send + Sync {
    async fn run_discovery(&self) -> Result<DiscoveryResult>;
}

#[async_trait]
impl DiscoveryRunner for DiscoveryEngine {
    async fn run_discovery(&self) -> Result<DiscoveryResult> {
        self.discover().await
    }
}

pub struct DiscoveryCoordinator {
    runner: Arc<dyn DiscoveryRunner>,
    discovery_lock: Arc<Mutex<()>>,
    auto_discovery_interval: Duration,
    auto_discovery_interval_seconds: u64,
    manual_discovery_cooldown: Duration,
    last_manual_discovery_started_at: Arc<RwLock<Option<Instant>>>,
    pub current_result: Arc<RwLock<Option<DiscoveryResult>>>,
    pub discovery_status: Arc<RwLock<DiscoveryStatus>>,
    next_auto_discovery_at: Arc<RwLock<Option<DateTime<Utc>>>>,
    cached_snapshot: Arc<RwLock<ViewSnapshot>>,
    schedule_notify: Arc<Notify>,
    scheduler_started: AtomicBool,
    discovery_running: AtomicBool,
    pub tx: broadcast::Sender<DiscoveryEvent>,
}

#[derive(Debug, Clone, Copy)]
pub enum DiscoveryEvent {
    Started,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManualDiscoveryRequest {
    Started,
    Busy,
    Cooldown { retry_after_seconds: u64 },
}

#[derive(Debug, Clone, Copy)]
enum DiscoveryTrigger {
    Initial,
    Manual,
    Automatic,
}

impl DiscoveryTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Manual => "manual",
            Self::Automatic => "automatic",
        }
    }
}

impl DiscoveryCoordinator {
    pub fn new(
        runner: Arc<dyn DiscoveryRunner>,
        auto_discovery_interval_seconds: u64,
        manual_discovery_cooldown_seconds: u64,
    ) -> Self {
        let (tx, _) = broadcast::channel(32);
        let normalized_interval_seconds = auto_discovery_interval_seconds.max(1);
        Self {
            runner,
            discovery_lock: Arc::new(Mutex::new(())),
            auto_discovery_interval: Duration::from_secs(normalized_interval_seconds),
            auto_discovery_interval_seconds: normalized_interval_seconds,
            manual_discovery_cooldown: Duration::from_secs(manual_discovery_cooldown_seconds),
            last_manual_discovery_started_at: Arc::new(RwLock::new(None)),
            current_result: Arc::new(RwLock::new(None)),
            discovery_status: Arc::new(RwLock::new(DiscoveryStatus::loading())),
            next_auto_discovery_at: Arc::new(RwLock::new(None)),
            cached_snapshot: Arc::new(RwLock::new(ViewSnapshot::empty(
                DiscoveryStatus::loading(),
                normalized_interval_seconds,
                None,
            ))),
            schedule_notify: Arc::new(Notify::new()),
            scheduler_started: AtomicBool::new(false),
            discovery_running: AtomicBool::new(false),
            tx,
        }
    }

    pub fn start(self: &Arc<Self>) {
        self.start_auto_discovery_scheduler();
        self.start_initial_discovery();
    }

    pub fn start_initial_discovery(self: &Arc<Self>) {
        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            let _ = coordinator
                .try_start_discovery(DiscoveryTrigger::Initial)
                .await;
        });
    }

    pub fn start_auto_discovery_scheduler(self: &Arc<Self>) {
        if self.scheduler_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            coordinator.run_auto_discovery_scheduler().await;
        });
    }

    pub async fn trigger_manual_discovery(
        self: &Arc<Self>,
    ) -> (ManualDiscoveryRequest, Option<ViewSnapshot>) {
        if self.discovery_running.load(Ordering::SeqCst) {
            return (ManualDiscoveryRequest::Busy, None);
        }

        if let Some(retry_after_seconds) = self.manual_discovery_retry_after().await {
            return (
                ManualDiscoveryRequest::Cooldown {
                    retry_after_seconds,
                },
                None,
            );
        }

        match self.try_start_discovery(DiscoveryTrigger::Manual).await {
            Some(snapshot) => (ManualDiscoveryRequest::Started, Some(snapshot)),
            None => (ManualDiscoveryRequest::Busy, None),
        }
    }

    pub async fn current_snapshot(&self) -> ViewSnapshot {
        self.cached_snapshot.read().await.clone()
    }

    pub async fn current_devices(&self) -> Vec<Device> {
        let mut devices = self
            .current_result
            .read()
            .await
            .as_ref()
            .map(|result| {
                result
                    .topology
                    .devices
                    .values()
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        devices.sort_by(|left, right| {
            left.label()
                .cmp(&right.label())
                .then_with(|| left.id.cmp(&right.id))
        });
        devices
    }

    pub fn subscribe(&self) -> broadcast::Receiver<DiscoveryEvent> {
        self.tx.subscribe()
    }

    async fn try_start_discovery(
        self: &Arc<Self>,
        trigger: DiscoveryTrigger,
    ) -> Option<ViewSnapshot> {
        let discovery_guard = match self.discovery_lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                warn!(
                    trigger = trigger.as_str(),
                    "discovery start skipped because another run is active"
                );
                return None;
            }
        };

        self.pause_auto_discovery().await;
        self.discovery_running.store(true, Ordering::SeqCst);
        if matches!(trigger, DiscoveryTrigger::Manual) {
            *self.last_manual_discovery_started_at.write().await = Some(Instant::now());
        }
        {
            let mut status = self.discovery_status.write().await;
            *status = match trigger {
                DiscoveryTrigger::Initial => DiscoveryStatus::loading(),
                DiscoveryTrigger::Manual | DiscoveryTrigger::Automatic => {
                    DiscoveryStatus::discovering()
                }
            };
        }
        self.refresh_cached_snapshot().await;
        let snapshot = self.current_snapshot().await;
        info!(trigger = trigger.as_str(), "discovery started");
        let _ = self.tx.send(DiscoveryEvent::Started);

        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            coordinator
                .run_discovery_task(trigger, discovery_guard)
                .await;
        });

        Some(snapshot)
    }

    async fn run_discovery_task(
        self: Arc<Self>,
        trigger: DiscoveryTrigger,
        discovery_guard: OwnedMutexGuard<()>,
    ) {
        let started_at = Instant::now();

        match self.runner.run_discovery().await {
            Ok(result) => {
                let device_count = result.topology.devices.len();
                let link_count = result.topology.links.len();
                let warning_message = warning_summary(&result.warnings);
                *self.current_result.write().await = Some(result);
                *self.discovery_status.write().await = match warning_message.as_ref() {
                    Some(message) => DiscoveryStatus::partial(message.clone()),
                    None => DiscoveryStatus::ready(),
                };
                self.schedule_next_auto_discovery().await;
                self.refresh_cached_snapshot().await;
                info!(
                    trigger = trigger.as_str(),
                    duration_ms = started_at.elapsed().as_millis(),
                    device_count,
                    link_count,
                    warning = warning_message.as_deref().unwrap_or(""),
                    "discovery completed"
                );
                let _ = self.tx.send(DiscoveryEvent::Completed);
            }
            Err(error) => {
                let message = short_error_message(&error.to_string());
                *self.discovery_status.write().await = DiscoveryStatus::failed(message.clone());
                self.schedule_next_auto_discovery().await;
                self.refresh_cached_snapshot().await;
                error!(
                    trigger = trigger.as_str(),
                    duration_ms = started_at.elapsed().as_millis(),
                    error_message = %message,
                    error = %error,
                    "discovery failed"
                );
                let _ = self.tx.send(DiscoveryEvent::Failed);
            }
        }

        self.discovery_running.store(false, Ordering::SeqCst);
        drop(discovery_guard);
    }

    async fn run_auto_discovery_scheduler(self: Arc<Self>) {
        loop {
            let next_due = *self.next_auto_discovery_at.read().await;

            match next_due {
                Some(next_due) => {
                    let delay = next_due
                        .signed_duration_since(Utc::now())
                        .to_std()
                        .unwrap_or(Duration::ZERO);
                    let sleep = tokio::time::sleep(delay);
                    tokio::pin!(sleep);

                    tokio::select! {
                        _ = &mut sleep => {
                            let should_run = self
                                .next_auto_discovery_at
                                .read()
                                .await
                                .as_ref()
                                .is_some_and(|scheduled| *scheduled <= Utc::now());
                            if should_run {
                                let _ = self.try_start_discovery(DiscoveryTrigger::Automatic).await;
                            }
                        }
                        _ = self.schedule_notify.notified() => {}
                    }
                }
                None => {
                    self.schedule_notify.notified().await;
                }
            }
        }
    }

    async fn pause_auto_discovery(&self) {
        *self.next_auto_discovery_at.write().await = None;
        self.refresh_cached_snapshot().await;
        self.schedule_notify.notify_waiters();
    }

    async fn schedule_next_auto_discovery(&self) {
        let next_due = Utc::now()
            + chrono::Duration::from_std(self.auto_discovery_interval).unwrap_or_else(|_| {
                chrono::Duration::seconds(self.auto_discovery_interval_seconds as i64)
            });
        *self.next_auto_discovery_at.write().await = Some(next_due);
        self.refresh_cached_snapshot().await;
        self.schedule_notify.notify_waiters();
    }

    async fn manual_discovery_retry_after(&self) -> Option<u64> {
        if self.manual_discovery_cooldown.is_zero() {
            return None;
        }

        let last_started_at = *self.last_manual_discovery_started_at.read().await;
        let elapsed = last_started_at?.elapsed();
        if elapsed >= self.manual_discovery_cooldown {
            return None;
        }

        let remaining = self.manual_discovery_cooldown.saturating_sub(elapsed);
        let seconds = remaining.as_secs();
        Some(seconds.max(1))
    }

    async fn refresh_cached_snapshot(&self) {
        let status = self.discovery_status.read().await.clone();
        let current_result = self.current_result.read().await.clone();
        let next_auto_discovery_at_ms = self
            .next_auto_discovery_at
            .read()
            .await
            .as_ref()
            .map(DateTime::<Utc>::timestamp_millis);

        let snapshot = if let Some(result) = current_result {
            build_view_snapshot(
                &result.topology,
                &result.tree,
                &result.relations,
                &status,
                self.auto_discovery_interval_seconds,
                next_auto_discovery_at_ms,
            )
        } else {
            build_view_snapshot(
                &Topology::default(),
                &DiscoveryTree::default(),
                &DiscoveryRelations::default(),
                &status,
                self.auto_discovery_interval_seconds,
                next_auto_discovery_at_ms,
            )
        };

        *self.cached_snapshot.write().await = snapshot;
    }
}

fn short_error_message(message: &str) -> String {
    let first_line = message.lines().next().unwrap_or("Discovery failed");
    let first_line_chars = first_line.chars().count();
    if first_line_chars > 160 {
        let prefix = first_line.chars().take(157).collect::<String>();
        format!("{prefix}...")
    } else {
        first_line.to_string()
    }
}

fn warning_summary(warnings: &[String]) -> Option<String> {
    if warnings.is_empty() {
        return None;
    }

    let first = short_error_message(&warnings[0]);
    if warnings.len() == 1 {
        Some(format!("一部の探索に失敗しました: {first}"))
    } else {
        Some(format!(
            "一部の探索に失敗しました: {first} / ほか {} 件",
            warnings.len() - 1
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{HashMap, VecDeque},
        sync::Arc,
    };

    use anyhow::{anyhow, Result};
    use chrono::{TimeZone, Utc};
    use lattice_core::{
        DeploymentType, Device, DeviceRole, DeviceStatus, DiscoveryTreeNode, IdentityKeys,
        Interface, Link, LinkProtocol, OperStatus,
    };
    use tokio::sync::Mutex;
    use tokio::time::timeout;

    use super::*;

    #[derive(Clone)]
    struct FakeRunner {
        results: Arc<Mutex<VecDeque<Result<DiscoveryResult>>>>,
    }

    impl FakeRunner {
        fn new(results: Vec<Result<DiscoveryResult>>) -> Self {
            Self {
                results: Arc::new(Mutex::new(results.into())),
            }
        }
    }

    #[async_trait]
    impl DiscoveryRunner for FakeRunner {
        async fn run_discovery(&self) -> Result<DiscoveryResult> {
            self.results
                .lock()
                .await
                .pop_front()
                .unwrap_or_else(|| Err(anyhow!("no scripted result left")))
        }
    }

    #[derive(Clone)]
    struct BlockingRunner {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        result: DiscoveryResult,
    }

    #[async_trait]
    impl DiscoveryRunner for BlockingRunner {
        async fn run_discovery(&self) -> Result<DiscoveryResult> {
            self.entered.notify_waiters();
            self.release.notified().await;
            Ok(self.result.clone())
        }
    }

    fn sample_result(label: &str) -> DiscoveryResult {
        let device = Device {
            id: format!("device-{label}"),
            identity_keys: IdentityKeys {
                chassis_id: None,
                sys_name: Some(label.to_string()),
                mgmt_ip: Some("192.0.2.10".to_string()),
                mac_addresses: Vec::new(),
            },
            sys_descr: label.to_string(),
            vendor: "test".to_string(),
            model: None,
            device_role: DeviceRole::Router,
            deployment_type: DeploymentType::Unknown,
            guest_kind: None,
            interfaces: vec![Interface {
                if_index: 1,
                if_name: "eth0".to_string(),
                ip_addresses: vec!["192.0.2.10/24".to_string()],
                speed_bps: None,
                oper_status: OperStatus::Up,
            }],
            status: DeviceStatus::Up,
            host_label: None,
            host_mgmt_ip: None,
            upstream_interface: None,
            default_gateway_ip: None,
            default_upstream_device_id: None,
            last_seen: Utc.with_ymd_and_hms(2026, 3, 27, 0, 0, 0).unwrap(),
        };

        DiscoveryResult {
            topology: Topology {
                devices: HashMap::from([(device.id.clone(), device)]),
                links: vec![Link {
                    id: "link-1".to_string(),
                    local_device_id: format!("device-{label}"),
                    local_interface: "eth0".to_string(),
                    local_ip: Some("192.0.2.10/24".to_string()),
                    remote_device_id: "device-other".to_string(),
                    remote_interface: "eth1".to_string(),
                    remote_ip: None,
                    speed_bps: None,
                    protocol: LinkProtocol::Lldp,
                    guest_attachment: None,
                }],
                updated_at: Utc::now(),
            },
            tree: DiscoveryTree {
                nodes: vec![DiscoveryTreeNode {
                    row_id: format!("seed:192.0.2.10/device-{label}#1"),
                    device_id: format!("device-{label}"),
                    parent_row_id: None,
                    label: Some(label.to_string()),
                    depth: 0,
                }],
            },
            relations: DiscoveryRelations::default(),
            warnings: Vec::new(),
            discovered_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn failure_keeps_previous_snapshot_and_marks_failed() {
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(sample_result("first")),
            Err(anyhow!("boom")),
        ]));
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner, 60, 0));
        let mut receiver = coordinator.subscribe();

        assert_eq!(
            coordinator.trigger_manual_discovery().await.0,
            ManualDiscoveryRequest::Started
        );
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Completed
        ));

        let first = coordinator.current_snapshot().await;
        assert_eq!(first.devices.len(), 1);
        assert_eq!(
            first.discovery_status.state,
            crate::api::view_snapshot::DiscoveryState::Ready
        );

        assert_eq!(
            coordinator.trigger_manual_discovery().await.0,
            ManualDiscoveryRequest::Started
        );
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Failed
        ));

        let second = coordinator.current_snapshot().await;
        assert_eq!(second.devices.len(), 1);
        assert_eq!(second.devices[0].label, "first");
        assert_eq!(
            second.discovery_status.state,
            crate::api::view_snapshot::DiscoveryState::Failed
        );
        assert_eq!(second.auto_discovery_interval_seconds, 60);
        assert!(second.next_auto_discovery_at_ms.is_some());
    }

    #[tokio::test]
    async fn warnings_mark_snapshot_as_partial_but_keep_latest_result() {
        let mut partial = sample_result("partial");
        partial.warnings = vec!["snmp: timed out".to_string()];
        let runner = Arc::new(FakeRunner::new(vec![Ok(partial)]));
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner, 60, 0));
        let mut receiver = coordinator.subscribe();

        assert_eq!(
            coordinator.trigger_manual_discovery().await.0,
            ManualDiscoveryRequest::Started
        );
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Completed
        ));

        let snapshot = coordinator.current_snapshot().await;
        assert_eq!(snapshot.devices.len(), 1);
        assert_eq!(
            snapshot.discovery_status.state,
            crate::api::view_snapshot::DiscoveryState::Partial
        );
        assert!(snapshot
            .discovery_status
            .message
            .as_deref()
            .is_some_and(|message| message.contains("一部の探索に失敗しました")));
    }

    #[tokio::test]
    async fn scheduler_restarts_after_completion_and_manual_runs_reset_it() {
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(sample_result("initial")),
            Ok(sample_result("automatic")),
            Ok(sample_result("manual")),
            Ok(sample_result("next-automatic")),
        ]));
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner, 1, 0));
        let mut receiver = coordinator.subscribe();

        coordinator.start();
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Completed
        ));

        let initial_snapshot = coordinator.current_snapshot().await;
        let initial_next_due = initial_snapshot.next_auto_discovery_at_ms.unwrap();

        assert!(matches!(
            timeout(Duration::from_secs(2), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Completed
        ));

        let automatic_snapshot = coordinator.current_snapshot().await;
        assert_eq!(
            automatic_snapshot
                .devices
                .first()
                .map(|device| device.label.as_str()),
            Some("automatic")
        );

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            coordinator.trigger_manual_discovery().await.0,
            ManualDiscoveryRequest::Started
        );
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Completed
        ));

        let manual_snapshot = coordinator.current_snapshot().await;
        let manual_next_due = manual_snapshot.next_auto_discovery_at_ms.unwrap();
        assert!(manual_next_due > initial_next_due);
        assert_eq!(
            manual_snapshot
                .devices
                .first()
                .map(|device| device.label.as_str()),
            Some("manual")
        );

        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(receiver.try_recv().is_err());

        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Completed
        ));
    }

    #[tokio::test]
    async fn manual_discovery_returns_busy_when_another_run_is_active() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runner = Arc::new(BlockingRunner {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            result: sample_result("blocking"),
        });
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner, 60, 0));
        let mut receiver = coordinator.subscribe();

        let (request, started_snapshot) = coordinator.trigger_manual_discovery().await;
        assert_eq!(request, ManualDiscoveryRequest::Started);
        let started_snapshot = started_snapshot.expect("manual discovery should start");
        assert_eq!(
            started_snapshot.discovery_status.state,
            crate::api::view_snapshot::DiscoveryState::Discovering
        );
        assert!(started_snapshot.next_auto_discovery_at_ms.is_none());
        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Started
        ));

        timeout(Duration::from_secs(1), entered.notified())
            .await
            .expect("runner should enter discovery");

        assert_eq!(
            coordinator.trigger_manual_discovery().await,
            (ManualDiscoveryRequest::Busy, None)
        );

        release.notify_waiters();

        assert!(matches!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap(),
            DiscoveryEvent::Completed
        ));
    }

    #[tokio::test]
    async fn manual_discovery_enforces_cooldown_after_completion() {
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(sample_result("first")),
            Ok(sample_result("second")),
        ]));
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner, 60, 10));
        let mut receiver = coordinator.subscribe();

        assert_eq!(
            coordinator.trigger_manual_discovery().await.0,
            ManualDiscoveryRequest::Started
        );
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Started
        ));
        assert!(matches!(
            receiver.recv().await.unwrap(),
            DiscoveryEvent::Completed
        ));

        let (request, snapshot) = coordinator.trigger_manual_discovery().await;
        let ManualDiscoveryRequest::Cooldown {
            retry_after_seconds,
        } = request
        else {
            panic!("manual discovery should be rate limited");
        };
        assert!((9..=10).contains(&retry_after_seconds));
        assert!(snapshot.is_none());
    }

    #[test]
    fn short_error_message_truncates_multibyte_text_without_panicking() {
        let message = "あ".repeat(200);
        let shortened = short_error_message(&message);

        assert!(shortened.ends_with("..."));
        assert_eq!(shortened.chars().count(), 160);
    }
}
