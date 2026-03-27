use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use lattice_core::{Device, DiscoveryEngine, DiscoveryResult, DiscoveryTree, Topology};
use tokio::sync::{broadcast, Mutex, RwLock};

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
    pub current_result: Arc<RwLock<Option<DiscoveryResult>>>,
    pub discovery_status: Arc<RwLock<DiscoveryStatus>>,
    pub tx: broadcast::Sender<DiscoveryEvent>,
}

#[derive(Debug, Clone, Copy)]
pub enum DiscoveryEvent {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy)]
enum DiscoveryTrigger {
    Initial,
    Manual,
}

impl DiscoveryCoordinator {
    pub fn new(runner: Arc<dyn DiscoveryRunner>) -> Self {
        let (tx, _) = broadcast::channel(32);
        Self {
            runner,
            discovery_lock: Arc::new(Mutex::new(())),
            current_result: Arc::new(RwLock::new(None)),
            discovery_status: Arc::new(RwLock::new(DiscoveryStatus::loading())),
            tx,
        }
    }

    pub fn start_initial_discovery(self: &Arc<Self>) {
        let _ = self.spawn_discovery(DiscoveryTrigger::Initial);
    }

    pub fn trigger_manual_discovery(self: &Arc<Self>) -> bool {
        self.spawn_discovery(DiscoveryTrigger::Manual)
    }

    pub async fn current_snapshot(&self) -> ViewSnapshot {
        let status = self.discovery_status.read().await.clone();
        let current_result = self.current_result.read().await.clone();

        if let Some(result) = current_result {
            build_view_snapshot(&result.topology, &result.tree, &status)
        } else {
            build_view_snapshot(&Topology::default(), &DiscoveryTree::default(), &status)
        }
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

    fn spawn_discovery(self: &Arc<Self>, trigger: DiscoveryTrigger) -> bool {
        let discovery_guard = match self.discovery_lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => return false,
        };

        let coordinator = Arc::clone(self);
        tokio::spawn(async move {
            {
                let mut status = coordinator.discovery_status.write().await;
                *status = match trigger {
                    DiscoveryTrigger::Initial => DiscoveryStatus::loading(),
                    DiscoveryTrigger::Manual => DiscoveryStatus::discovering(),
                };
            }

            match coordinator.runner.run_discovery().await {
                Ok(result) => {
                    *coordinator.current_result.write().await = Some(result);
                    *coordinator.discovery_status.write().await = DiscoveryStatus::ready();
                    let _ = coordinator.tx.send(DiscoveryEvent::Completed);
                }
                Err(error) => {
                    *coordinator.discovery_status.write().await =
                        DiscoveryStatus::failed(short_error_message(&error.to_string()));
                    let _ = coordinator.tx.send(DiscoveryEvent::Failed);
                }
            }

            drop(discovery_guard);
        });

        true
    }
}

fn short_error_message(message: &str) -> String {
    let first_line = message.lines().next().unwrap_or("Discovery failed");
    if first_line.len() > 160 {
        format!("{}...", &first_line[..157])
    } else {
        first_line.to_string()
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
            discovered_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn failure_keeps_previous_snapshot_and_marks_failed() {
        let runner = Arc::new(FakeRunner::new(vec![
            Ok(sample_result("first")),
            Err(anyhow!("boom")),
        ]));
        let coordinator = Arc::new(DiscoveryCoordinator::new(runner));
        let mut receiver = coordinator.subscribe();

        assert!(coordinator.trigger_manual_discovery());
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

        assert!(coordinator.trigger_manual_discovery());
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
    }
}
