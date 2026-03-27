use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;

use crate::{
    collectors::CollectorContext,
    config::{DiscoveryConfig, SnmpSourceConfig},
    discovery::{DiscoverySource, DiscoveryTree, DiscoveryTreeNode, SourceResult},
    drivers::{detect_vendor, get_driver},
    graph::{DeploymentType, Device, DeviceRole, DeviceStatus, GraphStore},
    snmp::{oids, SnmpConfig, SnmpSession},
};

#[derive(Debug, Clone)]
pub struct SnmpDiscoverySource {
    discovery_config: DiscoveryConfig,
    source_config: SnmpSourceConfig,
}

impl SnmpDiscoverySource {
    pub fn new(discovery_config: DiscoveryConfig, source_config: SnmpSourceConfig) -> Self {
        Self {
            discovery_config,
            source_config,
        }
    }
}

#[async_trait]
impl DiscoverySource for SnmpDiscoverySource {
    fn kind(&self) -> &'static str {
        "snmp"
    }

    async fn discover(&self) -> Result<SourceResult> {
        let mut store = GraphStore::default();
        let mut tree = DiscoveryTree::default();
        let mut queue: VecDeque<QueueItem> = self
            .source_config
            .seeds
            .iter()
            .map(|seed| QueueItem {
                target_ip: seed.ip.clone(),
                seed_ip: seed.ip.clone(),
                seed_label: seed.label.clone(),
                parent_row_id: None,
                depth: 0,
            })
            .collect();
        let mut discovered_by_ip: HashMap<String, String> = HashMap::new();
        let mut row_occurrence: HashMap<String, usize> = HashMap::new();

        while let Some(item) = queue.pop_front() {
            if item.depth > self.discovery_config.max_hops {
                continue;
            }

            if let Some(device_id) = discovered_by_ip.get(&item.target_ip).cloned() {
                let row_id = next_row_id(
                    &mut row_occurrence,
                    item.parent_row_id.as_deref(),
                    &item.seed_ip,
                    &device_id,
                );
                tree.nodes.push(DiscoveryTreeNode {
                    row_id,
                    device_id,
                    parent_row_id: item.parent_row_id,
                    label: None,
                    depth: item.depth,
                });
                continue;
            }

            let session = SnmpSession::new(
                &item.target_ip,
                &SnmpConfig::new(
                    self.source_config.version.clone(),
                    self.source_config.community.clone(),
                    Duration::from_secs(self.discovery_config.timeout_seconds),
                    self.discovery_config.retries,
                ),
            );
            let sys_descr = match session.get(oids::SYS_DESCR).await {
                Ok(value) => value.as_text(),
                Err(_) => continue,
            };
            let sys_name = session
                .get(oids::SYS_NAME)
                .await
                .ok()
                .map(|value| value.as_text())
                .filter(|value| !value.is_empty());

            let mut local_device = Device::empty();
            local_device.identity_keys.sys_name = sys_name.or(Some(item.seed_label.clone()));
            local_device.identity_keys.mgmt_ip = Some(item.target_ip.clone());
            local_device.sys_descr = sys_descr.clone();
            local_device.vendor = detect_vendor(&sys_descr).to_string();
            local_device.device_role = infer_device_role(&sys_descr);
            local_device.deployment_type = DeploymentType::Unknown;
            local_device.status = DeviceStatus::Up;
            local_device.last_seen = Utc::now();

            let local_device_id = store.upsert_device(local_device);
            discovered_by_ip.insert(item.target_ip.clone(), local_device_id.clone());

            let row_id = next_row_id(
                &mut row_occurrence,
                item.parent_row_id.as_deref(),
                &item.seed_ip,
                &local_device_id,
            );
            tree.nodes.push(DiscoveryTreeNode {
                row_id: row_id.clone(),
                device_id: local_device_id.clone(),
                parent_row_id: item.parent_row_id.clone(),
                label: None,
                depth: item.depth,
            });

            let driver = get_driver(detect_vendor(&sys_descr));
            let ctx = CollectorContext {
                local_device_id: local_device_id.clone(),
                target_ip: item.target_ip.clone(),
                seed_ip: item.seed_ip.clone(),
                depth: item.depth,
            };
            let patch = match driver.collect(&session, &ctx).await {
                Ok(patch) => patch,
                Err(_) => continue,
            };

            for device in patch.devices.iter().cloned() {
                store.upsert_device(device);
            }

            for link in patch.observed_links {
                let _ = store.upsert_observed_link(link);
            }

            for device in patch.devices {
                if let Some(mgmt_ip) = device.identity_keys.mgmt_ip {
                    if mgmt_ip == item.target_ip {
                        continue;
                    }
                    queue.push_back(QueueItem {
                        target_ip: mgmt_ip,
                        seed_ip: item.seed_ip.clone(),
                        seed_label: item.seed_label.clone(),
                        parent_row_id: Some(row_id.clone()),
                        depth: item.depth + 1,
                    });
                }
            }
        }

        Ok(SourceResult {
            topology: store.topology(),
            tree,
        })
    }
}

#[derive(Debug, Clone)]
struct QueueItem {
    target_ip: String,
    seed_ip: String,
    seed_label: String,
    parent_row_id: Option<String>,
    depth: u32,
}

fn next_row_id(
    row_occurrence: &mut HashMap<String, usize>,
    parent_row_id: Option<&str>,
    seed_ip: &str,
    device_id: &str,
) -> String {
    let scope_key = parent_row_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("seed:{seed_ip}"));
    let duplicate_key = format!("{scope_key}::{device_id}");
    let occurrence = row_occurrence.entry(duplicate_key).or_insert(0);
    *occurrence += 1;

    if let Some(parent_row_id) = parent_row_id {
        format!("{parent_row_id}/{device_id}#{occurrence}")
    } else {
        format!("seed:{seed_ip}/{device_id}#{occurrence}")
    }
}

fn infer_device_role(sys_descr: &str) -> DeviceRole {
    let lowered = sys_descr.to_ascii_lowercase();
    if lowered.contains("router") || lowered.contains("vyos") {
        DeviceRole::Router
    } else if lowered.contains("switch") {
        DeviceRole::Switch
    } else if lowered.contains("proxmox") || lowered.contains("linux") || lowered.contains("server")
    {
        DeviceRole::Server
    } else {
        DeviceRole::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_seed_list_returns_empty_source_result() {
        let source = SnmpDiscoverySource::new(
            DiscoveryConfig {
                max_hops: 1,
                timeout_seconds: 1,
                retries: 0,
                concurrent_devices: 1,
            },
            SnmpSourceConfig {
                version: "2c".to_string(),
                community: "public".to_string(),
                seeds: Vec::new(),
            },
        );

        let result = source.discover().await.unwrap();

        assert_eq!(source.kind(), "snmp");
        assert!(result.topology.devices.is_empty());
        assert!(result.topology.links.is_empty());
        assert!(result.tree.nodes.is_empty());
    }

    #[test]
    fn infers_router_from_vyos() {
        assert_eq!(infer_device_role("VyOS 1.4 rolling"), DeviceRole::Router);
    }

    #[test]
    fn infers_switch_from_description() {
        assert_eq!(infer_device_role("Layer 2 Switch"), DeviceRole::Switch);
    }

    #[test]
    fn infers_physical_server_from_linux_text() {
        assert_eq!(
            infer_device_role("Linux 6.8.0-2-pve Proxmox VE"),
            DeviceRole::Server
        );
    }

    #[test]
    fn keeps_unknown_for_unrecognized_text() {
        assert_eq!(infer_device_role("appliance"), DeviceRole::Unknown);
    }
}
